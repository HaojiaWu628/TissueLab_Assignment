// ============================================
// Configuration & Global State
// ============================================

const API_BASE = window.location.origin + '/api/v1';
let currentUserId = 'user-001';
let workflows = [];
let allJobs = [];

// ============================================
// Initialize Application
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    console.log('Initializing Workflow Scheduler...');
    
    // Set initial user
    updateCurrentUser();
    
    // Setup event listeners
    setupEventListeners();
    
    // Load initial data
    loadSystemStatus();
    refreshAll();
    
    // Start auto-refresh
    startAutoRefresh();
    
    // Initialize WebSocket
    initializeWebSocket();
    
    console.log('Application initialized');
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // User ID
    document.getElementById('setUserBtn').addEventListener('click', updateCurrentUser);
    document.getElementById('userIdInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') updateCurrentUser();
    });
    
    // Navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', handleNavClick);
    });
    
    document.querySelectorAll('[data-tab]').forEach(element => {
        element.addEventListener('click', function(e) {
            e.preventDefault();
            const tabName = this.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
    
    // File upload
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);
    
    // Workflow form
    document.getElementById('workflowForm').addEventListener('submit', handleWorkflowSubmit);
    
    // DAG JSON textarea - auto preview
    document.getElementById('dagJson').addEventListener('input', debounce(previewDAG, 500));
    
    // Example tabs
    document.querySelectorAll('.example-tab').forEach(tab => {
        tab.addEventListener('click', handleExampleTabClick);
    });
    
    // Job filter
    document.getElementById('jobStatusFilter').addEventListener('change', filterJobs);
}

function handleNavClick(e) {
    e.preventDefault();
    
    // Update active state
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    e.currentTarget.classList.add('active');
    
    // Show corresponding tab
    const tabName = e.currentTarget.getAttribute('data-tab');
    switchTab(tabName);
}

function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    // Show selected tab
    document.getElementById(tabName).classList.add('active');
    
    // Update nav link
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector(`.nav-link[data-tab="${tabName}"]`)?.classList.add('active');
    
    // Load data for tab
    switch(tabName) {
        case 'dashboard':
            refreshAll();
            break;
        case 'workflows':
            loadWorkflows();
            break;
        case 'jobs':
            loadAllJobs();
            break;
        case 'create':
            loadExampleCode('simple');
            loadUploadedFiles();
            break;
    }
}

// ============================================
// User Management
// ============================================

function updateCurrentUser() {
    const input = document.getElementById('userIdInput');
    const newUserId = input.value.trim();
    
    if (!newUserId) {
        showToast('Please enter a valid User ID', 'error');
        return;
    }
    
    currentUserId = newUserId;
    document.getElementById('currentUserDisplay').textContent = `User: ${currentUserId}`;
    
    showToast(`Switched to user: ${currentUserId}`, 'success');
    
    // Reload data
    refreshAll();
}

// ============================================
// API Calls
// ============================================

async function apiCall(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-User-ID': currentUserId,
        ...options.headers
    };
    
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'API request failed');
        }
        
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// ============================================
// System Status
// ============================================

async function loadSystemStatus() {
    try {
        const status = await apiCall('/status');
        
        document.getElementById('activeWorkers').textContent = 
            `${status.scheduler.running_jobs}/${status.scheduler.max_workers}`;
        document.getElementById('activeUsers').textContent = 
            `${status.tenant_manager.active_users}/${status.tenant_manager.max_active_users}`;
        document.getElementById('queuedUsers').textContent = 
            status.tenant_manager.queued_users;
        
    } catch (error) {
        console.error('Failed to load system status:', error);
    }
}

// ============================================
// Workflows
// ============================================

async function loadWorkflows() {
    try {
        workflows = await apiCall('/workflows');
        renderWorkflows(workflows);
        renderDashboardWorkflows(workflows.slice(0, 5));
    } catch (error) {
        console.error('Failed to load workflows:', error);
    }
}

function renderWorkflows(data) {
    const container = document.getElementById('workflowsList');
    
    if (data.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-project-diagram"></i>
                <h3>No workflows yet</h3>
                <p>Create your first workflow to get started</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = data.map(wf => `
        <div class="workflow-card" data-workflow-id="${wf.id}" onclick="viewWorkflowDetails('${wf.id}')">
            <div class="workflow-header">
                <div>
                    <div class="workflow-title">${escapeHtml(wf.name)}</div>
                    <div class="workflow-id">${wf.id}</div>
                </div>
                <span class="status-badge ${wf.status.toLowerCase()}">${wf.status}</span>
            </div>
            
            <div class="workflow-stats">
                <div class="stat-item">
                    <div class="stat-value" data-stat="total">${wf.total_jobs}</div>
                    <div class="stat-label">Total</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" data-stat="completed">${wf.completed_jobs}</div>
                    <div class="stat-label">Done</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" data-stat="failed">${wf.failed_jobs}</div>
                    <div class="stat-label">Failed</div>
                </div>
            </div>
            
            <div class="progress-container" style="margin-top: 1rem;">
                <div class="progress-label">
                    <span>Progress</span>
                    <span data-workflow-progress="${wf.id}">${wf.progress_percent.toFixed(1)}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" data-workflow-progress-bar="${wf.id}" style="width: ${wf.progress_percent}%"></div>
                </div>
            </div>
        </div>
    `).join('');
    
    // Connect WebSocket to running/pending workflows
    if (typeof wsManager !== 'undefined') {
        data.forEach(wf => {
            if (wf.status === 'RUNNING' || wf.status === 'PENDING') {
                wsManager.connectToWorkflow(wf.id);
            }
        });
    }
}

function renderDashboardWorkflows(data) {
    const container = document.getElementById('dashboardWorkflows');
    
    if (data.length === 0) {
        container.innerHTML = '<p class="empty-state">No recent workflows</p>';
        return;
    }
    
    container.innerHTML = data.map(wf => `
        <div class="workflow-card" data-workflow-id="${wf.id}" onclick="viewWorkflowDetails('${wf.id}')">
            <div class="workflow-header">
                <div>
                    <div class="workflow-title">${escapeHtml(wf.name)}</div>
                </div>
                <span class="status-badge ${wf.status.toLowerCase()}">${wf.status}</span>
            </div>
            
            <div class="progress-container" style="margin-top: 1rem;">
                <div class="progress-label">
                    <span>Progress</span>
                    <span data-workflow-progress="${wf.id}">${wf.progress_percent.toFixed(1)}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" data-workflow-progress-bar="${wf.id}" style="width: ${wf.progress_percent}%"></div>
                </div>
            </div>
        </div>
    `).join('');
    
    // Connect WebSocket to running/pending workflows
    if (typeof wsManager !== 'undefined') {
        data.forEach(wf => {
            if (wf.status === 'RUNNING' || wf.status === 'PENDING') {
                wsManager.connectToWorkflow(wf.id);
            }
        });
    }
}

async function viewWorkflowDetails(workflowId) {
    try {
        const workflow = await apiCall(`/workflows/${workflowId}`);
        const jobs = await apiCall(`/workflows/${workflowId}/jobs`);
        
        const modalBody = document.getElementById('jobModalBody');
        modalBody.innerHTML = `
            <h3>${escapeHtml(workflow.name)}</h3>
            <p><strong>ID:</strong> ${workflow.id}</p>
            <p><strong>Status:</strong> <span class="status-badge ${workflow.status.toLowerCase()}" data-workflow-status="${workflowId}">${workflow.status}</span></p>
            
            <div class="progress-container" style="margin: 1.5rem 0;">
                <div class="progress-label">
                    <span><strong>Overall Progress</strong></span>
                    <span data-workflow-progress="${workflowId}">${workflow.progress_percent.toFixed(1)}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" data-workflow-progress-bar="${workflowId}" style="width: ${workflow.progress_percent}%"></div>
                </div>
                <div style="margin-top: 0.5rem; font-size: 0.875rem; color: #666;">
                    <span data-workflow-completed="${workflowId}">${workflow.completed_jobs}</span> / ${workflow.total_jobs} jobs completed
                </div>
            </div>
            
            <h4 style="margin-top: 2rem;">Jobs (${jobs.length})</h4>
            <div class="jobs-grid" style="margin-top: 1rem;">
                ${jobs.map(job => `
                    <div class="job-card" data-job-id="${job.id}">
                        <div class="job-header">
                            <div>
                                <strong>${job.type}</strong><br>
                                <small>${job.id}</small>
                            </div>
                            <span class="status-badge ${job.status.toLowerCase()}">${job.status}</span>
                        </div>
                        <div class="job-info">
                            <div class="info-item">
                                <span class="info-label">Branch</span>
                                <span class="info-value">${job.branch_id}</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">Progress</span>
                                <span class="info-value" data-info="progress">${job.progress_percent.toFixed(1)}%</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">Tiles</span>
                                <span class="info-value" data-info="tiles">${job.tiles_processed}/${job.tiles_total || '-'}</span>
                            </div>
                        </div>
                        ${(job.status === 'RUNNING' || job.status === 'PENDING' || job.progress_percent > 0) ? `
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${job.progress_percent}%"></div>
                        </div>
                        ` : ''}
                        ${job.status === 'SUCCEEDED' ? `
                        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
                            <button class="btn-primary" onclick="viewJobResult('${job.id}')" style="flex: 1; font-size: 0.875rem;">
                                <i class="fas fa-eye"></i> View Result
                            </button>
                            <button class="btn-primary" onclick="downloadJobResult('${job.id}')" style="flex: 1; font-size: 0.875rem;">
                                <i class="fas fa-download"></i> Download
                            </button>
                        </div>
                        ` : ''}
                    </div>
                `).join('')}
            </div>
        `;
        
        // Connect WebSocket for real-time updates
        if (typeof wsManager !== 'undefined') {
            wsManager.connectToWorkflow(workflowId);
        }
        
        // Auto-refresh every 2 seconds if workflow is still running
        if (workflow.status === 'RUNNING' || workflow.status === 'PENDING') {
            window.workflowDetailRefreshInterval = setInterval(async () => {
                try {
                    const updatedWorkflow = await apiCall(`/workflows/${workflowId}`);
                    const updatedJobs = await apiCall(`/workflows/${workflowId}/jobs`);
                    
                    // Update workflow progress
                    const progressEl = document.querySelector(`[data-workflow-progress="${workflowId}"]`);
                    if (progressEl) {
                        progressEl.textContent = `${updatedWorkflow.progress_percent.toFixed(1)}%`;
                    }
                    
                    // Update workflow progress bar
                    const progressBarEl = document.querySelector(`[data-workflow-progress-bar="${workflowId}"]`);
                    if (progressBarEl) {
                        progressBarEl.style.width = `${updatedWorkflow.progress_percent}%`;
                    }
                    
                    // Update completed jobs count
                    const completedEl = document.querySelector(`[data-workflow-completed="${workflowId}"]`);
                    if (completedEl) {
                        completedEl.textContent = updatedWorkflow.completed_jobs;
                    }
                    
                    // Update workflow status
                    const statusEl = document.querySelector(`[data-workflow-status="${workflowId}"]`);
                    if (statusEl) {
                        statusEl.className = `status-badge ${updatedWorkflow.status.toLowerCase()}`;
                        statusEl.textContent = updatedWorkflow.status;
                    }
                    
                    // Update each job
                    updatedJobs.forEach(job => {
                        const jobCard = document.querySelector(`[data-job-id="${job.id}"]`);
                        if (jobCard) {
                            // Update progress
                            const progressInfo = jobCard.querySelector('[data-info="progress"]');
                            if (progressInfo) {
                                progressInfo.textContent = `${job.progress_percent.toFixed(1)}%`;
                            }
                            
                            // Update tiles
                            const tilesInfo = jobCard.querySelector('[data-info="tiles"]');
                            if (tilesInfo) {
                                tilesInfo.textContent = `${job.tiles_processed}/${job.tiles_total || '-'}`;
                            }
                            
                            // Update progress bar
                            let progressBar = jobCard.querySelector('.progress-fill');
                            if (progressBar) {
                                progressBar.style.width = `${job.progress_percent}%`;
                            } else if (job.status === 'RUNNING' || job.status === 'PENDING') {
                                // Dynamically add progress bar if it doesn't exist
                                const jobInfo = jobCard.querySelector('.job-info');
                                if (jobInfo && !jobCard.querySelector('.progress-bar')) {
                                    const progressBarHtml = `
                                        <div class="progress-bar">
                                            <div class="progress-fill" style="width: ${job.progress_percent}%"></div>
                                        </div>
                                    `;
                                    jobInfo.insertAdjacentHTML('afterend', progressBarHtml);
                                }
                            }
                            
                            // Update status
                            const statusBadge = jobCard.querySelector('.status-badge');
                            if (statusBadge) {
                                statusBadge.className = `status-badge ${job.status.toLowerCase()}`;
                                statusBadge.textContent = job.status;
                            }
                        }
                    });
                    
                    // Stop refreshing if workflow is complete
                    if (updatedWorkflow.status === 'SUCCEEDED' || updatedWorkflow.status === 'FAILED') {
                        clearInterval(window.workflowDetailRefreshInterval);
                        // Reload the modal to show download buttons
                        setTimeout(() => viewWorkflowDetails(workflowId), 500);
                    }
                } catch (error) {
                    console.error('Failed to refresh workflow details:', error);
                }
            }, 2000); // Refresh every 2 seconds
        }
        
        document.getElementById('jobModal').classList.add('active');
    } catch (error) {
        console.error('Failed to load workflow details:', error);
    }
}

// ============================================
// Jobs
// ============================================

async function loadAllJobs() {
    try {
        // Get all workflows first
        const workflows = await apiCall('/workflows');
        
        // Get jobs for each workflow
        const jobPromises = workflows.map(wf => 
            apiCall(`/workflows/${wf.id}/jobs`)
        );
        
        const jobArrays = await Promise.all(jobPromises);
        allJobs = jobArrays.flat();
        
        renderAllJobs(allJobs);
        renderDashboardJobs(allJobs.filter(j => j.status === 'RUNNING').slice(0, 5));
    } catch (error) {
        console.error('Failed to load jobs:', error);
    }
}

function renderAllJobs(data) {
    const container = document.getElementById('allJobsList');
    
    if (data.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-tasks"></i>
                <h3>No jobs yet</h3>
                <p>Submit a workflow to create jobs</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = data.map(job => renderJobCard(job)).join('');
}

function renderDashboardJobs(data) {
    const container = document.getElementById('dashboardJobs');
    
    if (data.length === 0) {
        container.innerHTML = '<p class="empty-state">No running jobs</p>';
        return;
    }
    
    container.innerHTML = data.map(job => renderJobCard(job, true)).join('');
}

function renderJobCard(job, compact = false) {
    return `
        <div class="job-card">
            <div class="job-header">
                <div>
                    <strong>${job.type}</strong><br>
                    ${!compact ? `<small style="font-family: monospace;">${job.id}</small>` : ''}
                </div>
                <span class="status-badge ${job.status.toLowerCase()}">${job.status}</span>
            </div>
            
            ${!compact ? `
            <div class="job-info">
                <div class="info-item">
                    <span class="info-label">Workflow</span>
                    <span class="info-value">${job.workflow_id.substring(0, 8)}...</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Branch</span>
                    <span class="info-value">${job.branch_id}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Tiles</span>
                    <span class="info-value">${job.tiles_processed}/${job.tiles_total || '-'}</span>
                </div>
            </div>
            ` : ''}
            
            ${job.progress_percent > 0 ? `
            <div class="progress-container">
                <div class="progress-label">
                    <span>${job.status}</span>
                    <span>${job.progress_percent.toFixed(1)}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${job.progress_percent}%"></div>
                </div>
            </div>
            ` : ''}
            
            ${job.status === 'SUCCEEDED' && !compact ? `
            <div style="margin-top: 1rem;">
                <button class="btn-primary" onclick="viewJobResult('${job.id}')" style="width: 100%; margin-bottom: 0.5rem;">
                    <i class="fas fa-eye"></i> View Result
                </button>
            </div>
            ` : ''}
            
            ${job.status === 'RUNNING' && job.progress_percent > 10 && !compact ? `
            <div style="margin-top: 1rem;">
                <button class="btn-secondary" onclick="viewInProgressResult('${job.id}')" style="width: 100%; font-size: 0.875rem;">
                    <i class="fas fa-eye"></i> View In-Progress Results
                </button>
            </div>
            ` : ''}
            
            ${job.error_message ? `
            <div style="margin-top: 1rem; padding: 0.75rem; background: #fee2e2; border-radius: 6px; color: #991b1b;">
                <strong>Error:</strong> ${escapeHtml(job.error_message)}
            </div>
            ` : ''}
        </div>
    `;
}

function filterJobs() {
    const filter = document.getElementById('jobStatusFilter').value;
    
    if (!filter) {
        renderAllJobs(allJobs);
        return;
    }
    
    const filtered = allJobs.filter(job => job.status === filter);
    renderAllJobs(filtered);
}

async function downloadJobResult(jobId) {
    try {
        showToast('Downloading result...', 'info');
        
        const response = await fetch(`${API_BASE}/jobs/${jobId}/result`, {
            headers: {
                'X-User-ID': currentUserId
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to download result');
        }
        
        // Get filename from header or use default
        const contentDisposition = response.headers.get('content-disposition');
        let filename = `job_${jobId}_result.json`;
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="?(.+)"?/);
            if (match) filename = match[1];
        }
        
        // Download file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Result downloaded successfully!', 'success');
        
    } catch (error) {
        console.error('Failed to download result:', error);
        showToast('Failed to download result: ' + error.message, 'error');
    }
}

async function viewJobResult(jobId) {
    try {
        showToast('Loading result...', 'info');
        
        const response = await fetch(`${API_BASE}/jobs/${jobId}/result`, {
            headers: {
                'X-User-ID': currentUserId
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to load result');
        }
        
        const result = await response.json();
        
        // Check if visualization is available (only for segmentation jobs, not tissue_mask)
        const isTissueMask = result.type === 'tissue_mask';
        const hasVisualization = !isTissueMask && result.visualization && result.visualization.visualization_path;
        
        // Create result viewer modal HTML
        const modalTitle = isTissueMask ? 'Tissue Mask Complete' : 'Segmentation Complete';
        const modalIcon = isTissueMask ? 'fa-layer-group' : 'fa-check-circle';
        
        const modalHTML = `
            <div id="resultModal" class="modal active">
                <div class="modal-content" style="max-width: 1000px; max-height: 90vh;">
                    <div class="modal-header">
                        <h2><i class="fas ${modalIcon}"></i> ${modalTitle}</h2>
                        <button class="modal-close" onclick="closeResultModal()">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body" style="max-height: calc(90vh - 120px); overflow-y: auto;">
                        
                        <!-- Statistics Grid -->
                        ${isTissueMask ? `
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
                            <div style="background: linear-gradient(135deg, #2196F3 0%, #42A5F5 100%); padding: 1.25rem; border-radius: 8px; color: white;">
                                <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Total Tiles</div>
                                <div style="font-size: 2rem; font-weight: bold;">${result.total_tiles || 0}</div>
                            </div>
                            <div style="background: linear-gradient(135deg, #4CAF50 0%, #66BB6A 100%); padding: 1.25rem; border-radius: 8px; color: white;">
                                <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Tissue Tiles</div>
                                <div style="font-size: 2rem; font-weight: bold;">${result.tissue_tiles || 0}</div>
                            </div>
                            <div style="background: linear-gradient(135deg, #FF9800 0%, #FFA726 100%); padding: 1.25rem; border-radius: 8px; color: white;">
                                <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Tissue Coverage</div>
                                <div style="font-size: 2rem; font-weight: bold;">${result.tissue_coverage?.toFixed(1) || 0}%</div>
                            </div>
                        </div>
                        ` : `
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
                            <div style="background: linear-gradient(135deg, #4CAF50 0%, #66BB6A 100%); padding: 1.25rem; border-radius: 8px; color: white;">
                                <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Total Cells</div>
                                <div style="font-size: 2rem; font-weight: bold;">${result.statistics?.total_cells || result.total_cells || 0}</div>
                            </div>
                            ${result.statistics?.cell_density_per_megapixel ? `
                            <div style="background: linear-gradient(135deg, #2196F3 0%, #42A5F5 100%); padding: 1.25rem; border-radius: 8px; color: white;">
                                <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Cell Density</div>
                                <div style="font-size: 2rem; font-weight: bold;">${result.statistics.cell_density_per_megapixel.toFixed(1)}</div>
                                <div style="font-size: 0.75rem; opacity: 0.8;">cells/MP</div>
                            </div>
                            ` : ''}
                            ${result.statistics?.tissue_coverage ? `
                            <div style="background: linear-gradient(135deg, #FF9800 0%, #FFA726 100%); padding: 1.25rem; border-radius: 8px; color: white;">
                                <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">Tissue Coverage</div>
                                <div style="font-size: 2rem; font-weight: bold;">${result.statistics.tissue_coverage.toFixed(1)}%</div>
                            </div>
                            ` : ''}
                        </div>
                        `}
                        
                        <!-- Download Visualization Section -->
                        ${hasVisualization ? `
                        <div style="margin-bottom: 1.5rem;">
                            <h3 style="margin: 0 0 1rem 0; font-size: 1.1rem; color: #333;">
                                <i class="fas fa-download"></i> Download Visualization
                            </h3>
                            <div style="display: flex; gap: 0.5rem; justify-content: flex-start; flex-wrap: wrap;">
                                <button class="btn-primary" onclick="event.stopPropagation(); downloadVisualizationLayer('${jobId}', 'combined')">
                                    <i class="fas fa-download"></i> Combined Image
                                </button>
                                <button class="btn-secondary" onclick="event.stopPropagation(); downloadVisualizationLayer('${jobId}', 'wsi')">
                                    <i class="fas fa-download"></i> WSI Only
                                </button>
                                <button class="btn-secondary" onclick="event.stopPropagation(); downloadVisualizationLayer('${jobId}', 'overlay')">
                                    <i class="fas fa-download"></i> Overlay Only
                                </button>
                            </div>
                            <p style="margin-top: 0.75rem; font-size: 0.875rem; color: #666;">
                                <i class="fas fa-info-circle"></i> Download visualization images to view cell segmentation results
                            </p>
                        </div>
                        ` : isTissueMask ? '' : `
                        <div style="margin-bottom: 1.5rem; padding: 1.5rem; background: #f8f8f8; border-radius: 8px; text-align: center; color: #999;">
                            <i class="fas fa-hourglass-half" style="font-size: 2rem; opacity: 0.5;"></i>
                            <p style="margin-top: 1rem;">Visualization is being generated...</p>
                            <p style="font-size: 0.875rem;">Refresh the page in a moment</p>
                        </div>
                        `}
                        
                        <!-- Tissue Mask Info -->
                        ${isTissueMask ? `
                        <div style="margin-bottom: 1.5rem; padding: 1rem; background: #e3f2fd; border-left: 4px solid #2196F3; border-radius: 4px;">
                            <h4 style="margin: 0 0 0.5rem 0; color: #1976D2;">
                                <i class="fas fa-info-circle"></i> About Tissue Mask
                            </h4>
                            <p style="margin: 0; font-size: 0.875rem; color: #555;">
                                This tissue mask identifies which tiles contain tissue vs. background. 
                                It's used to optimize segmentation by skipping empty tiles. 
                                The JSON data below contains coordinates and tissue detection results for each tile.
                            </p>
                        </div>
                        ` : ''}
                        
                        <!-- Download JSON -->
                        <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
                            <button class="btn-primary" onclick="downloadJobResult('${jobId}')">
                                <i class="fas fa-download"></i> Download JSON Result
                            </button>
                            <button class="btn-secondary" onclick="copyResultToClipboard()">
                                <i class="fas fa-copy"></i> Copy JSON
                            </button>
                        </div>
                        
                        <!-- JSON Data - Collapsed by default -->
                        <details>
                            <summary style="cursor: pointer; font-weight: 500; margin-bottom: 0.5rem; user-select: none; padding: 0.5rem; background: #f5f5f5; border-radius: 4px;">
                                <i class="fas fa-code"></i> View Raw JSON Data
                            </summary>
                            <pre id="resultJsonContent" style="background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.875rem; line-height: 1.5; margin-top: 0.5rem;"><code>${escapeHtml(JSON.stringify(result, null, 2))}</code></pre>
                        </details>
                    </div>
                </div>
            </div>
        `;
        
        // Remove existing result modal if any
        const existingModal = document.getElementById('resultModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        // Store result for clipboard copy
        window.currentJobResult = result;
        
        // Check job status and enable auto-refresh if still running
        const job = await apiCall(`/jobs/${jobId}`);
        if (job && (job.status === 'RUNNING' || job.status === 'PENDING')) {
            startVisualizationAutoRefresh(jobId);
        }
        
    } catch (error) {
        console.error('Failed to load result:', error);
        showToast('Failed to load result: ' + error.message, 'error');
    }
}

let visualizationRefreshInterval = null;

function startVisualizationAutoRefresh(jobId) {
    // Clear any existing interval
    if (visualizationRefreshInterval) {
        clearInterval(visualizationRefreshInterval);
    }
    
    console.log('Starting auto-refresh for visualization:', jobId);
    
    // Show auto-refresh badge
    const badge = document.getElementById('autoRefreshBadge');
    if (badge) {
        badge.style.display = 'block';
    }
    
    // Refresh visualization every 10 seconds
    visualizationRefreshInterval = setInterval(async () => {
        try {
            // Check if modal is still open
            const modal = document.getElementById('resultModal');
            if (!modal) {
                clearInterval(visualizationRefreshInterval);
                visualizationRefreshInterval = null;
                return;
            }
            
            // Check job status
            const job = await apiCall(`/jobs/${jobId}`);
            if (job && job.status === 'RUNNING') {
                // Reload visualization
                const vizImage = document.getElementById('vizImage');
                if (vizImage) {
                    const timestamp = new Date().getTime();
                    vizImage.src = `${API_BASE}/jobs/${jobId}/visualization?thumbnail=true&t=${timestamp}`;
                    console.log('Auto-refreshed visualization at', new Date().toLocaleTimeString());
                    
                    // Update last refresh time
                    const lastRefreshTime = document.getElementById('lastRefreshTime');
                    if (lastRefreshTime) {
                        const now = new Date();
                        lastRefreshTime.textContent = `Last updated: ${now.toLocaleTimeString()}`;
                    }
                }
            } else {
                // Job completed or failed, stop auto-refresh
                clearInterval(visualizationRefreshInterval);
                visualizationRefreshInterval = null;
                console.log('Job status changed, stopping auto-refresh');
                
                // Hide auto-refresh badge
                const badge = document.getElementById('autoRefreshBadge');
                if (badge) {
                    badge.style.display = 'none';
                }
                
                // Reload the full result to show final state
                if (job && job.status === 'SUCCEEDED') {
                    showToast('Job completed! Reloading final results...', 'success');
                    setTimeout(() => {
                        closeResultModal();
                        viewJobResult(jobId);
                    }, 1500);
                }
            }
        } catch (error) {
            console.error('Auto-refresh error:', error);
        }
    }, 10000); // Refresh every 10 seconds
}

function handleVizImageError(img, jobId) {
    console.error('Visualization image failed to load, retrying...');
    
    // Don't retry if already showing placeholder
    if (img.src.includes('data:image/svg')) {
        return;
    }
    
    // Retry once with cache-busting
    if (!img.dataset.retried) {
        img.dataset.retried = 'true';
        const timestamp = new Date().getTime();
        console.log('Retrying image load with fresh timestamp:', timestamp);
        setTimeout(() => {
            img.src = `${API_BASE}/jobs/${jobId}/visualization?thumbnail=true&t=${timestamp}&retry=1`;
        }, 500);
    } else {
        // Show placeholder after retry fails
        console.error('Image load failed after retry');
        img.onerror = null;
        img.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22%3E%3Crect fill=%22%23f0f0f0%22 width=%22400%22 height=%22300%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-family=%22Arial%22 font-size=%2216%22%3EVisualization not available%3C/text%3E%3Ctext x=%2250%25%22 y=%2260%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-family=%22Arial%22 font-size=%2212%22%3ETry clicking %22Reload Image%22%3C/text%3E%3C/svg%3E';
        img.style.cursor = 'default';
    }
}

function reloadVisualization(jobId) {
    const vizImage = document.getElementById('vizImage');
    const loadingIndicator = document.getElementById('vizImageLoading');
    
    if (vizImage && loadingIndicator) {
        loadingIndicator.style.display = 'block';
        // Clear retry flag
        delete vizImage.dataset.retried;
        // Add timestamp to force reload and bypass cache
        const timestamp = new Date().getTime();
        vizImage.src = `${API_BASE}/jobs/${jobId}/visualization?thumbnail=true&t=${timestamp}`;
        showToast('Reloading visualization...', 'info');
    }
}

function closeResultModal() {
    const modal = document.getElementById('resultModal');
    if (modal) {
        modal.remove();
    }
    window.currentJobResult = null;
    
    // Clear auto-refresh interval
    if (visualizationRefreshInterval) {
        clearInterval(visualizationRefreshInterval);
        visualizationRefreshInterval = null;
    }
}

function copyResultToClipboard() {
    if (window.currentJobResult) {
        const text = JSON.stringify(window.currentJobResult, null, 2);
        navigator.clipboard.writeText(text).then(() => {
            showToast('Result copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy:', err);
            showToast('Failed to copy to clipboard', 'error');
        });
    }
}

function viewFullVisualization(jobId) {
    // Create interactive visualization viewer with overlay toggle
    const viewerHTML = `
        <div id="vizViewerModal" class="modal active" style="z-index: 10000;">
            <div class="modal-content" style="max-width: 95vw; max-height: 95vh; width: 1400px;">
                <div class="modal-header">
                    <h2><i class="fas fa-image"></i> Interactive Visualization Viewer</h2>
                    <button class="modal-close" onclick="closeVizViewer()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body" style="max-height: calc(95vh - 120px); overflow: hidden; padding: 0;">
                    <!-- Control Panel -->
                    <div style="padding: 1rem; background: #f5f5f5; border-bottom: 1px solid #ddd;">
                        <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <label style="font-weight: 500; margin-right: 0.5rem;">
                                    <i class="fas fa-layer-group"></i> View Mode:
                                </label>
                                <button id="viewModeWSI" class="btn-secondary" onclick="switchViewMode('${jobId}', 'wsi')" style="font-size: 0.875rem;">
                                    <i class="fas fa-image"></i> Original WSI
                                </button>
                                <button id="viewModeCombined" class="btn-primary" onclick="switchViewMode('${jobId}', 'combined')" style="font-size: 0.875rem;">
                                    <i class="fas fa-layer-group"></i> WSI + Overlay
                                </button>
                                <button id="viewModeOverlay" class="btn-secondary" onclick="switchViewMode('${jobId}', 'overlay')" style="font-size: 0.875rem;">
                                    <i class="fas fa-vector-square"></i> Overlay Only
                                </button>
                            </div>
                            <div style="display: flex; gap: 0.5rem;">
                                <button class="btn-secondary" onclick="downloadVisualizationLayer('${jobId}', 'combined')" style="font-size: 0.875rem;">
                                    <i class="fas fa-download"></i> Download Combined
                                </button>
                                <button class="btn-secondary" onclick="downloadVisualizationLayer('${jobId}', 'overlay')" style="font-size: 0.875rem;">
                                    <i class="fas fa-download"></i> Download Overlay
                                </button>
                            </div>
                        </div>
                        <div style="margin-top: 0.75rem; padding: 0.5rem; background: #fff; border-radius: 4px; font-size: 0.875rem;">
                            <i class="fas fa-info-circle" style="color: #2196F3;"></i>
                            <strong>Interactive Viewer:</strong> Toggle between original WSI image, combined view with segmentation overlay, and overlay-only view. 
                            Colors indicate confidence levels: <span style="color: #00ff00;">⬤ High</span> <span style="color: #ffa500;">⬤ Medium</span> <span style="color: #ff0000;">⬤ Low</span>
                        </div>
                    </div>
                    
                    <!-- Image Display Area -->
                    <div style="padding: 1rem; text-align: center; overflow: auto; max-height: calc(95vh - 280px); background: #2a2a2a;">
                        <img id="vizViewerImage" 
                             src="${API_BASE}/jobs/${jobId}/visualization?layer=combined" 
                             style="max-width: 100%; height: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.3);"
                             alt="Cell Segmentation Visualization">
                        <div id="vizLoadingIndicator" style="display: none; margin-top: 1rem; color: #fff;">
                            <i class="fas fa-spinner fa-spin"></i> Loading...
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing viewer if any
    const existingViewer = document.getElementById('vizViewerModal');
    if (existingViewer) {
        existingViewer.remove();
    }
    
    // Add viewer to body
    document.body.insertAdjacentHTML('beforeend', viewerHTML);
}

function closeVizViewer() {
    const viewer = document.getElementById('vizViewerModal');
    if (viewer) {
        viewer.remove();
    }
}

function switchViewMode(jobId, mode) {
    // Update button states
    document.querySelectorAll('[id^="viewMode"]').forEach(btn => {
        btn.className = 'btn-secondary';
        btn.style.fontSize = '0.875rem';
    });
    
    const activeBtn = document.getElementById(`viewMode${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
    if (activeBtn) {
        activeBtn.className = 'btn-primary';
        activeBtn.style.fontSize = '0.875rem';
    }
    
    // Show loading indicator
    const loadingIndicator = document.getElementById('vizLoadingIndicator');
    const vizImage = document.getElementById('vizViewerImage');
    
    if (loadingIndicator) {
        loadingIndicator.style.display = 'block';
    }
    
    // Update image source
    const layerParam = mode === 'combined' ? 'combined' : mode;
    const imageUrl = `${API_BASE}/jobs/${jobId}/visualization?layer=${layerParam}`;
    
    if (vizImage) {
        vizImage.onload = () => {
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
        };
        vizImage.onerror = () => {
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
            showToast('Failed to load ' + mode + ' view', 'error');
        };
        vizImage.src = imageUrl;
    }
}

async function downloadVisualizationLayer(jobId, layer) {
    try {
        showToast(`Downloading ${layer} visualization...`, 'info');
        
        const response = await fetch(`${API_BASE}/jobs/${jobId}/visualization?layer=${layer}`, {
            headers: {
                'X-User-ID': currentUserId
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to download visualization');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `job_${jobId}_${layer}.png`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Visualization downloaded successfully!', 'success');
        
    } catch (error) {
        console.error('Failed to download visualization:', error);
        showToast('Failed to download visualization: ' + error.message, 'error');
    }
}

async function viewInProgressResult(jobId) {
    try {
        showToast('Loading in-progress results...', 'info');
        
        const response = await fetch(`${API_BASE}/jobs/${jobId}/intermediate`, {
            headers: {
                'X-User-ID': currentUserId
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to load in-progress results');
        }
        
        const result = await response.json();
        
        // Check if intermediate visualization is available
        const hasVisualization = result.cells && result.cells.length > 0;
        
        // Create in-progress viewer modal HTML
        const modalHTML = `
            <div id="inProgressModal" class="modal active">
                <div class="modal-content" style="max-width: 1200px; max-height: 90vh;">
                    <div class="modal-header">
                        <h2><i class="fas fa-hourglass-half"></i> In-Progress Segmentation Results</h2>
                        <button class="modal-close" onclick="closeInProgressModal()">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body" style="max-height: calc(90vh - 120px); overflow-y: auto;">
                        <div style="margin-bottom: 1rem; padding: 1rem; background: #e3f2fd; border-left: 4px solid #2196F3; border-radius: 4px;">
                            <strong><i class="fas fa-info-circle"></i> Processing Status:</strong> ${result.progress_percent?.toFixed(1) || 0}% complete<br>
                            <strong>Tiles Processed:</strong> ${result.tiles_processed || 0} / ${result.tiles_total || '-'}<br>
                            ${result.statistics ? `<strong>Cells Detected So Far:</strong> ${result.statistics.cells_so_far || 0}` : ''}
                        </div>
                        
                        ${hasVisualization ? `
                        <!-- Visualization Section -->
                        <div style="margin-bottom: 1.5rem; padding: 1rem; background: #f5f5f5; border-radius: 8px;">
                            <h3 style="margin: 0 0 1rem 0; display: flex; align-items: center; gap: 0.5rem;">
                                <i class="fas fa-image"></i> In-Progress Visualization
                            </h3>
                            <div style="text-align: center; margin-bottom: 1rem;">
                                <img src="${API_BASE}/jobs/${jobId}/intermediate/visualization?thumbnail=true" 
                                     style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); cursor: pointer;"
                                     onclick="viewFullInProgressVisualization('${jobId}')"
                                     alt="In-Progress Cell Segmentation"
                                     title="Click to view full resolution">
                            </div>
                            <div style="display: flex; gap: 0.5rem; justify-content: center;">
                                <button class="btn-primary" onclick="viewFullInProgressVisualization('${jobId}')" style="font-size: 0.875rem;">
                                    <i class="fas fa-expand"></i> Interactive Viewer
                                </button>
                                <button class="btn-secondary" onclick="refreshInProgressResult('${jobId}')" style="font-size: 0.875rem;">
                                    <i class="fas fa-sync-alt"></i> Refresh
                                </button>
                            </div>
                            <p style="margin-top: 0.75rem; font-size: 0.875rem; color: #666; text-align: center;">
                                <i class="fas fa-info-circle"></i> 
                                Showing ${result.statistics?.cells_so_far || 0} cells from ${result.statistics?.tiles_processed || 0} processed tiles
                            </p>
                        </div>
                        ` : `
                        <div style="padding: 2rem; text-align: center; color: #666;">
                            <i class="fas fa-hourglass-half" style="font-size: 3rem; margin-bottom: 1rem; color: #ccc;"></i>
                            <p>Processing started, visualization not yet available</p>
                            <button class="btn-secondary" onclick="refreshInProgressResult('${jobId}')" style="margin-top: 1rem;">
                                <i class="fas fa-sync-alt"></i> Refresh
                            </button>
                        </div>
                        `}
                        
                        <!-- JSON Data Preview -->
                        <details>
                            <summary style="cursor: pointer; font-weight: bold; margin-bottom: 0.5rem; user-select: none;">
                                <i class="fas fa-code"></i> Raw JSON Data (First 100 cells)
                            </summary>
                            <pre style="background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.875rem; line-height: 1.5; max-height: 400px;"><code>${escapeHtml(JSON.stringify({
                                ...result,
                                cells: result.cells ? result.cells.slice(0, 100) : []
                            }, null, 2))}</code></pre>
                        </details>
                    </div>
                </div>
            </div>
        `;
        
        // Remove existing modal if any
        const existingModal = document.getElementById('inProgressModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
    } catch (error) {
        console.error('Failed to load in-progress results:', error);
        showToast('In-progress results not yet available', 'warning');
    }
}

function closeInProgressModal() {
    const modal = document.getElementById('inProgressModal');
    if (modal) {
        modal.remove();
    }
}

function refreshInProgressResult(jobId) {
    closeInProgressModal();
    viewInProgressResult(jobId);
}

function viewFullInProgressVisualization(jobId) {
    // Create interactive visualization viewer for in-progress results
    const viewerHTML = `
        <div id="vizViewerModal" class="modal active" style="z-index: 10000;">
            <div class="modal-content" style="max-width: 95vw; max-height: 95vh; width: 1400px;">
                <div class="modal-header">
                    <h2><i class="fas fa-hourglass-half"></i> In-Progress Visualization Viewer</h2>
                    <button class="modal-close" onclick="closeVizViewer()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body" style="max-height: calc(95vh - 120px); overflow: hidden; padding: 0;">
                    <!-- Control Panel -->
                    <div style="padding: 1rem; background: #fffbf0; border-bottom: 1px solid #ffd54f; border-left: 4px solid #ff9800;">
                        <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <label style="font-weight: 500; margin-right: 0.5rem;">
                                    <i class="fas fa-layer-group"></i> View Mode:
                                </label>
                                <button id="viewModeWSI" class="btn-secondary" onclick="switchInProgressViewMode('${jobId}', 'wsi')" style="font-size: 0.875rem;">
                                    <i class="fas fa-image"></i> Original WSI
                                </button>
                                <button id="viewModeCombined" class="btn-primary" onclick="switchInProgressViewMode('${jobId}', 'combined')" style="font-size: 0.875rem;">
                                    <i class="fas fa-layer-group"></i> WSI + Overlay
                                </button>
                                <button id="viewModeOverlay" class="btn-secondary" onclick="switchInProgressViewMode('${jobId}', 'overlay')" style="font-size: 0.875rem;">
                                    <i class="fas fa-vector-square"></i> Overlay Only
                                </button>
                            </div>
                        </div>
                        <div style="margin-top: 0.75rem; padding: 0.5rem; background: #fff; border-radius: 4px; font-size: 0.875rem;">
                            <i class="fas fa-info-circle" style="color: #ff9800;"></i>
                            <strong>In-Progress Results:</strong> This shows cells that have been segmented so far. The job is still processing.
                        </div>
                    </div>
                    
                    <!-- Image Display Area -->
                    <div style="padding: 1rem; text-align: center; overflow: auto; max-height: calc(95vh - 280px); background: #2a2a2a;">
                        <img id="vizViewerImage" 
                             src="${API_BASE}/jobs/${jobId}/intermediate/visualization?layer=combined" 
                             style="max-width: 100%; height: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.3);"
                             alt="In-Progress Cell Segmentation">
                        <div id="vizLoadingIndicator" style="display: none; margin-top: 1rem; color: #fff;">
                            <i class="fas fa-spinner fa-spin"></i> Loading...
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing viewer if any
    const existingViewer = document.getElementById('vizViewerModal');
    if (existingViewer) {
        existingViewer.remove();
    }
    
    // Add viewer to body
    document.body.insertAdjacentHTML('beforeend', viewerHTML);
}

function switchInProgressViewMode(jobId, mode) {
    // Update button states
    document.querySelectorAll('[id^="viewMode"]').forEach(btn => {
        btn.className = 'btn-secondary';
        btn.style.fontSize = '0.875rem';
    });
    
    const activeBtn = document.getElementById(`viewMode${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
    if (activeBtn) {
        activeBtn.className = 'btn-primary';
        activeBtn.style.fontSize = '0.875rem';
    }
    
    // Show loading indicator
    const loadingIndicator = document.getElementById('vizLoadingIndicator');
    const vizImage = document.getElementById('vizViewerImage');
    
    if (loadingIndicator) {
        loadingIndicator.style.display = 'block';
    }
    
    // Update image source
    const layerParam = mode === 'combined' ? 'combined' : mode;
    const imageUrl = `${API_BASE}/jobs/${jobId}/intermediate/visualization?layer=${layerParam}`;
    
    if (vizImage) {
        vizImage.onload = () => {
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
        };
        vizImage.onerror = () => {
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
            showToast('Failed to load ' + mode + ' view', 'error');
        };
        vizImage.src = imageUrl;
    }
}

async function downloadVisualization(jobId) {
    try {
        showToast('Downloading visualization...', 'info');
        
        const response = await fetch(`${API_BASE}/jobs/${jobId}/visualization`, {
            headers: {
                'X-User-ID': currentUserId
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to download visualization');
        }
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `job_${jobId}_visualization.png`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Visualization downloaded successfully!', 'success');
        
    } catch (error) {
        console.error('Failed to download visualization:', error);
        showToast('Failed to download visualization: ' + error.message, 'error');
    }
}

function closeJobModal() {
    const modal = document.getElementById('jobModal');
    if (modal) {
        modal.classList.remove('active');
    }
    
    // Clear the refresh interval if it exists
    if (window.workflowDetailRefreshInterval) {
        clearInterval(window.workflowDetailRefreshInterval);
        window.workflowDetailRefreshInterval = null;
    }
    
    // Disconnect WebSocket (optional, can keep connected)
    // wsManager.disconnectAll();
}

// ============================================
// File Upload
// ============================================

async function handleFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    for (const file of files) {
        await uploadFile(file);
    }
    
    // Clear input
    event.target.value = '';
    
    // Refresh file list
    await loadUploadedFiles();
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        showToast(`Uploading ${file.name}...`, 'info');
        
        const response = await fetch(`${API_BASE}/upload`, {
            method: 'POST',
            headers: {
                'X-User-ID': currentUserId
            },
            body: formData
        });
        
        if (!response.ok) {
            throw new Error('Upload failed');
        }
        
        const result = await response.json();
        showToast(`${file.name} uploaded successfully!`, 'success');
        
        return result;
        
    } catch (error) {
        console.error('Upload error:', error);
        showToast(`Failed to upload ${file.name}`, 'error');
        throw error;
    }
}

async function loadUploadedFiles() {
    try {
        const response = await apiCall('/files');
        renderUploadedFiles(response.files);
    } catch (error) {
        console.error('Failed to load files:', error);
    }
}

function renderUploadedFiles(files) {
    const container = document.getElementById('uploadedFiles');
    
    if (!files || files.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    container.innerHTML = files.map(file => `
        <div class="uploaded-file-item">
            <div class="file-info">
                <i class="fas fa-file-image file-icon"></i>
                <div class="file-details">
                    <h4>${escapeHtml(file.filename)}</h4>
                    <p>${formatFileSize(file.size)} • ${new Date(file.modified * 1000).toLocaleDateString()}</p>
                </div>
            </div>
            <div class="file-actions">
                <button class="btn-icon" onclick="insertFilePath('${file.path}')" title="Use in workflow">
                    <i class="fas fa-plus-circle"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function insertFilePath(path) {
    const dagJson = document.getElementById('dagJson');
    const currentValue = dagJson.value;
    
    // Try to replace placeholder paths
    const updatedValue = currentValue.replace(
        /\/data\/uploads\/[^"]+/g,
        path
    );
    
    dagJson.value = updatedValue;
    previewDAG();
    showToast('File path inserted into DAG', 'success');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// ============================================
// Create Workflow
// ============================================

async function handleWorkflowSubmit(e) {
    e.preventDefault();
    
    const name = document.getElementById('workflowName').value.trim();
    const dagJson = document.getElementById('dagJson').value.trim();
    
    if (!name || !dagJson) {
        showToast('Please fill in all required fields', 'error');
        return;
    }
    
    let dag;
    try {
        dag = JSON.parse(dagJson);
    } catch (error) {
        showToast('Invalid JSON format in DAG configuration', 'error');
        return;
    }
    
    // Validate DAG and check file existence before submitting
    showToast('Validating workflow...', 'info');
    const isValid = await validateDAG();
    
    if (!isValid) {
        showToast('Please fix the validation errors before submitting', 'error');
        return;
    }
    
    try {
        const workflow = await apiCall('/workflows', {
            method: 'POST',
            body: JSON.stringify({ name, dag })
        });
        
        showToast(`Workflow "${name}" created successfully!`, 'success');
        
        // Connect WebSocket for real-time updates
        if (typeof wsManager !== 'undefined') {
            wsManager.connectToWorkflow(workflow.id);
        }
        
        // Clear form
        document.getElementById('workflowForm').reset();
        
        // Switch to workflows tab
        switchTab('workflows');
        
        // Refresh
        loadWorkflows();
        
    } catch (error) {
        console.error('Failed to create workflow:', error);
    }
}

async function validateDAG() {
    const dagJson = document.getElementById('dagJson').value.trim();
    
    if (!dagJson) {
        showToast('Please enter DAG configuration', 'warning');
        return false;
    }
    
    try {
        const dag = JSON.parse(dagJson);
        
        // Basic validation
        if (!dag.branches || typeof dag.branches !== 'object') {
            throw new Error('DAG must have a "branches" object');
        }
        
        // Extract all file paths from the DAG
        const filePaths = [];
        for (const branch of Object.values(dag.branches)) {
            for (const job of branch) {
                if (job.input_image_path) {
                    filePaths.push(job.input_image_path);
                }
            }
        }
        
        // Check if files exist
        if (filePaths.length > 0) {
            showToast('Checking if files exist...', 'info');
            
            const response = await fetch(`${API_BASE}/files/check`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-User-ID': currentUserId
                },
                body: JSON.stringify(filePaths)
            });
            
            if (!response.ok) {
                throw new Error('Failed to check file existence');
            }
            
            const fileResults = await response.json();
            const missingFiles = [];
            
            for (const [path, result] of Object.entries(fileResults)) {
                if (!result.exists) {
                    missingFiles.push(path);
                }
            }
            
            if (missingFiles.length > 0) {
                const fileList = missingFiles.map(f => `  • ${f}`).join('\n');
                showToast(`❌ Validation failed: The following files do not exist:\n${fileList}`, 'error');
                return false;
            }
        }
        
        const totalJobs = Object.values(dag.branches).reduce((sum, jobs) => sum + jobs.length, 0);
        
        showToast(`✓ DAG is valid! Found ${Object.keys(dag.branches).length} branches with ${totalJobs} jobs total. All files exist.`, 'success');
        
        previewDAG();
        return true;
    } catch (error) {
        showToast(`DAG validation failed: ${error.message}`, 'error');
        return false;
    }
}

function previewDAG() {
    const dagJson = document.getElementById('dagJson').value.trim();
    const preview = document.getElementById('dagPreview');
    
    if (!dagJson) {
        preview.innerHTML = '<p class="preview-placeholder">Enter DAG JSON to see visualization</p>';
        return;
    }
    
    try {
        const dag = JSON.parse(dagJson);
        
        if (!dag.branches) {
            throw new Error('Invalid DAG structure');
        }
        
        let html = '<div style="display: flex; gap: 2rem; flex-wrap: wrap;">';
        
        for (const [branchId, jobs] of Object.entries(dag.branches)) {
            html += `
                <div style="flex: 1; min-width: 200px;">
                    <h4 style="margin-bottom: 1rem; color: var(--primary);">
                        <i class="fas fa-code-branch"></i> ${branchId}
                    </h4>
            `;
            
            jobs.forEach((job, idx) => {
                html += `
                    <div style="background: white; padding: 1rem; margin-bottom: 0.5rem; border-radius: 8px; box-shadow: var(--shadow-sm);">
                        <strong>${idx + 1}. ${job.type}</strong><br>
                        <small style="color: var(--gray-500);">${job.input_image_path}</small>
                    </div>
                `;
                
                if (idx < jobs.length - 1) {
                    html += '<div style="text-align: center; margin: 0.5rem 0;"><i class="fas fa-arrow-down" style="color: var(--primary);"></i></div>';
                }
            });
            
            html += '</div>';
        }
        
        html += '</div>';
        preview.innerHTML = html;
        
    } catch (error) {
        preview.innerHTML = `<p style="color: var(--danger);">Invalid JSON format</p>`;
    }
}

// ============================================
// Templates & Examples
// ============================================

function handleExampleTabClick(e) {
    document.querySelectorAll('.example-tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    
    const example = e.target.getAttribute('data-example');
    loadExampleCode(example);
}

function loadExampleCode(type) {
    const codeBlock = document.getElementById('exampleCode');
    const examples = getExampleDAGs();
    
    if (examples[type]) {
        codeBlock.textContent = JSON.stringify(examples[type], null, 2);
    }
}

// ============================================
// Modal
// ============================================

function closeJobModal() {
    document.getElementById('jobModal').classList.remove('active');
}

// Close modal on background click
document.getElementById('jobModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'jobModal') {
        closeJobModal();
    }
});

// ============================================
// Auto Refresh
// ============================================

function startAutoRefresh() {
    // Refresh system status every 3 seconds
    setInterval(loadSystemStatus, 3000);
    
    // Refresh data every 5 seconds
    setInterval(() => {
        const activeTab = document.querySelector('.tab-panel.active');
        if (activeTab) {
            const tabId = activeTab.id;
            if (tabId === 'dashboard') {
                refreshAll();
            } else if (tabId === 'workflows') {
                loadWorkflows();
            } else if (tabId === 'jobs') {
                loadAllJobs();
            }
        }
    }, 5000);
}

function refreshAll() {
    loadSystemStatus();
    loadWorkflows();
    loadAllJobs();
}

// ============================================
// Toast Notifications
// ============================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };
    
    toast.innerHTML = `
        <i class="fas ${icons[type]}"></i>
        <span>${escapeHtml(message)}</span>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

