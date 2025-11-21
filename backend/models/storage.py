# backend/models/storage.py
from typing import Dict, List, Optional
from .schemas import Job, Workflow, JobStatus, WorkflowStatus
import asyncio


class InMemoryStorage:
    
    def __init__(self):
        self.workflows: Dict[str, Workflow] = {}
        self.jobs: Dict[str, Job] = {}
        self.user_workflows: Dict[str, List[str]] = {}  # user_id -> [workflow_ids]
        self._lock = asyncio.Lock()
    
    # ============== Workflow Operations ==============
    
    async def create_workflow(self, workflow: Workflow) -> Workflow:
        async with self._lock:
            self.workflows[workflow.id] = workflow
            
            if workflow.user_id not in self.user_workflows:
                self.user_workflows[workflow.user_id] = []
            self.user_workflows[workflow.user_id].append(workflow.id)
            
            return workflow
    
    async def get_workflow(self, workflow_id: str) -> Optional[Workflow]:
        return self.workflows.get(workflow_id)
    
    async def get_user_workflows(self, user_id: str) -> List[Workflow]:
        workflow_ids = self.user_workflows.get(user_id, [])
        return [self.workflows[wid] for wid in workflow_ids if wid in self.workflows]
    
    async def update_workflow(self, workflow_id: str, **kwargs) -> Optional[Workflow]:
        async with self._lock:
            workflow = self.workflows.get(workflow_id)
            if not workflow:
                return None
            
            for key, value in kwargs.items():
                if hasattr(workflow, key):
                    setattr(workflow, key, value)
            
            return workflow
    
    # ============== Job Operations ==============
    
    async def create_job(self, job: Job) -> Job:
        async with self._lock:
            self.jobs[job.id] = job
            return job
    
    async def get_job(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)
    
    async def get_workflow_jobs(self, workflow_id: str) -> List[Job]:
        return [job for job in self.jobs.values() if job.workflow_id == workflow_id]
    
    async def get_branch_jobs(self, workflow_id: str, branch_id: str) -> List[Job]:
        return [
            job for job in self.jobs.values()
            if job.workflow_id == workflow_id and job.branch_id == branch_id
        ]
    
    async def update_job(self, job_id: str, **kwargs) -> Optional[Job]:
        async with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                return None
            
            for key, value in kwargs.items():
                if hasattr(job, key):
                    setattr(job, key, value)
            
            return job
    
    async def get_pending_jobs_for_user(self, user_id: str) -> List[Job]:
        return [
            job for job in self.jobs.values()
            if job.user_id == user_id and job.status == JobStatus.PENDING
        ]
    
    async def get_running_jobs_for_user(self, user_id: str) -> List[Job]:
        return [
            job for job in self.jobs.values()
            if job.user_id == user_id and job.status == JobStatus.RUNNING
        ]


storage = InMemoryStorage()