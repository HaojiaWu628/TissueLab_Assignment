from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # App
    APP_NAME: str = "Workflow Scheduler"
    DEBUG: bool = True
    API_PREFIX: str = "/api/v1"
    
    # Redis
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_DB: int = 0
    
    # Scheduler
    MAX_WORKERS: int = 5
    MAX_ACTIVE_USERS: int = 3
    
    # Paths
    DATA_DIR: str = "./data"
    UPLOAD_DIR: str = "./data/uploads"
    RESULT_DIR: str = "./data/results"
    
    # InstanSeg (always real, no mock mode)
    # NOTE: Requires Python and OpenSlide same architecture (both arm64 or both x86_64)
    INSTANSEG_MODEL: str = "brightfield_nuclei"  # InstanSeg model to use
    TILE_SIZE: int = 1024
    TILE_OVERLAP: int = 128
    BATCH_SIZE: int = 4
    
    class Config:
        env_file = ".env"


settings = Settings()