const { contextBridge, ipcRenderer } = require('electron');

// Expose API ke renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Pilih folder
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    
    // Start monitoring
    startMonitoring: (config) => ipcRenderer.invoke('start-monitoring', config),
    
    // Stop monitoring
    stopMonitoring: () => ipcRenderer.invoke('stop-monitoring'),
    
    // Reset history upload
    resetHistory: () => ipcRenderer.invoke('reset-history'),
    
    // Get statistik
    getStats: () => ipcRenderer.invoke('get-stats'),
    
    // Get queue status
    getQueueStatus: () => ipcRenderer.invoke('get-queue-status'),
    
    // Listen untuk log messages
    onLogMessage: (callback) => {
        ipcRenderer.on('log-message', (event, data) => callback(data));
    },
    
    // Listen untuk update stats
    onUpdateStats: (callback) => {
        ipcRenderer.on('update-stats', (event, data) => callback(data));
    }
});
