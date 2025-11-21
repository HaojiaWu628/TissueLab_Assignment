# backend/core/tenant_manager.py
import asyncio
from typing import Dict, Set
from collections import deque
import logging

from backend.models.schemas import JobStatus
from backend.models.storage import storage
from backend.config import settings

logger = logging.getLogger(__name__)


class TenantManager:
    """
    max 3 active users, queue for the 4th user
    """
    
    def __init__(self, max_active_users: int = None):
        self.max_active_users = max_active_users or settings.MAX_ACTIVE_USERS
        
        self.active_users: Set[str] = set()
        
        # user_id -> asyncio.Event
        self.waiting_users: Dict[str, asyncio.Event] = {}
        self.wait_queue: deque = deque()  
        
        self.user_job_counts: Dict[str, int] = {}  # user_id -> job count
        
        self._lock = asyncio.Lock()
        
        logger.info(f"TenantManager initialized with max {self.max_active_users} active users")
    
    async def acquire_user_slot(self, user_id: str) -> bool:
        # get user slot
        async with self._lock:
            # active -> return 
            if user_id in self.active_users:
                logger.debug(f"User {user_id} already active")
                return True
            
            # slot available -> activate user
            if len(self.active_users) < self.max_active_users:
                self.active_users.add(user_id)
                self.user_job_counts[user_id] = 0
                logger.info(f"User {user_id} activated ({len(self.active_users)}/{self.max_active_users})")
                return True
            
            # need to queue
            logger.info(f"User {user_id} queued (active users: {len(self.active_users)}/{self.max_active_users})")
            event = asyncio.Event()
            self.waiting_users[user_id] = event
            self.wait_queue.append(user_id)
        
        await event.wait()
        
        logger.info(f"User {user_id} woke up from queue")
        return True
    
    async def register_job_start(self, user_id: str):
        async with self._lock:
            if user_id in self.user_job_counts:
                self.user_job_counts[user_id] += 1
                logger.debug(f"User {user_id} now has {self.user_job_counts[user_id]} running jobs")
    
    async def register_job_end(self, user_id: str):
        """
        if no running jobs, release slot -> wake up next user
        """
        async with self._lock:
            if user_id not in self.user_job_counts:
                return
            
            self.user_job_counts[user_id] -= 1
            
            if self.user_job_counts[user_id] <= 0:
                
                running_jobs = await storage.get_running_jobs_for_user(user_id)
                
                if len(running_jobs) == 0:
                    logger.info(f"User {user_id} finished all jobs, releasing slot")
                    self.active_users.discard(user_id)
                    self.user_job_counts.pop(user_id, None)
                    
                    await self._wake_next_user()
    
    async def _wake_next_user(self):

        if not self.wait_queue:
            return
        
        next_user = self.wait_queue.popleft()
        if next_user in self.waiting_users:
            self.active_users.add(next_user)
            self.user_job_counts[next_user] = 0
            
            event = self.waiting_users.pop(next_user)
            event.set()
            
            logger.info(f"Woke up user {next_user} from queue")
    
    async def get_status(self) -> dict:

        return {
            "active_users": len(self.active_users),
            "max_active_users": self.max_active_users,
            "queued_users": len(self.wait_queue),
            "user_job_counts": dict(self.user_job_counts)
        }


tenant_manager = TenantManager()