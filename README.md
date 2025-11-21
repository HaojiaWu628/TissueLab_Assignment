# Workflow Scheduler

A branch-aware, multi-tenant workflow scheduler for large-image inference tasks.

## Quick Start

```bash
# Make script executable
chmod +x start.sh

# Start the application
./start.sh
```

Then open your browser at: `http://localhost:8000`

## Architecture

```
├── backend/
│   ├── api/          # REST API endpoints
│   ├── core/         # Scheduler and tenant manager
│   ├── models/       # Data models and storage
│   ├── services/     # Image processing services
│   └── workers/      # Job execution engine
├── frontend/         # Static web UI
└── data/            # Uploaded images and results
```



## workflow
Upload Image
      ↓
Create Workflow
      ↓
Generate Tiles
      ↓
(Optional) Tissue Mask
      ↓
InstanSeg Segmentation (tile-based)
      ↓
Merge Overlapping Cells
      ↓
Aggregate JSON Results
      ↓
Generate Visualizations (WSI base, overlay, combined, thumbnail)
      ↓
Return final result to UI

## Configuration


```python
MAX_WORKERS = 5              # Global concurrent worker limit
MAX_ACTIVE_USERS = 3         # Maximum active users
TILE_SIZE = 1024            # Tile size in pixels
TILE_OVERLAP = 128          # Overlap between tiles
BATCH_SIZE = 4              # Tiles per batch
INSTANSEG_MODEL = "brightfield_nuclei"  # InstanSeg model (always real)
```

## API Endpoints

- `GET /api/v1/health` - Health check
- `GET /api/v1/status` - System status
- `POST /api/v1/workflows` - Create workflow
- `GET /api/v1/workflows` - List workflows
- `POST /api/v1/upload` - Upload image file
- `GET /api/v1/jobs/{id}/result` - Download job result
- `WebSocket /api/v1/ws/jobs/{id}` - Real-time job updates

## Testing

```bash
# Test optimization features
python test_optimizations.py

# Verify InstanSeg mode
python verify_instanseg.py
```

## Design Highlights

The scheduler implementation demonstrates:

1. **Concurrency Control**: Sophisticated use of async primitives (Semaphore, Lock) to manage parallel and serial execution
2. **Resource Management**: Per-user quotas and global resource limits
3. **Fault Tolerance**: Graceful degradation and error handling
4. **Scalability**: Architecture supports distributed execution with minimal changes
5. **Testability**: Separation of concerns enables testing without real AI models

## Requirements

- Python 3.11
- FastAPI
- asyncio
- numpy, opencv-python
- (Optional) OpenSlide, InstanSeg for real processing


