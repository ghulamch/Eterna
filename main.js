const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const chokidar = require('chokidar');
const axios = require('axios');
const FormData = require('form-data');

// Configuration
const CONFIG = {
    maxRetries: 3,
    retryDelay: 3000,
    retryMultiplier: 1.5,
    concurrentUploads: 1
};

// State
let mainWindow;
let watcher = null;
let uploadQueue = [];
let uploadedFiles = new Set();
let isProcessing = false;
let currentSessionCode = null; // Track current session code
let stats = {
    totalFiles: 0,
    uploadedCount: 0,
    failedCount: 0
};

let config = {
    watchFolder: null,
    apiUrl: null,
    apiToken: null
};

// Create main window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        backgroundColor: '#E8E8E8'
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Helper: Send log to renderer
function sendLog(type, message) {
    if (mainWindow) {
        mainWindow.webContents.send('log-message', { type, message });
    }
}

// Helper: Update stats
function updateStats() {
    if (mainWindow) {
        mainWindow.webContents.send('update-stats', {
            totalFiles: stats.totalFiles,
            uploadedCount: stats.uploadedCount,
            queueSize: uploadQueue.length,
            currentSession: currentSessionCode
        });
    }
}

// Helper: Check if file is image
function isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
}

// Helper: Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Upload file to server (AUTO SESSION CODE dari API)
async function uploadFile(filePath, retryCount = 0) {
    try {
        const fileName = path.basename(filePath);
        
        // Check if already uploaded
        if (uploadedFiles.has(fileName)) {
            sendLog('info', `File sudah pernah diupload: ${fileName}`);
            return { success: true, alreadyUploaded: true };
        }

        sendLog('info', `📤 Mengupload ${fileName}...`);

        // Read file
        const fileBuffer = await fs.readFile(filePath);
        
        // Create form data (TANPA session_code, biarkan API auto-generate)
        const formData = new FormData();
        formData.append('photo', fileBuffer, {
            filename: fileName,
            contentType: 'image/jpeg'
        });

        // Upload
        const response = await axios.post(config.apiUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                ...(config.apiToken && { 'Authorization': `Bearer ${config.apiToken}` })
            },
            timeout: 30000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        // Check response
        if (response.data && response.data.success !== false) {
            const sessionCode = response.data.data.session_code;
            
            // Update current session code
            if (currentSessionCode !== sessionCode) {
                currentSessionCode = sessionCode;
                sendLog('info', `🎯 Session Code: ${sessionCode}`);
            }

            uploadedFiles.add(fileName);
            stats.uploadedCount++;
            updateStats();
            sendLog('success', `✅ Upload berhasil: ${fileName} → ${sessionCode}`);
            return { success: true, sessionCode };
        } else {
            throw new Error(response.data?.message || 'Upload failed');
        }

    } catch (error) {
        // Detailed error logging
        let errorMessage = error.message;
        
        if (error.response) {
            // Server responded with error
            const status = error.response.status;
            const data = error.response.data;
            
            if (status === 422) {
                // Validation error
                errorMessage = 'Validation Error: ';
                if (data.errors) {
                    errorMessage += Object.values(data.errors).flat().join(', ');
                } else if (data.message) {
                    errorMessage += data.message;
                }
            } else if (status === 401) {
                errorMessage = 'Authentication failed - Check Bearer token';
            } else {
                errorMessage = `Server error (${status}): ${data.message || error.message}`;
            }
        } else if (error.request) {
            // Request made but no response
            errorMessage = 'No response from server - Check API URL and network';
        }
        
        // Retry logic
        if (retryCount < CONFIG.maxRetries) {
            const delay = CONFIG.retryDelay * Math.pow(CONFIG.retryMultiplier, retryCount);
            sendLog('info', `⚠️ Upload gagal, retry ${retryCount + 1}/${CONFIG.maxRetries} dalam ${delay/1000}s...`);
            await sleep(delay);
            return uploadFile(filePath, retryCount + 1);
        }

        stats.failedCount++;
        sendLog('error', `❌ Upload gagal: ${path.basename(filePath)} - ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}

// Process upload queue
async function processQueue() {
    if (isProcessing || uploadQueue.length === 0) {
        return;
    }

    isProcessing = true;

    while (uploadQueue.length > 0) {
        const filePath = uploadQueue.shift();
        updateStats();

        try {
            await uploadFile(filePath);
        } catch (error) {
            sendLog('error', `Error processing ${path.basename(filePath)}: ${error.message}`);
        }

        // Small delay between uploads (500ms)
        await sleep(500);
    }

    isProcessing = false;
}

// Handle new file detected
async function handleNewFile(filePath) {
    const fileName = path.basename(filePath);

    // Check if image file
    if (!isImageFile(fileName)) {
        return;
    }

    // Wait a bit for file to be fully written
    await sleep(1000);

    // Check if file exists and readable
    try {
        await fs.access(filePath);
    } catch (error) {
        sendLog('error', `File tidak dapat diakses: ${fileName}`);
        return;
    }

    sendLog('info', `📸 File baru terdeteksi: ${fileName}`);

    // Add to queue
    uploadQueue.push(filePath);
    stats.totalFiles++;
    
    sendLog('info', `➕ Ditambahkan ke antrian (Total: ${uploadQueue.length})`);
    updateStats();

    // Process queue
    processQueue();
}

// IPC Handlers
ipcMain.handle('select-folder', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });

        if (result.canceled) {
            return { success: false };
        }

        const folderPath = result.filePaths[0];

        // Count existing images
        const files = await fs.readdir(folderPath);
        const imageFiles = files.filter(isImageFile);

        return {
            success: true,
            folderPath,
            totalFiles: stats.totalFiles,
            uploadedCount: stats.uploadedCount,
            queueSize: uploadQueue.length
        };

    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('start-monitoring', async (event, configData) => {
    try {
        if (watcher) {
            await watcher.close();
        }

        config.watchFolder = configData.watchFolder;
        config.apiUrl = configData.apiUrl;
        config.apiToken = configData.apiToken;

        if (!config.watchFolder) {
            throw new Error('Folder tidak dipilih');
        }

        // Validate API URL
        if (!config.apiUrl) {
            throw new Error('API URL harus diisi');
        }

        // Start watching
        watcher = chokidar.watch(config.watchFolder, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        watcher.on('add', handleNewFile);

        watcher.on('error', (error) => {
            sendLog('error', `Watcher error: ${error.message}`);
        });

        sendLog('info', '✅ Monitoring dimulai! Siap upload foto baru.');
        sendLog('info', `📡 API Endpoint: ${config.apiUrl}`);
        sendLog('info', '🔢 Session Code: AUTO (otomatis dari server)');

        return {
            success: true,
            totalFiles: stats.totalFiles,
            uploadedCount: stats.uploadedCount,
            queueSize: uploadQueue.length
        };

    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('stop-monitoring', async () => {
    try {
        if (watcher) {
            await watcher.close();
            watcher = null;
        }

        // Clear queue
        uploadQueue = [];
        isProcessing = false;
        currentSessionCode = null;

        sendLog('info', 'ℹ️ Monitoring dihentikan');

        return { success: true };

    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('reset-history', async () => {
    try {
        uploadedFiles.clear();
        currentSessionCode = null;
        stats = {
            totalFiles: 0,
            uploadedCount: 0,
            failedCount: 0
        };

        updateStats();
        sendLog('info', '🔄 History upload telah direset');

        return {
            success: true,
            totalFiles: stats.totalFiles,
            uploadedCount: stats.uploadedCount,
            queueSize: uploadQueue.length
        };

    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('get-stats', async () => {
    return {
        totalFiles: stats.totalFiles,
        uploadedCount: stats.uploadedCount,
        queueSize: uploadQueue.length,
        currentSession: currentSessionCode
    };
});

ipcMain.handle('get-queue-status', async () => {
    return {
        queueSize: uploadQueue.length,
        isProcessing,
        currentSession: currentSessionCode
    };
});