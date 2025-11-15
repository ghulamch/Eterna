// State aplikasi
let isMonitoring = false;
let selectedFolder = null;

// DOM Elements
const selectFolderBtn = document.getElementById('selectFolderBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const watchFolderDisplay = document.getElementById('watchFolderDisplay');
const statusBadge = document.getElementById('statusBadge');
const totalFilesEl = document.getElementById('totalFiles');
const uploadedCountEl = document.getElementById('uploadedCount');
const logContainer = document.getElementById('logContainer');
const apiUrlInput = document.getElementById('apiUrl');
const apiTokenInput = document.getElementById('apiToken');

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
    
    // Hapus empty state jika ada
    const emptyState = logContainer.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    // Tambah log baru di atas
    logContainer.insertBefore(logItem, logContainer.firstChild);
    
    // Batasi jumlah log (max 50)
    const logItems = logContainer.querySelectorAll('.log-item');
    if (logItems.length > 50) {
        logItems[logItems.length - 1].remove();
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
function updateStats(totalFiles, uploadedCount) {
    totalFilesEl.textContent = totalFiles;
    uploadedCountEl.textContent = uploadedCount;
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

// Toggle buttons state
function toggleButtons(monitoring) {
    isMonitoring = monitoring;
    
    if (monitoring) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        selectFolderBtn.disabled = true;
        apiUrlInput.disabled = true;
        apiTokenInput.disabled = true;
    } else {
        startBtn.disabled = !selectedFolder;
        stopBtn.disabled = true;
        selectFolderBtn.disabled = false;
        apiUrlInput.disabled = false;
        apiTokenInput.disabled = false;
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
            updateStats(result.totalFiles, result.uploadedCount);
            addLogMessage('success', `Folder berhasil dipilih: ${selectedFolder}`);
            
            // Enable start button
            startBtn.disabled = false;
        }
    } catch (error) {
        addLogMessage('error', `Error memilih folder: ${error.message}`);
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
        
        const result = await window.electronAPI.startMonitoring({
            apiUrl,
            apiToken
        });
        
        if (result.success) {
            toggleButtons(true);
            updateStats(result.totalFiles, result.uploadedCount);
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
            updateStats(result.totalFiles, result.uploadedCount);
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
});

// Listen untuk update stats dari main process
window.electronAPI.onUpdateStats((data) => {
    updateStats(data.totalFiles, data.uploadedCount);
});

// Load stats saat aplikasi dibuka
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const stats = await window.electronAPI.getStats();
        updateStats(stats.totalFiles, stats.uploadedCount);
    } catch (error) {
        console.error('Error loading stats:', error);
    }
});

// Simpan API URL ke localStorage
apiUrlInput.addEventListener('change', () => {
    localStorage.setItem('apiUrl', apiUrlInput.value);
});

apiTokenInput.addEventListener('change', () => {
    localStorage.setItem('apiToken', apiTokenInput.value);
});

// Load dari localStorage
window.addEventListener('DOMContentLoaded', () => {
    const savedApiUrl = localStorage.getItem('apiUrl');
    const savedApiToken = localStorage.getItem('apiToken');
    
    if (savedApiUrl) {
        apiUrlInput.value = savedApiUrl;
    }
    
    if (savedApiToken) {
        apiTokenInput.value = savedApiToken;
    }
});
