const { contextBridge, ipcRenderer } = require('electron');

// Expose API ke renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Pilih folder
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    
    // Preset operations
    getPresetLibrary: () => ipcRenderer.invoke('get-preset-library'),
    applyPreset: (presetId) => ipcRenderer.invoke('apply-preset', presetId),
    
    // LUT operations
    selectLUT: () => ipcRenderer.invoke('select-lut'),
    removeLUT: () => ipcRenderer.invoke('remove-lut'),
    getLUTInfo: () => ipcRenderer.invoke('get-lut-info'),
    
    // Preview generation
    generatePreview: (imagePath) => ipcRenderer.invoke('generate-preview', imagePath),
    
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
    
    // Preview window operations
    openPreview: () => ipcRenderer.invoke('open-preview'),
    closePreview: () => ipcRenderer.invoke('close-preview'),
    getUploadedPhotos: () => ipcRenderer.invoke('get-uploaded-photos'),
    
    // Listen untuk log messages
    onLogMessage: (callback) => {
        ipcRenderer.on('log-message', (event, data) => callback(data));
    },
    
    // Listen untuk update stats
    onUpdateStats: (callback) => {
        ipcRenderer.on('update-stats', (event, data) => callback(data));
    },
    
    // Listen untuk photos data (preview window)
    onPhotosData: (callback) => {
        ipcRenderer.on('photos-data', (event, data) => callback(data));
    },
    
    // Listen untuk new photo (preview window)
    onNewPhoto: (callback) => {
        ipcRenderer.on('new-photo', (event, data) => callback(data));
    }
});