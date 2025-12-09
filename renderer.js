// State aplikasi
let isMonitoring = false;
let selectedFolder = null;
let hasLUT = false;
let currentPreviewPath = null;

// DOM Elements
const selectFolderBtn = document.getElementById('selectFolderBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const selectLUTBtn = document.getElementById('selectLUTBtn');
const removeLUTBtn = document.getElementById('removeLUTBtn');
const watchFolderDisplay = document.getElementById('watchFolderDisplay');
const lutDisplay = document.getElementById('lutDisplay');
const statusBadge = document.getElementById('statusBadge');
const totalFilesEl = document.getElementById('totalFiles');
const uploadedCountEl = document.getElementById('uploadedCount');
const queueSizeEl = document.getElementById('queueSize');
const logContainer = document.getElementById('logContainer'); // Deprecated - kept for compatibility
const logUpload = document.getElementById('logUpload');
const logSystem = document.getElementById('logSystem');
const apiUrlInput = document.getElementById('apiUrl');
const apiTokenInput = document.getElementById('apiToken');
const sessionCodeInput = document.getElementById('sessionCode');
const previewContainer = document.getElementById('previewContainer');
const previewBox = document.getElementById('previewBox');
const previewInfo = document.getElementById('previewInfo');

// Format waktu untuk log
function getTimeString() {
    const now = new Date();
    return now.toLocaleTimeString('id-ID', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });
}

// Tambah log message
function addLogMessage(type, message) {
    const logItem = document.createElement('div');
    logItem.className = `log-item log-${type}`;
    
    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️'
    };
    
    logItem.innerHTML = `
        <span>${icons[type] || 'ℹ️'}</span>
        <span><strong>[${getTimeString()}]</strong> ${message}</span>
    `;
    
    // Determine which container to use based on message content
    let targetContainer;
    const lowerMessage = message.toLowerCase();
    
    // Upload-related messages go to logUpload
    if (lowerMessage.includes('upload') || 
        lowerMessage.includes('terdeteksi') || 
        lowerMessage.includes('detected') ||
        lowerMessage.includes('file baru') ||
        lowerMessage.includes('ditambahkan') ||
        lowerMessage.includes('lut applied') ||
        lowerMessage.includes('lut berhasil') ||
        lowerMessage.includes('preview') ||
        type === 'success' ||
        type === 'error') {
        targetContainer = logUpload;
    } 
    // System messages go to logSystem
    else {
        targetContainer = logSystem;
    }
    
    // Fallback to logUpload if containers not found
    if (!targetContainer) {
        targetContainer = logUpload || logSystem;
    }
    
    if (targetContainer) {
        // Hapus empty state jika ada
        const emptyState = targetContainer.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }
        
        // Tambah log baru di atas
        targetContainer.insertBefore(logItem, targetContainer.firstChild);
        
        // Batasi jumlah log (max 50 per container)
        const logItems = targetContainer.querySelectorAll('.log-item');
        if (logItems.length > 50) {
            logItems[logItems.length - 1].remove();
        }
    }
}

// Update status badge
function updateStatusBadge(active) {
    if (active) {
        statusBadge.className = 'status-badge status-active';
        statusBadge.innerHTML = `
            <span class="status-dot"></span>
            Monitoring Aktif
        `;
    } else {
        statusBadge.className = 'status-badge status-inactive';
        statusBadge.innerHTML = `
            <span class="status-dot"></span>
            Monitoring Tidak Aktif
        `;
    }
}

// Update statistik
function updateStats(totalFiles, uploadedCount, queueSize = 0) {
    totalFilesEl.textContent = totalFiles || 0;
    uploadedCountEl.textContent = uploadedCount || 0;
    queueSizeEl.textContent = queueSize || 0;
    
    // Update warna badge queue
    const queueBadge = document.querySelector('.queue-badge');
    if (queueBadge) {
        if (queueSize > 0) {
            queueBadge.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
        } else {
            queueBadge.style.background = 'linear-gradient(135deg, #64748b 0%, #475569 100%)';
        }
    }
}

// Update folder display
function updateFolderDisplay(folderPath) {
    if (folderPath) {
        watchFolderDisplay.textContent = folderPath;
        watchFolderDisplay.classList.remove('empty');
    } else {
        watchFolderDisplay.textContent = 'Belum ada folder dipilih';
        watchFolderDisplay.classList.add('empty');
    }
}

// Update LUT display
function updateLUTDisplay(lutName) {
    if (lutName) {
        lutDisplay.textContent = lutName;
        lutDisplay.classList.remove('empty');
        hasLUT = true;
        removeLUTBtn.disabled = false;
        
        // Show preview container
        previewContainer.style.display = 'block';
    } else {
        lutDisplay.textContent = 'Belum ada LUT dipilih';
        lutDisplay.classList.add('empty');
        hasLUT = false;
        removeLUTBtn.disabled = true;
        
        // Hide preview container if no LUT
        if (!isMonitoring) {
            previewContainer.style.display = 'none';
        }
    }
}

// Update preview
function updatePreview(base64Image, fileName, hasLUTApplied) {
    if (base64Image) {
        previewBox.classList.remove('empty');
        previewBox.innerHTML = `
            <div>
                <img src="data:image/jpeg;base64,${base64Image}" alt="Preview">
                <div style="margin-top: 10px; font-size: 0.9rem; color: #64748b;">
                    ${fileName}
                </div>
                ${hasLUTApplied ? '<span class="lut-badge">🎨 LUT Applied</span>' : '<span class="lut-badge no-lut">No LUT</span>'}
            </div>
        `;
        previewInfo.style.display = 'block';
    } else {
        previewBox.classList.add('empty');
        previewBox.innerHTML = `
            <div class="preview-placeholder">
                Preview akan muncul saat ada foto baru terdeteksi
            </div>
        `;
        previewInfo.style.display = 'none';
    }
}

// Toggle buttons state
function toggleButtons(monitoring) {
    isMonitoring = monitoring;
    
    if (monitoring) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        selectFolderBtn.disabled = true;
        selectLUTBtn.disabled = true;
        removeLUTBtn.disabled = true;
        apiUrlInput.disabled = true;
        apiTokenInput.disabled = true;
        sessionCodeInput.disabled = true;
        
        // Show preview container when monitoring
        if (hasLUT) {
            previewContainer.style.display = 'block';
        }
    } else {
        startBtn.disabled = !selectedFolder;
        stopBtn.disabled = true;
        selectFolderBtn.disabled = false;
        selectLUTBtn.disabled = false;
        removeLUTBtn.disabled = !hasLUT;
        apiUrlInput.disabled = false;
        apiTokenInput.disabled = false;
        sessionCodeInput.disabled = false;
        
        // Clear preview when stopped
        updatePreview(null);
    }
    
    updateStatusBadge(monitoring);
}

// Event: Pilih Folder
selectFolderBtn.addEventListener('click', async () => {
    try {
        const result = await window.electronAPI.selectFolder();
        
        if (result.success) {
            selectedFolder = result.folderPath;
            updateFolderDisplay(selectedFolder);
            updateStats(result.totalFiles, result.uploadedCount, result.queueSize);
            addLogMessage('success', `Folder berhasil dipilih: ${selectedFolder}`);
            startBtn.disabled = false;
        }
    } catch (error) {
        addLogMessage('error', `Error memilih folder: ${error.message}`);
    }
});

// Event: Pilih LUT
selectLUTBtn.addEventListener('click', async () => {
    try {
        const result = await window.electronAPI.selectLUT();
        
        if (result.success) {
            updateLUTDisplay(result.lutName);
            addLogMessage('success', `LUT berhasil diupload: ${result.lutName}`);
        }
    } catch (error) {
        addLogMessage('error', `Error upload LUT: ${error.message}`);
    }
});

// Event: Hapus LUT
removeLUTBtn.addEventListener('click', async () => {
    if (!confirm('Apakah Anda yakin ingin menghapus LUT?')) {
        return;
    }
    
    try {
        const result = await window.electronAPI.removeLUT();
        
        if (result.success) {
            updateLUTDisplay(null);
            updatePreview(null);
            addLogMessage('info', 'LUT berhasil dihapus');
        }
    } catch (error) {
        addLogMessage('error', `Error hapus LUT: ${error.message}`);
    }
});

// Event: Mulai Monitoring
startBtn.addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim();
    
    if (!apiUrl) {
        addLogMessage('error', 'API URL harus diisi!');
        apiUrlInput.focus();
        return;
    }
    
    if (!selectedFolder) {
        addLogMessage('error', 'Pilih folder terlebih dahulu!');
        return;
    }
    
    try {
        const apiToken = apiTokenInput.value.trim();
        const sessionCode = sessionCodeInput.value.trim();
        
        const result = await window.electronAPI.startMonitoring({
            watchFolder: selectedFolder,
            apiUrl,
            apiToken,
            sessionCode
        });
        
        if (result.success) {
            toggleButtons(true);
            updateStats(result.totalFiles, result.uploadedCount, result.queueSize);
            addLogMessage('success', 'Monitoring dimulai! Aplikasi akan otomatis upload foto baru.');
        } else {
            addLogMessage('error', result.message);
        }
    } catch (error) {
        addLogMessage('error', `Error memulai monitoring: ${error.message}`);
    }
});

// Event: Stop Monitoring
stopBtn.addEventListener('click', async () => {
    try {
        const result = await window.electronAPI.stopMonitoring();
        
        if (result.success) {
            toggleButtons(false);
            addLogMessage('info', 'Monitoring dihentikan.');
            
            // Update stats
            const stats = await window.electronAPI.getStats();
            updateStats(stats.totalFiles, stats.uploadedCount, 0);
            
            // Clear preview
            updatePreview(null);
        } else {
            addLogMessage('error', result.message);
        }
    } catch (error) {
        addLogMessage('error', `Error menghentikan monitoring: ${error.message}`);
    }
});

// Event: Reset History
resetBtn.addEventListener('click', async () => {
    if (!confirm('Apakah Anda yakin ingin mereset history upload? Semua foto akan dianggap belum pernah diupload.')) {
        return;
    }
    
    try {
        const result = await window.electronAPI.resetHistory();
        
        if (result.success) {
            updateStats(result.totalFiles, result.uploadedCount, result.queueSize);
            addLogMessage('success', 'History upload berhasil direset!');
        } else {
            addLogMessage('error', result.message);
        }
    } catch (error) {
        addLogMessage('error', `Error reset history: ${error.message}`);
    }
});

// Listen untuk log messages dari main process
window.electronAPI.onLogMessage((data) => {
    addLogMessage(data.type, data.message);
    
    // Check if new file detected for preview
    if (isMonitoring && hasLUT && data.message.includes('File baru terdeteksi:')) {
        // Extract file name from message
        const match = data.message.match(/File baru terdeteksi: (.+)$/);
        if (match && match[1]) {
            const fileName = match[1];
            const filePath = selectedFolder + '/' + fileName;
            
            // Generate preview
            generatePreviewForFile(filePath, fileName);
        }
    }
});

// Generate preview for file
async function generatePreviewForFile(filePath, fileName) {
    try {
        const result = await window.electronAPI.generatePreview(filePath);
        
        if (result.success) {
            updatePreview(result.preview, fileName, result.hasLUT);
            currentPreviewPath = filePath;
        }
    } catch (error) {
        console.error('Error generating preview:', error);
    }
}

// Listen untuk update stats dari main process
window.electronAPI.onUpdateStats((data) => {
    updateStats(data.totalFiles, data.uploadedCount, data.queueSize);
});

// Load initial data saat aplikasi dibuka
window.addEventListener('DOMContentLoaded', async () => {
    try {
        // Load stats
        const stats = await window.electronAPI.getStats();
        updateStats(stats.totalFiles, stats.uploadedCount, stats.queueSize);
        
        // Load LUT info
        const lutInfo = await window.electronAPI.getLUTInfo();
        if (lutInfo.hasLUT) {
            updateLUTDisplay(lutInfo.lutName);
        }
    } catch (error) {
        console.error('Error loading initial data:', error);
    }
});

// Simpan konfigurasi ke localStorage
apiUrlInput.addEventListener('change', () => {
    localStorage.setItem('apiUrl', apiUrlInput.value);
});

apiTokenInput.addEventListener('change', () => {
    localStorage.setItem('apiToken', apiTokenInput.value);
});

sessionCodeInput.addEventListener('change', () => {
    localStorage.setItem('sessionCode', sessionCodeInput.value);
});

// Load dari localStorage
window.addEventListener('DOMContentLoaded', () => {
    const savedApiUrl = localStorage.getItem('apiUrl');
    const savedApiToken = localStorage.getItem('apiToken');
    const savedSessionCode = localStorage.getItem('sessionCode');
    
    if (savedApiUrl) {
        apiUrlInput.value = savedApiUrl;
    }
    
    if (savedApiToken) {
        apiTokenInput.value = savedApiToken;
    }
    
    if (savedSessionCode) {
        sessionCodeInput.value = savedSessionCode;
    }
});

// Update queue status setiap 2 detik
setInterval(async () => {
    if (isMonitoring) {
        try {
            const queueStatus = await window.electronAPI.getQueueStatus();
            const stats = await window.electronAPI.getStats();
            updateStats(stats.totalFiles, stats.uploadedCount, queueStatus.queueSize);
        } catch (error) {
            console.error('Error updating queue status:', error);
        }
    }
}, 2000);