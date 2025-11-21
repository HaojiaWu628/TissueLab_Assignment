# backend/api/routes.py
from fastapi import APIRouter, Header, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from typing import Optional, List
import logging
import asyncio

from backend.models.schemas import (
    WorkflowCreate, WorkflowResponse, Workflow, WorkflowDAG,
    Job, JobResponse, JobStatus, JobType, JobConfig,
    ProgressUpdate, WorkflowProgressUpdate
)
from backend.models.storage import storage
from backend.core.scheduler import scheduler
from backend.core.tenant_manager import tenant_manager
from backend.workers.job_executor import job_executor
from backend.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


# ============== WebSocket Connection Management ==============

class ConnectionManager:
    """WebSocket connection manager"""
    
    def __init__(self):
        # job_id -> List[WebSocket]
        self.active_connections: dict[str, List[WebSocket]] = {}
        # workflow_id -> List[WebSocket]
        self.workflow_connections: dict[str, List[WebSocket]] = {}
    
    async def connect_job(self, job_id: str, websocket: WebSocket):
        await websocket.accept()
        if job_id not in self.active_connections:
            self.active_connections[job_id] = []
        self.active_connections[job_id].append(websocket)
        logger.info(f"WebSocket connected for job {job_id}")
    
    async def connect_workflow(self, workflow_id: str, websocket: WebSocket):
        await websocket.accept()
        if workflow_id not in self.workflow_connections:
            self.workflow_connections[workflow_id] = []
        self.workflow_connections[workflow_id].append(websocket)
        logger.info(f"WebSocket connected for workflow {workflow_id}")
    
    def disconnect_job(self, job_id: str, websocket: WebSocket):
        if job_id in self.active_connections:
            self.active_connections[job_id].remove(websocket)
            if not self.active_connections[job_id]:
                del self.active_connections[job_id]
    
    def disconnect_workflow(self, workflow_id: str, websocket: WebSocket):
        if workflow_id in self.workflow_connections:
            self.workflow_connections[workflow_id].remove(websocket)
            if not self.workflow_connections[workflow_id]:
                del self.workflow_connections[workflow_id]
    
    async def broadcast_job_progress(self, job: Job):
        """Broadcast job progress"""
        if job.id not in self.active_connections:
            return
        
        message = ProgressUpdate(
            job_id=job.id,
            workflow_id=job.workflow_id,
            status=job.status,
            progress_percent=job.progress_percent,
            tiles_processed=job.tiles_processed,
            tiles_total=job.tiles_total
        )
        
        disconnected = []
        for websocket in self.active_connections[job.id]:
            try:
                await websocket.send_json(message.model_dump())
            except Exception as e:
                logger.error(f"Error sending to websocket: {e}")
                disconnected.append(websocket)
        
        # Clean up disconnected connections
        for ws in disconnected:
            self.disconnect_job(job.id, ws)
    
    async def broadcast_workflow_progress(self, workflow_id: str):
        """Broadcast workflow progress"""
        if workflow_id not in self.workflow_connections:
            return
        
        workflow = await storage.get_workflow(workflow_id)
        if not workflow:
            return
        
        # Calculate progress as average of all job progress
        progress = await calculate_workflow_progress(workflow_id)
        
        message = WorkflowProgressUpdate(
            workflow_id=workflow_id,
            status=workflow.status,
            completed_jobs=workflow.completed_jobs,
            failed_jobs=workflow.failed_jobs,
            total_jobs=workflow.total_jobs,
            progress_percent=progress
        )
        
        disconnected = []
        for websocket in self.workflow_connections[workflow_id]:
            try:
                await websocket.send_json(message.model_dump())
            except Exception:
                disconnected.append(websocket)
        
        for ws in disconnected:
            self.disconnect_workflow(workflow_id, ws)


manager = ConnectionManager()


# Helper function to calculate workflow progress
async def calculate_workflow_progress(workflow_id: str) -> float:
    """
    Calculate workflow progress as average of all job progress
    
    Returns progress as percentage (0-100)
    """
    jobs = await storage.get_workflow_jobs(workflow_id)
    if not jobs:
        return 0.0
    
    total_progress = sum(job.progress_percent for job in jobs)
    avg_progress = total_progress / len(jobs)
    return avg_progress


# Setup progress callback
async def progress_callback(job: Job):
    """Progress update callback"""
    logger.debug(f"Progress callback for job {job.id}: {job.progress_percent:.1f}%")
    await manager.broadcast_job_progress(job)
    await manager.broadcast_workflow_progress(job.workflow_id)
    logger.debug(f"Broadcasted progress for workflow {job.workflow_id}")

job_executor.set_progress_callback(progress_callback)


# ============== Workflow APIs ==============

@router.post("/workflows", response_model=WorkflowResponse)
async def create_workflow(
    workflow_data: WorkflowCreate,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """
    Create a new workflow
    
    Automatically create all jobs and start scheduling
    """
    logger.info(f"Creating workflow for user {x_user_id}: {workflow_data.name}")
    
    # Create workflow
    workflow = Workflow(
        user_id=x_user_id,
        name=workflow_data.name,
        dag=workflow_data.dag
    )
    
    # Calculate total job count
    total_jobs = sum(len(jobs) for jobs in workflow_data.dag.branches.values())
    workflow.total_jobs = total_jobs
    
    await storage.create_workflow(workflow)
    logger.info(f"Workflow {workflow.id} created with {total_jobs} jobs")
    
    # Create all jobs
    all_jobs = []
    for branch_id, job_configs in workflow_data.dag.branches.items():
        for job_config in job_configs:
            job = Job(
                workflow_id=workflow.id,
                branch_id=branch_id,
                user_id=x_user_id,
                type=job_config.type,
                input_image_path=job_config.input_image_path,
                params=job_config.params
            )
            await storage.create_job(job)
            all_jobs.append(job)
            logger.debug(f"Created job {job.id} in branch {branch_id}")
    
    # Start scheduling (async)
    asyncio.create_task(schedule_workflow(workflow.id, all_jobs))
    
    return WorkflowResponse(
        id=workflow.id,
        name=workflow.name,
        status=workflow.status,
        total_jobs=workflow.total_jobs,
        completed_jobs=workflow.completed_jobs,
        failed_jobs=workflow.failed_jobs,
        progress_percent=0,
        created_at=workflow.created_at
    )


async def schedule_workflow(workflow_id: str, jobs: List[Job]):
    """
    Schedule all jobs in a workflow
    
    Group by branch, start a scheduling coroutine for each branch
    """
    logger.info(f"Starting workflow {workflow_id} scheduling")
    
    # Group by branch
    branches = {}
    for job in jobs:
        if job.branch_id not in branches:
            branches[job.branch_id] = []
        branches[job.branch_id].append(job)
    
    # Acquire user slot
    user_id = jobs[0].user_id
    logger.info(f"User {user_id} requesting slot for workflow {workflow_id}")
    await tenant_manager.acquire_user_slot(user_id)
    
    try:
        # Update workflow status
        await storage.update_workflow(workflow_id, status="RUNNING")
        
        # Start scheduling for each branch
        tasks = []
        for branch_id, branch_jobs in branches.items():
            logger.info(f"Scheduling {len(branch_jobs)} jobs for branch {branch_id}")
            task = asyncio.create_task(schedule_branch(branch_jobs))
            tasks.append(task)
        
        # Wait for all branches to complete
        await asyncio.gather(*tasks)
        
        logger.info(f"Workflow {workflow_id} completed")
    
    finally:
        # Release user slot
        await tenant_manager.register_job_end(user_id)


async def schedule_branch(jobs: List[Job]):
    """Schedule all jobs in a single branch (serial execution)"""
    user_id = jobs[0].user_id
    
    for job in jobs:
        # Register job start
        await tenant_manager.register_job_start(user_id)
        
        try:
            # Schedule job (will wait for completion)
            await scheduler.schedule_job(job)
        finally:
            # Register job end
            await tenant_manager.register_job_end(user_id)


@router.get("/workflows", response_model=List[WorkflowResponse])
async def list_workflows(
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Get all workflows for a user"""
    workflows = await storage.get_user_workflows(x_user_id)
    
    responses = []
    for wf in workflows:
        # Calculate progress as average of all job progress
        progress = await calculate_workflow_progress(wf.id)
        
        responses.append(WorkflowResponse(
            id=wf.id,
            name=wf.name,
            status=wf.status,
            total_jobs=wf.total_jobs,
            completed_jobs=wf.completed_jobs,
            failed_jobs=wf.failed_jobs,
            progress_percent=progress,
            created_at=wf.created_at
        ))
    
    return responses


@router.get("/workflows/{workflow_id}", response_model=WorkflowResponse)
async def get_workflow(
    workflow_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Get workflow details"""
    workflow = await storage.get_workflow(workflow_id)
    
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    if workflow.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Calculate progress as average of all job progress
    progress = await calculate_workflow_progress(workflow_id)
    
    return WorkflowResponse(
        id=workflow.id,
        name=workflow.name,
        status=workflow.status,
        total_jobs=workflow.total_jobs,
        completed_jobs=workflow.completed_jobs,
        failed_jobs=workflow.failed_jobs,
        progress_percent=progress,
        created_at=workflow.created_at
    )


@router.delete("/workflows/{workflow_id}")
async def cancel_workflow(
    workflow_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Cancel workflow (cancel all PENDING jobs)"""
    workflow = await storage.get_workflow(workflow_id)
    
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    if workflow.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Cancel all PENDING jobs
    jobs = await storage.get_workflow_jobs(workflow_id)
    cancelled_count = 0
    
    for job in jobs:
        if job.status == JobStatus.PENDING:
            success = await scheduler.cancel_job(job.id)
            if success:
                cancelled_count += 1
    
    logger.info(f"Cancelled {cancelled_count} jobs in workflow {workflow_id}")
    
    return {"message": f"Cancelled {cancelled_count} jobs", "workflow_id": workflow_id}


# ============== Job APIs ==============

@router.get("/workflows/{workflow_id}/jobs", response_model=List[JobResponse])
async def list_workflow_jobs(
    workflow_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Get all jobs for a workflow"""
    workflow = await storage.get_workflow(workflow_id)
    
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    
    if workflow.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    jobs = await storage.get_workflow_jobs(workflow_id)
    
    return [
        JobResponse(
            id=job.id,
            workflow_id=job.workflow_id,
            branch_id=job.branch_id,
            type=job.type,
            status=job.status,
            progress_percent=job.progress_percent,
            tiles_processed=job.tiles_processed,
            tiles_total=job.tiles_total,
            output_path=job.output_path,
            error_message=job.error_message
        )
        for job in jobs
    ]


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(
    job_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Get job details"""
    job = await storage.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    return JobResponse(
        id=job.id,
        workflow_id=job.workflow_id,
        branch_id=job.branch_id,
        type=job.type,
        status=job.status,
        progress_percent=job.progress_percent,
        tiles_processed=job.tiles_processed,
        tiles_total=job.tiles_total,
        error_message=job.error_message
    )


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Cancel job (only PENDING status)"""
    job = await storage.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    success = await scheduler.cancel_job(job_id)
    
    if not success:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel job with status {job.status}"
        )
    
    return {"message": "Job cancelled", "job_id": job_id}


@router.get("/jobs/{job_id}/result")
async def get_job_result(
    job_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """
    Get job result file (JSON)
    
    Note: Can serve result files even if job is no longer in memory storage.
    """
    import glob
    from pathlib import Path
    from fastapi.responses import FileResponse
    
    job = await storage.get_job(job_id)
    
    # Try to get path from job if it exists
    if job:
        if job.user_id != x_user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        if job.output_path:
            result_file = Path(job.output_path)
            if not result_file.is_absolute():
                project_root = Path(__file__).parent.parent.parent
                result_file = project_root / result_file
        else:
            result_file = None
    else:
        # Job not in memory, try to find result file on disk
        project_root = Path(__file__).parent.parent.parent
        results_dir = project_root / settings.RESULT_DIR
        
        # Search for JSON file with this job_id (prioritize non-intermediate)
        patterns = [
            str(results_dir / f"**/{job_id}_segmentation.json"),
            str(results_dir / f"**/{job_id}_tissue_mask.json"),
            str(results_dir / f"**/{job_id}*.json")
        ]
        
        result_file = None
        for pattern in patterns:
            matching_files = glob.glob(pattern, recursive=True)
            # Filter out intermediate files
            matching_files = [f for f in matching_files if 'intermediate' not in f]
            if matching_files:
                result_file = Path(matching_files[0])
                logger.info(f"Found result file for job {job_id} (not in memory): {result_file}")
                break
        
        if not result_file:
            raise HTTPException(status_code=404, detail="Job not found and no result files on disk")
    
    if not result_file or not result_file.exists():
        raise HTTPException(status_code=404, detail="Result file not found")
    
    return FileResponse(
        path=str(result_file),
        media_type="application/json",
        filename=result_file.name
    )


@router.get("/jobs/{job_id}/visualization")
async def get_job_visualization(
    job_id: str,
    thumbnail: bool = False,
    layer: str = "combined",  # "combined", "overlay", "wsi"
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """
    Get job visualization image
    
    Args:
        job_id: Job ID
        thumbnail: Return thumbnail version
        layer: Which layer to return:
            - "combined": WSI with overlay (default)
            - "overlay": Overlay only (transparent PNG)
            - "wsi": Original WSI background only
    
    Note: This endpoint can serve visualization files even if the job is no longer
    in memory storage (e.g., after server restart), as long as the files exist on disk.
    """
    from fastapi.responses import FileResponse
    from pathlib import Path
    import glob
    
    job = await storage.get_job(job_id)
    
    # Try to get path from job if it exists
    if job:
        if job.user_id != x_user_id:
            raise HTTPException(status_code=403, detail="Access denied")
        
        if job.output_path:
            result_file = Path(job.output_path)
            if not result_file.is_absolute():
                from pathlib import Path as P
                project_root = P(__file__).parent.parent.parent
                result_file = project_root / result_file
        else:
            result_file = None
    else:
        # Job not in memory, try to find result file on disk
        # Search in results directory
        from pathlib import Path as P
        project_root = P(__file__).parent.parent.parent
        results_dir = project_root / settings.RESULT_DIR
        
        # Search for any JSON file with this job_id
        pattern = str(results_dir / f"**/{job_id}*.json")
        matching_files = glob.glob(pattern, recursive=True)
        
        if matching_files:
            result_file = Path(matching_files[0])
            logger.info(f"Found result file for job {job_id} (not in memory): {result_file}")
        else:
            raise HTTPException(status_code=404, detail="Job not found and no result files on disk")
    
    if not result_file:
        raise HTTPException(status_code=404, detail="Result not available yet")
    
    # Construct visualization path
    if thumbnail:
        viz_file = result_file.parent / f"{job_id}_thumbnail.png"
    else:
        # Select layer
        if layer == "overlay":
            viz_file = result_file.parent / f"{job_id}_visualization_overlay_only.png"
        elif layer == "wsi":
            viz_file = result_file.parent / f"{job_id}_visualization_wsi_base.png"
        else:  # combined
            viz_file = result_file.parent / f"{job_id}_visualization.png"
    
    if not viz_file.exists():
        raise HTTPException(status_code=404, detail=f"Visualization not available: {viz_file.name}")
    
    return FileResponse(
        path=str(viz_file),
        media_type="image/png",
        filename=viz_file.name
    )


@router.get("/jobs/{job_id}/intermediate")
async def get_job_intermediate_result(
    job_id: str,
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """
    Get in-progress segmentation results
    
    This endpoint returns the current segmentation results while the job is still running,
    allowing users to see already-processed cells before completion.
    """
    from pathlib import Path
    
    job = await storage.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Check for intermediate results file
    if job.output_path:
        result_file = Path(job.output_path)
    else:
        # Try to construct path if job hasn't completed yet
        result_file = Path(settings.RESULT_DIR) / job.workflow_id / f"{job_id}_intermediate.json"
    
    if not result_file.is_absolute():
        from pathlib import Path as P
        project_root = P(__file__).parent.parent.parent
        result_file = project_root / result_file
    
    intermediate_file = result_file.parent / f"{job_id}_intermediate.json"
    
    if not intermediate_file.exists():
        # No intermediate results yet - return empty or job info
        return {
            "job_id": job_id,
            "status": job.status.value,
            "progress_percent": job.progress_percent,
            "tiles_processed": job.tiles_processed,
            "tiles_total": job.tiles_total,
            "message": "Processing started, intermediate results not yet available"
        }
    
    try:
        import json
        with open(intermediate_file, 'r') as f:
            data = json.load(f)
        return data
    except Exception as e:
        logger.error(f"Failed to read intermediate results: {e}")
        raise HTTPException(status_code=500, detail="Failed to read intermediate results")


@router.get("/jobs/{job_id}/intermediate/visualization")
async def get_job_intermediate_visualization(
    job_id: str,
    thumbnail: bool = False,
    layer: str = "combined",
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """
    Get in-progress visualization image
    
    Shows the current segmentation overlay on the WSI for cells that have been processed so far.
    """
    from fastapi.responses import FileResponse
    from pathlib import Path
    
    job = await storage.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job.user_id != x_user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Construct intermediate visualization path
    if job.output_path:
        result_file = Path(job.output_path)
    else:
        result_file = Path(settings.RESULT_DIR) / job.workflow_id / f"{job_id}_result.json"
    
    if not result_file.is_absolute():
        from pathlib import Path as P
        project_root = P(__file__).parent.parent.parent
        result_file = project_root / result_file
    
    if thumbnail:
        viz_file = result_file.parent / f"{job_id}_intermediate_thumbnail.png"
    else:
        if layer == "overlay":
            viz_file = result_file.parent / f"{job_id}_intermediate_visualization_overlay_only.png"
        elif layer == "wsi":
            viz_file = result_file.parent / f"{job_id}_intermediate_visualization_wsi_base.png"
        else:
            viz_file = result_file.parent / f"{job_id}_intermediate_visualization.png"
    
    if not viz_file.exists():
        raise HTTPException(status_code=404, detail="Intermediate visualization not yet available")
    
    return FileResponse(
        path=str(viz_file),
        media_type="image/png",
        filename=viz_file.name
    )


# ============== WebSocket ==============

@router.websocket("/ws/jobs/{job_id}")
async def websocket_job_progress(websocket: WebSocket, job_id: str):
    """WebSocket for job progress updates"""
    await manager.connect_job(job_id, websocket)
    
    try:
        # Send current status
        job = await storage.get_job(job_id)
        if job:
            await manager.broadcast_job_progress(job)
        
        # Keep connection alive
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_job(job_id, websocket)
        logger.info(f"WebSocket disconnected for job {job_id}")


@router.websocket("/ws/workflows/{workflow_id}")
async def websocket_workflow_progress(websocket: WebSocket, workflow_id: str):
    """WebSocket for workflow progress updates"""
    await manager.connect_workflow(workflow_id, websocket)
    
    try:
        # Send current status
        await manager.broadcast_workflow_progress(workflow_id)
        
        # Keep connection alive
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_workflow(workflow_id, websocket)
        logger.info(f"WebSocket disconnected for workflow {workflow_id}")


# ============== File Upload ==============

@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Upload WSI image file"""
    from pathlib import Path
    import aiofiles
    from backend.config import settings
    
    # Validate file type
    allowed_extensions = {'.svs', '.tif', '.tiff', '.ndpi', '.vms', '.vmu', '.scn', '.mrxs', '.bif'}
    file_ext = Path(file.filename).suffix.lower()
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {', '.join(allowed_extensions)}"
        )
    
    # Create user directory
    user_upload_dir = Path(settings.UPLOAD_DIR) / x_user_id
    user_upload_dir.mkdir(parents=True, exist_ok=True)
    
    # Save file
    file_path = user_upload_dir / file.filename
    
    async with aiofiles.open(file_path, 'wb') as f:
        content = await file.read()
        await f.write(content)
    
    logger.info(f"File uploaded: {file_path} ({len(content)} bytes)")
    
    return {
        "filename": file.filename,
        "path": str(file_path),
        "size": len(content),
        "message": "File uploaded successfully"
    }


@router.post("/files/check")
async def check_files_exist(
    file_paths: List[str],
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """Check if multiple files exist"""
    from pathlib import Path
    from backend.config import settings
    
    results = {}
    project_root = Path(__file__).parent.parent.parent
    
    for file_path in file_paths:
        # Try both absolute and relative paths
        path = Path(file_path)
        
        if not path.is_absolute():
            # Try relative to project root
            path = project_root / file_path
        
        results[file_path] = {
            "exists": path.exists(),
            "absolute_path": str(path)
        }
    
    return results


@router.get("/files")
async def list_files(
    x_user_id: str = Header(..., alias="X-User-ID")
):
    """List all files uploaded by the user"""
    from pathlib import Path
    from backend.config import settings
    
    user_upload_dir = Path(settings.UPLOAD_DIR) / x_user_id
    
    if not user_upload_dir.exists():
        return {"files": []}
    
    files = []
    for file_path in user_upload_dir.iterdir():
        if file_path.is_file():
            stat = file_path.stat()
            files.append({
                "filename": file_path.name,
                "path": str(file_path),
                "size": stat.st_size,
                "modified": stat.st_mtime
            })
    
    return {"files": files}


# ============== Health & Status ==============

@router.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy"}


@router.get("/status")
async def get_status():
    """Get system status"""
    tenant_status = await tenant_manager.get_status()
    
    return {
        "scheduler": {
            "max_workers": scheduler.max_workers,
            "running_jobs": len(scheduler.running_jobs)
        },
        "tenant_manager": tenant_status
    }