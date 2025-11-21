import asyncio
from typing import Dict, Set, Optional
from datetime import datetime
import logging

from backend.models.schemas import Job, JobStatus, WorkflowStatus
from backend.models.storage import storage
from backend.config import settings

logger = logging.getLogger(__name__)


class BranchAwareScheduler:
    """
    FIFO, max_workers concurrent jobs, branch-aware scheduling
    """
    
    def __init__(self, max_workers: int = None):
        self.max_workers = max_workers or settings.MAX_WORKERS
        
        self.worker_semaphore = asyncio.Semaphore(self.max_workers)
        # branchId -> lock      
        self.branch_locks: Dict[str, asyncio.Lock] = {}
        
        self.running_jobs: Set[str] = set()
    
        self.job_executor = None
        
        logger.info(f"Scheduler initialized with {self.max_workers} workers")
    
    def _get_branch_key(self, workflow_id: str, branch_id: str) -> str:
        return f"{workflow_id}:{branch_id}"
    
    def _get_branch_lock(self, workflow_id: str, branch_id: str) -> asyncio.Lock:
        key = self._get_branch_key(workflow_id, branch_id)
        if key not in self.branch_locks:
            self.branch_locks[key] = asyncio.Lock()
        return self.branch_locks[key]
    
    async def schedule_job(self, job: Job):
        """
        get branch lock, wait worker slot, execute job, release resources
        """
        job_id = job.id
        branch_lock = self._get_branch_lock(job.workflow_id, job.branch_id)
        
        # serialize execution within the same branch
        async with branch_lock:
            logger.info(f"Job {job_id} acquired branch lock")
            # get job
            updated_job = await storage.get_job(job_id)
            if updated_job.status == JobStatus.CANCELLED:
                logger.info(f"Job {job_id} was cancelled, skipping")
                return
            
            # wait for worker 
            logger.info(f"Job {job_id} waiting for worker slot ({len(self.running_jobs)}/{self.max_workers} busy)")
            async with self.worker_semaphore:
                logger.info(f"Job {job_id} acquired worker slot, starting execution")
                
                # running
                self.running_jobs.add(job_id)
                await storage.update_job(
                    job_id,
                    status=JobStatus.RUNNING,
                    started_at=datetime.utcnow()
                )
                
                try:
                    # run job
                    if self.job_executor:
                        await self.job_executor.execute(job)
                        # Job executor already marks job as SUCCEEDED with output_path
                    else:
                        # for testing
                        logger.warning(f"Job executor not set, simulating job {job_id}")
                        await self._simulate_job(job)
                        await storage.update_job(
                            job_id,
                            status=JobStatus.SUCCEEDED,
                            progress_percent=100.0,
                            completed_at=datetime.utcnow()
                        )
                    logger.info(f"Job {job_id} completed successfully")
                    
                except Exception as e:
                    # fail
                    logger.error(f"Job {job_id} failed: {str(e)}")
                    await storage.update_job(
                        job_id,
                        status=JobStatus.FAILED,
                        error_message=str(e),
                        completed_at=datetime.utcnow()
                    )
                
                finally:
                    # clean
                    self.running_jobs.discard(job_id)
                    
                    await self._update_workflow_progress(job.workflow_id)
    
    async def _simulate_job(self, job: Job):
        """for testing"""
        total_steps = 10
        for i in range(total_steps):
            await asyncio.sleep(0.5) 
            progress = (i + 1) / total_steps * 100
            await storage.update_job(
                job.id,
                progress_percent=progress,
                tiles_processed=i + 1,
                tiles_total=total_steps
            )
    
    async def _update_workflow_progress(self, workflow_id: str):
        """update workflow progress"""
        workflow = await storage.get_workflow(workflow_id)
        if not workflow:
            logger.warning(f"Workflow {workflow_id} not found for progress update")
            return
        
        jobs = await storage.get_workflow_jobs(workflow_id)
        
        completed = sum(1 for j in jobs if j.status == JobStatus.SUCCEEDED)
        failed = sum(1 for j in jobs if j.status == JobStatus.FAILED)
        total = len(jobs)
        
        if completed + failed == total:
            if failed > 0:
                status = WorkflowStatus.FAILED
            else:
                status = WorkflowStatus.SUCCEEDED
        elif completed > 0 or any(j.status == JobStatus.RUNNING for j in jobs):
            status = WorkflowStatus.RUNNING
        else:
            status = WorkflowStatus.PENDING
        
        await storage.update_workflow(
            workflow_id,
            completed_jobs=completed,
            failed_jobs=failed,
            status=status,
            completed_at=datetime.utcnow() if status in [WorkflowStatus.SUCCEEDED, WorkflowStatus.FAILED] else None
        )
        
        logger.debug(f"Updated workflow {workflow_id}: {completed}/{total} jobs completed, status={status}")
    
    async def cancel_job(self, job_id: str) -> bool:
        
        job = await storage.get_job(job_id)
        if not job:
            return False
        
        # only cancel pending jobs
        if job.status != JobStatus.PENDING:
            logger.warning(f"Cannot cancel job {job_id} with status {job.status}")
            return False
        
        await storage.update_job(job_id, status=JobStatus.CANCELLED)
        logger.info(f"Job {job_id} cancelled")
        
        await self._update_workflow_progress(job.workflow_id)
        return True
    
    def set_executor(self, executor):
        self.job_executor = executor
        logger.info("Job executor set")


scheduler = BranchAwareScheduler()