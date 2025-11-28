const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const chokidar = require('chokidar');
const axios = require('axios');
const FormData = require('form-data');

// Configuration
const CONFIG = {
    maxRetries: 3,
    retryDelay: 3000,
    retryMultiplier: 1.5,
    concurrentUploads: 1,
    scanInterval: 30000, // Scan setiap 30 detik
    dbPath: path.join(app.getPath('userData'), 'upload-queue.json')
};

// State
let mainWindow;
let tray = null;
let watcher = null;
let uploadQueue = [];
let uploadedFiles = new Set();
let isProcessing = false;
let currentSessionCode = null;
let scanIntervalId = null;
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

// ============================================
// PERSISTENT DATABASE FUNCTIONS
// ============================================

// Load queue dan uploaded files dari database
async function loadDatabase() {
    try {
        if (fsSync.existsSync(CONFIG.dbPath)) {
            const data = await fs.readFile(CONFIG.dbPath, 'utf8');
            const db = JSON.parse(data);
            
            uploadQueue = db.uploadQueue || [];
            uploadedFiles = new Set(db.uploadedFiles || []);
            stats = db.stats || { totalFiles: 0, uploadedCount: 0, failedCount: 0 };
            config = { ...config, ...db.config };
            currentSessionCode = db.currentSessionCode || null;
            
            sendLog('info', `📂 Loaded ${uploadQueue.length} items from queue, ${uploadedFiles.size} uploaded files`);
            
            // Auto-start jika ada config yang tersimpan
            if (config.watchFolder && config.apiUrl && uploadQueue.length > 0) {
                sendLog('info', '🔄 Auto-resuming monitoring from saved state...');
                setTimeout(() => startMonitoring(), 2000);
            }
        }
    } catch (error) {
        sendLog('error', `Error loading database: ${error.message}`);
    }
}

// Save queue dan uploaded files ke database
async function saveDatabase() {
    try {
        const db = {
            uploadQueue,
            uploadedFiles: Array.from(uploadedFiles),
            stats,
            config,
            currentSessionCode,
            lastSaved: new Date().toISOString()
        };
        
        await fs.writeFile(CONFIG.dbPath, JSON.stringify(db, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving database:', error);
    }
}

// Periodic save (setiap 10 detik)
setInterval(() => {
    if (uploadQueue.length > 0 || uploadedFiles.size > 0) {
        saveDatabase();
    }
}, 10000);

// ============================================
// SYSTEM TRAY FUNCTIONS
// ============================================

function createTray() {
    // Create tray icon (gunakan icon default dulu, bisa diganti dengan icon custom)
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open Photo Uploader',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createWindow();
                }
            }
        },
        { type: 'separator' },
        {
            label: `Monitoring: ${watcher ? 'Active' : 'Inactive'}`,
            enabled: false
        },
        {
            label: `Queue: ${uploadQueue.length} files`,
            enabled: false
        },
        {
            label: `Uploaded: ${stats.uploadedCount} files`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Start Monitoring',
            click: () => {
                if (config.watchFolder && config.apiUrl) {
                    startMonitoring();
                } else {
                    sendLog('error', 'Configure folder and API first!');
                }
            },
            enabled: !watcher
        },
        {
            label: 'Stop Monitoring',
            click: () => stopMonitoring(),
            enabled: !!watcher
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);
    
    tray.setToolTip('Photo Auto Uploader');
    tray.setContextMenu(contextMenu);
    
    // Double click untuk show window
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function updateTrayMenu() {
    if (!tray) return;
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open Photo Uploader',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createWindow();
                }
            }
        },
        { type: 'separator' },
        {
            label: `Monitoring: ${watcher ? '✅ Active' : '❌ Inactive'}`,
            enabled: false
        },
        {
            label: `Queue: ${uploadQueue.length} files`,
            enabled: false
        },
        {
            label: `Uploaded: ${stats.uploadedCount} files`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Start Monitoring',
            click: () => startMonitoring(),
            enabled: !watcher && config.watchFolder && config.apiUrl
        },
        {
            label: 'Stop Monitoring',
            click: () => stopMonitoring(),
            enabled: !!watcher
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);
    
    tray.setContextMenu(contextMenu);
}

// ============================================
// PERIODIC FOLDER SCAN
// ============================================

async function scanFolder() {
    if (!config.watchFolder) return;
    
    try {
        const files = await fs.readdir(config.watchFolder);
        let newFilesFound = 0;
        
        for (const fileName of files) {
            if (!isImageFile(fileName)) continue;
            
            // Skip jika sudah pernah diupload atau sudah di queue
            if (uploadedFiles.has(fileName)) continue;
            if (uploadQueue.some(queuePath => path.basename(queuePath) === fileName)) continue;
            
            const filePath = path.join(config.watchFolder, fileName);
            
            // Check if file exists and is readable
            try {
                const stat = await fs.stat(filePath);
                
                // Skip jika file terlalu baru (< 2 detik, mungkin masih di-copy)
                const fileAge = Date.now() - stat.mtimeMs;
                if (fileAge < 2000) continue;
                
                // Add to queue
                uploadQueue.push(filePath);
                stats.totalFiles++;
                newFilesFound++;
                
                sendLog('info', `🔍 Scan found new file: ${fileName}`);
            } catch (error) {
                // File tidak bisa diakses, skip
                continue;
            }
        }
        
        if (newFilesFound > 0) {
            sendLog('success', `✅ Scan complete: ${newFilesFound} new files added to queue`);
            updateStats();
            saveDatabase();
            processQueue();
        }
    } catch (error) {
        sendLog('error', `Scan error: ${error.message}`);
    }
}

function startPeriodicScan() {
    if (scanIntervalId) {
        clearInterval(scanIntervalId);
    }
    
    // Scan pertama kali
    scanFolder();
    
    // Kemudian scan berkala
    scanIntervalId = setInterval(scanFolder, CONFIG.scanInterval);
    sendLog('info', `🔄 Periodic scan started (every ${CONFIG.scanInterval/1000}s)`);
}

function stopPeriodicScan() {
    if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
        sendLog('info', '⏹️ Periodic scan stopped');
    }
}

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
        backgroundColor: '#E8E8E8',
        icon: path.join(__dirname, 'icon.png')
    });

    mainWindow.loadFile('index.html');
    
    // Handle close event - minimize to tray instead of quit
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            
            // Show notification pertama kali
            if (!mainWindow.hasShownTrayNotification) {
                sendLog('info', '📌 App minimized to system tray. Monitoring continues in background.');
                mainWindow.hasShownTrayNotification = true;
            }
            
            return false;
        }
    });
    
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    // Load database first
    await loadDatabase();
    
    // Create tray icon
    createTray();
    
    // Create window
    createWindow();
});

app.on('window-all-closed', () => {
    // Jangan quit di semua platform, biarkan app tetap berjalan di tray
    // User harus explicitly quit dari tray menu
});

app.on('activate', () => {
    if (mainWindow) {
        mainWindow.show();
    } else {
        createWindow();
    }
});

// Save database sebelum quit
app.on('before-quit', async () => {
    await saveDatabase();
    if (watcher) {
        await watcher.close();
    }
    stopPeriodicScan();
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
    
    // Update tray menu
    updateTrayMenu();
    
    // Save to database
    saveDatabase();
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
            saveDatabase(); // Save immediately after successful upload
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
        // Update config
        config.watchFolder = configData.watchFolder;
        config.apiUrl = configData.apiUrl;
        config.apiToken = configData.apiToken;
        
        // Validate
        if (!config.watchFolder) {
            throw new Error('Folder tidak dipilih');
        }
        if (!config.apiUrl) {
            throw new Error('API URL harus diisi');
        }
        
        // Start monitoring
        await startMonitoring();
        
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

async function startMonitoring() {
    try {
        if (watcher) {
            await watcher.close();
        }

        if (!config.watchFolder || !config.apiUrl) {
            throw new Error('Configuration incomplete');
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
        
        // Start periodic scan
        startPeriodicScan();

        sendLog('info', '✅ Monitoring dimulai! Siap upload foto baru.');
        sendLog('info', `📡 API Endpoint: ${config.apiUrl}`);
        sendLog('info', '📢 Session Code: AUTO (otomatis dari server)');
        sendLog('info', '🔄 Background monitoring active - app can run minimized');
        
        updateTrayMenu();
        saveDatabase();

    } catch (error) {
        throw error;
    }
}

ipcMain.handle('stop-monitoring', async () => {
    try {
        await stopMonitoring();
        
        return { success: true };

    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

async function stopMonitoring() {
    try {
        if (watcher) {
            await watcher.close();
            watcher = null;
        }

        // Stop periodic scan
        stopPeriodicScan();

        // Clear queue (OPTIONAL - bisa dikomen jika mau keep queue)
        // uploadQueue = [];
        isProcessing = false;
        // currentSessionCode = null; // Keep session code

        sendLog('info', 'ℹ️ Monitoring dihentikan');
        sendLog('info', `📦 Queue preserved: ${uploadQueue.length} files`);
        
        updateTrayMenu();
        saveDatabase();

    } catch (error) {
        throw error;
    }
}

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