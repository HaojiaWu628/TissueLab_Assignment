#!/bin/bash

# Workflow Scheduler - Quick Start Script

set -e

echo "=================================="
echo "Workflow Scheduler - Starting..."
echo "=================================="

# Set library path for OpenSlide (required for real InstanSeg)
export DYLD_LIBRARY_PATH=/opt/homebrew/lib:$DYLD_LIBRARY_PATH

# Activate Python 3.11 virtual environment (required for real InstanSeg)
if [ -d "venv311" ]; then
    echo "Activating Python 3.11 virtual environment..."
    source venv311/bin/activate
else
    echo "Warning: venv311 not found. Using system Python."
fi

# Check Python version
python_version=$(python --version 2>&1 | awk '{print $2}')
echo "Python version: $python_version"

# Install dependencies (if needed)
if [ ! -d "venv" ]; then
    echo ""
    echo "Installing dependencies..."
    pip install --user -r requirements.txt 2>/dev/null || echo "Dependencies may already be installed"
fi

# Create data directories
mkdir -p data/uploads data/results

# Start backend
echo ""
echo "Starting backend server on http://localhost:8000"
echo "Access frontend at: http://localhost:8000"
echo "API docs at: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

cd "$(dirname "$0")"
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

