from pydantic import BaseModel, Field
from typing import List, Dict, Optional, Any
from enum import Enum
from datetime import datetime
import uuid


class JobStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class WorkflowStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class JobType(str, Enum):
    SEGMENTATION = "SEGMENTATION"
    TISSUE_MASK = "TISSUE_MASK"



class JobConfig(BaseModel):
    """single job config"""
    type: JobType
    input_image_path: str
    params: Dict[str, Any] = Field(default_factory=dict)


class JobCreate(BaseModel):
    """create job request"""
    workflow_id: str
    branch_id: str
    config: JobConfig


class Job(BaseModel):
    """job full model"""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    workflow_id: str
    branch_id: str
    user_id: str
    
    type: JobType
    status: JobStatus = JobStatus.PENDING
    
    input_image_path: str
    output_path: Optional[str] = None
    
    # Progress tracking
    progress_percent: float = 0.0
    tiles_processed: int = 0
    tiles_total: int = 0
    
    # Metadata
    params: Dict[str, Any] = Field(default_factory=dict)
    error_message: Optional[str] = None
    
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class JobResponse(BaseModel):
    """Job response"""
    id: str
    workflow_id: str
    branch_id: str
    type: JobType
    status: JobStatus
    progress_percent: float
    tiles_processed: int
    tiles_total: int
    output_path: Optional[str] = None
    error_message: Optional[str] = None


# ============== Workflow Models ==============

class WorkflowDAG(BaseModel):
    """branch_id -> List[JobConfig]"""
    branches: Dict[str, List[JobConfig]]


class WorkflowCreate(BaseModel):
    """create workflow request"""
    name: str
    dag: WorkflowDAG


class Workflow(BaseModel):
    """Workflow full model"""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    name: str
    
    dag: WorkflowDAG
    status: WorkflowStatus = WorkflowStatus.PENDING
    
    # Progress
    total_jobs: int = 0
    completed_jobs: int = 0
    failed_jobs: int = 0
    
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class WorkflowResponse(BaseModel):
    """Workflow response"""
    id: str
    name: str
    status: WorkflowStatus
    total_jobs: int
    completed_jobs: int
    failed_jobs: int
    progress_percent: float
    created_at: datetime


# ============== WebSocket Messages ==============

class ProgressUpdate(BaseModel):
    """progress update message"""
    type: str = "progress"
    job_id: str
    workflow_id: str
    status: JobStatus
    progress_percent: float
    tiles_processed: int
    tiles_total: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class WorkflowProgressUpdate(BaseModel):
    """Workflow progress update"""
    type: str = "workflow_progress"
    workflow_id: str
    status: WorkflowStatus
    completed_jobs: int
    failed_jobs: int = 0
    total_jobs: int
    progress_percent: float
    timestamp: datetime = Field(default_factory=datetime.utcnow)