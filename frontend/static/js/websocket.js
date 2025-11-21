// ============================================
// WebSocket Manager for Real-time Updates
// ============================================

class WebSocketManager {
    constructor() {
        this.connections = new Map(); // workflow_id -> WebSocket
        this.reconnectAttempts = new Map();
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
    }
    
    connectToWorkflow(workflowId) {
        if (this.connections.has(workflowId)) {
            return; // Already connected
        }
        
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/v1/ws/workflows/${workflowId}`;
        
        try {
            const ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log(`WebSocket connected for workflow: ${workflowId}`);
                this.reconnectAttempts.set(workflowId, 0);
                this.updateConnectionStatus(true);
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                } catch (error) {
                    console.error('WebSocket message parse error:', error);
                }
            };
            
            ws.onerror = (error) => {
                console.error(`WebSocket error for workflow ${workflowId}:`, error);
                this.updateConnectionStatus(false);
            };
            
            ws.onclose = () => {
                console.log(`WebSocket closed for workflow: ${workflowId}`);
                this.connections.delete(workflowId);
                this.updateConnectionStatus(false);
                this.attemptReconnect(workflowId);
            };
            
            this.connections.set(workflowId, ws);
            
        } catch (error) {
            console.error(`Failed to create WebSocket for workflow ${workflowId}:`, error);
        }
    }
    
    disconnectWorkflow(workflowId) {
        const ws = this.connections.get(workflowId);
        if (ws) {
            ws.close();
            this.connections.delete(workflowId);
            console.log(`Disconnected from workflow: ${workflowId}`);
        }
    }
    
    disconnectAll() {
        this.connections.forEach((ws, workflowId) => {
            ws.close();
        });
        this.connections.clear();
        console.log('All WebSocket connections closed');
    }
    
    attemptReconnect(workflowId) {
        const attempts = this.reconnectAttempts.get(workflowId) || 0;
        
        if (attempts >= this.maxReconnectAttempts) {
            console.log(`Max reconnect attempts reached for workflow: ${workflowId}`);
            return;
        }
        
        const delay = this.reconnectDelay * Math.pow(2, attempts); // Exponential backoff
        console.log(`Reconnecting to workflow ${workflowId} in ${delay}ms (attempt ${attempts + 1})`);
        
        this.reconnectAttempts.set(workflowId, attempts + 1);
        
        setTimeout(() => {
            this.connectToWorkflow(workflowId);
        }, delay);
    }
    
    handleMessage(data) {
        console.log('WebSocket message received:', data);
        
        if (data.type === 'workflow_progress') {
            this.handleWorkflowProgress(data);
        } else if (data.type === 'progress') {
            this.handleJobProgress(data);
        }
    }
    
    handleWorkflowProgress(data) {
        console.log('Handling workflow progress:', data);
        
        // Update workflow card if visible (in list view)
        const workflowCard = document.querySelector(`[data-workflow-id="${data.workflow_id}"]`);
        if (workflowCard) {
            // Update progress bar
            const progressFill = workflowCard.querySelector('.progress-fill');
            if (progressFill) {
                progressFill.style.width = `${data.progress_percent}%`;
            }
            
            // Update progress percentage text
            const progressPercent = workflowCard.querySelector('.progress-percent');
            if (progressPercent) {
                progressPercent.textContent = `${data.progress_percent.toFixed(1)}%`;
            }
            
            // Update status badge
            const statusBadge = workflowCard.querySelector('.status-badge');
            if (statusBadge) {
                statusBadge.className = `status-badge ${data.status.toLowerCase()}`;
                statusBadge.textContent = data.status;
            }
            
            // Update stats
            const completedStat = workflowCard.querySelector('[data-stat="completed"]');
            if (completedStat) {
                completedStat.textContent = data.completed_jobs;
            }
            
            const failedStat = workflowCard.querySelector('[data-stat="failed"]');
            if (failedStat) {
                failedStat.textContent = data.failed_jobs || 0;
            }
        }
        
        // Update workflow detail modal if open
        const modalProgress = document.querySelector(`[data-workflow-progress="${data.workflow_id}"]`);
        if (modalProgress) {
            modalProgress.textContent = `${data.progress_percent.toFixed(1)}%`;
        }
        
        const modalProgressBar = document.querySelector(`[data-workflow-progress-bar="${data.workflow_id}"]`);
        if (modalProgressBar) {
            modalProgressBar.style.width = `${data.progress_percent}%`;
        }
        
        const modalCompleted = document.querySelector(`[data-workflow-completed="${data.workflow_id}"]`);
        if (modalCompleted) {
            modalCompleted.textContent = data.completed_jobs;
        }
        
        const modalStatus = document.querySelector(`[data-workflow-status="${data.workflow_id}"]`);
        if (modalStatus) {
            modalStatus.className = `status-badge ${data.status.toLowerCase()}`;
            modalStatus.textContent = data.status;
        }
        
        // Trigger a refresh if workflow is complete
        if (data.status === 'SUCCEEDED' || data.status === 'FAILED') {
            setTimeout(() => {
                if (typeof loadWorkflows === 'function') {
                    loadWorkflows();
                }
            }, 1000);
        }
    }
    
    handleJobProgress(data) {
        // Update job card if visible
        const jobCard = document.querySelector(`[data-job-id="${data.job_id}"]`);
        if (jobCard) {
            // Update progress bar
            const progressFill = jobCard.querySelector('.progress-fill');
            if (progressFill) {
                progressFill.style.width = `${data.progress_percent}%`;
            }
            
            // Update status badge
            const statusBadge = jobCard.querySelector('.status-badge');
            if (statusBadge) {
                statusBadge.className = `status-badge ${data.status.toLowerCase()}`;
                statusBadge.textContent = data.status;
            }
            
            // Update tiles info
            const tilesInfo = jobCard.querySelector('[data-info="tiles"]');
            if (tilesInfo) {
                tilesInfo.textContent = `${data.tiles_processed}/${data.tiles_total}`;
            }
        }
        
        // Update progress percentage display
        const progressLabel = jobCard?.querySelector('.progress-label span:last-child');
        if (progressLabel) {
            progressLabel.textContent = `${data.progress_percent.toFixed(1)}%`;
        }
    }
    
    updateConnectionStatus(connected) {
        const statusIcon = document.getElementById('connectionStatus');
        const statusText = document.getElementById('connectionText');
        
        // Check if we have any active connections
        const hasConnections = this.connections.size > 0;
        const actuallyConnected = hasConnections && connected;
        
        if (statusIcon) {
            if (actuallyConnected) {
                statusIcon.className = 'fas fa-circle connected';
            } else if (!hasConnections) {
                statusIcon.className = 'fas fa-circle'; // Neutral
            } else {
                statusIcon.className = 'fas fa-circle disconnected';
            }
        }
        
        if (statusText) {
            if (actuallyConnected) {
                statusText.textContent = 'Connected';
            } else if (!hasConnections) {
                statusText.textContent = 'Standby';
            } else {
                statusText.textContent = 'Connecting...';
            }
        }
    }
}

// ============================================
// Initialize WebSocket Manager
// ============================================

const wsManager = new WebSocketManager();

function initializeWebSocket() {
    console.log('Initializing WebSocket connections...');
    
    // Set initial status
    wsManager.updateConnectionStatus(false);
    
    // Connect to active workflows
    setTimeout(() => {
        connectToActiveWorkflows();
    }, 500); // Reduced delay from 1000ms to 500ms
}

async function connectToActiveWorkflows() {
    try {
        const workflows = await apiCall('/workflows');
        
        // Connect to running or pending workflows
        const activeWorkflows = workflows.filter(wf => 
            wf.status === 'RUNNING' || wf.status === 'PENDING'
        );
        
        activeWorkflows.forEach(wf => {
            wsManager.connectToWorkflow(wf.id);
        });
        
        // Update status even if no active workflows
        if (activeWorkflows.length === 0) {
            wsManager.updateConnectionStatus(false);
        }
        
        console.log(`WebSocket: ${activeWorkflows.length} active workflow(s)`);
        
    } catch (error) {
        console.error('Failed to connect to active workflows:', error);
        wsManager.updateConnectionStatus(false);
    }
}

// Auto-reconnect to new workflows
setInterval(() => {
    connectToActiveWorkflows();
}, 10000); // Check every 10 seconds

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    wsManager.disconnectAll();
});

