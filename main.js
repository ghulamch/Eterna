const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const chokidar = require('chokidar');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

// Configuration
const CONFIG = {
    maxRetries: 3,
    retryDelay: 3000,
    retryMultiplier: 1.5,
    concurrentUploads: 1,
    scanInterval: 5000, // Scan lebih sering: setiap 5 detik
    dbPath: path.join(app.getPath('userData'), 'upload-queue.json'),
    lutPath: path.join(app.getPath('userData'), 'luts')
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
let currentLUT = null;
let lutData = null;
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
// LUT FUNCTIONS
// ============================================

// Ensure LUT directory exists
async function ensureLUTDirectory() {
    try {
        await fs.mkdir(CONFIG.lutPath, { recursive: true });
    } catch (error) {
        console.error('Error creating LUT directory:', error);
    }
}

// Parse .cube LUT file
async function parseCubeLUT(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        
        let lutSize = 0;
        let lutTable = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            // Skip comments and empty lines
            if (trimmed.startsWith('#') || trimmed.startsWith('TITLE') || trimmed === '') {
                continue;
            }
            
            // Get LUT size
            if (trimmed.startsWith('LUT_3D_SIZE')) {
                lutSize = parseInt(trimmed.split(' ')[1]);
                continue;
            }
            
            // Parse color values
            const values = trimmed.split(/\s+/).map(v => parseFloat(v));
            if (values.length === 3 && !isNaN(values[0])) {
                lutTable.push(values);
            }
        }
        
        if (lutSize === 0 || lutTable.length === 0) {
            throw new Error('Invalid LUT file format');
        }
        
        sendLog('success', `✅ LUT loaded: ${path.basename(filePath)} (${lutSize}x${lutSize}x${lutSize})`);
        
        return {
            size: lutSize,
            table: lutTable
        };
    } catch (error) {
        sendLog('error', `Failed to parse LUT: ${error.message}`);
        throw error;
    }
}

// Apply LUT to image using trilinear interpolation
function applyLUTToPixel(r, g, b, lutData) {
    const size = lutData.size;
    const table = lutData.table;
    
    // Normalize RGB to 0-1 range
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;
    
    // Map to LUT grid coordinates
    const rIndex = rNorm * (size - 1);
    const gIndex = gNorm * (size - 1);
    const bIndex = bNorm * (size - 1);
    
    // Get integer and fractional parts
    const r0 = Math.floor(rIndex);
    const g0 = Math.floor(gIndex);
    const b0 = Math.floor(bIndex);
    
    const r1 = Math.min(r0 + 1, size - 1);
    const g1 = Math.min(g0 + 1, size - 1);
    const b1 = Math.min(b0 + 1, size - 1);
    
    const rFrac = rIndex - r0;
    const gFrac = gIndex - g0;
    const bFrac = bIndex - b0;
    
    // Trilinear interpolation (8 corners of cube)
    const getColor = (ri, gi, bi) => {
        const index = ri + gi * size + bi * size * size;
        return table[index] || [0, 0, 0];
    };
    
    const c000 = getColor(r0, g0, b0);
    const c001 = getColor(r0, g0, b1);
    const c010 = getColor(r0, g1, b0);
    const c011 = getColor(r0, g1, b1);
    const c100 = getColor(r1, g0, b0);
    const c101 = getColor(r1, g0, b1);
    const c110 = getColor(r1, g1, b0);
    const c111 = getColor(r1, g1, b1);
    
    // Interpolate
    const c00 = [
        c000[0] * (1 - rFrac) + c100[0] * rFrac,
        c000[1] * (1 - rFrac) + c100[1] * rFrac,
        c000[2] * (1 - rFrac) + c100[2] * rFrac
    ];
    
    const c01 = [
        c001[0] * (1 - rFrac) + c101[0] * rFrac,
        c001[1] * (1 - rFrac) + c101[1] * rFrac,
        c001[2] * (1 - rFrac) + c101[2] * rFrac
    ];
    
    const c10 = [
        c010[0] * (1 - rFrac) + c110[0] * rFrac,
        c010[1] * (1 - rFrac) + c110[1] * rFrac,
        c010[2] * (1 - rFrac) + c110[2] * rFrac
    ];
    
    const c11 = [
        c011[0] * (1 - rFrac) + c111[0] * rFrac,
        c011[1] * (1 - rFrac) + c111[1] * rFrac,
        c011[2] * (1 - rFrac) + c111[2] * rFrac
    ];
    
    const c0 = [
        c00[0] * (1 - gFrac) + c10[0] * gFrac,
        c00[1] * (1 - gFrac) + c10[1] * gFrac,
        c00[2] * (1 - gFrac) + c10[2] * gFrac
    ];
    
    const c1 = [
        c01[0] * (1 - gFrac) + c11[0] * gFrac,
        c01[1] * (1 - gFrac) + c11[1] * gFrac,
        c01[2] * (1 - gFrac) + c11[2] * gFrac
    ];
    
    const result = [
        c0[0] * (1 - bFrac) + c1[0] * bFrac,
        c0[1] * (1 - bFrac) + c1[1] * bFrac,
        c0[2] * (1 - bFrac) + c1[2] * bFrac
    ];
    
    // Convert back to 0-255 range and clamp
    return result.map(v => Math.max(0, Math.min(255, Math.round(v * 255))));
}

// Apply LUT to entire image
async function applyLUTToImage(inputPath, outputPath, lutData) {
    try {
        // Read image
        const image = sharp(inputPath);
        const metadata = await image.metadata();
        const { data, info } = await image
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        // Process pixels
        const pixels = new Uint8Array(data.length);
        const channels = info.channels;
        
        for (let i = 0; i < data.length; i += channels) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            const [newR, newG, newB] = applyLUTToPixel(r, g, b, lutData);
            
            pixels[i] = newR;
            pixels[i + 1] = newG;
            pixels[i + 2] = newB;
            
            if (channels === 4) {
                pixels[i + 3] = data[i + 3]; // Preserve alpha
            }
        }
        
        // Save processed image
        await sharp(pixels, {
            raw: {
                width: info.width,
                height: info.height,
                channels: channels
            }
        })
        .jpeg({ quality: 95 })
        .toFile(outputPath);
        
        return true;
    } catch (error) {
        console.error('Error applying LUT:', error);
        throw error;
    }
}

// Generate preview with LUT
async function generatePreview(imagePath) {
    try {
        // Create preview (max 800px width)
        const previewBuffer = await sharp(imagePath)
            .resize(800, null, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 85 })
            .toBuffer();
        
        let processedBuffer = previewBuffer;
        
        // Apply LUT if available
        if (lutData) {
            const tempPath = path.join(app.getPath('temp'), 'preview-temp.jpg');
            const tempOutputPath = path.join(app.getPath('temp'), 'preview-processed.jpg');
            
            await fs.writeFile(tempPath, previewBuffer);
            await applyLUTToImage(tempPath, tempOutputPath, lutData);
            processedBuffer = await fs.readFile(tempOutputPath);
            
            // Cleanup temp files
            try {
                await fs.unlink(tempPath);
                await fs.unlink(tempOutputPath);
            } catch (e) {}
        }
        
        return {
            success: true,
            preview: processedBuffer.toString('base64'),
            hasLUT: !!lutData
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

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
            currentLUT = db.currentLUT || null;
            
            // Load LUT if exists
            if (currentLUT) {
                try {
                    lutData = await parseCubeLUT(currentLUT);
                } catch (e) {
                    currentLUT = null;
                }
            }
            
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
            currentLUT,
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
    // Create tray icon
    const iconPath = path.join(__dirname, 'icon.png');
    let icon;
    
    if (fsSync.existsSync(iconPath)) {
        icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
        // Create default icon if file doesn't exist
        icon = nativeImage.createEmpty();
    }
    
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
    
    tray.setToolTip('Photo Auto Uploader - Memora');
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
        {
            label: `LUT: ${currentLUT ? '✅ Active' : '❌ None'}`,
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
// PERIODIC FOLDER SCAN - IMPROVED
// ============================================

async function scanFolder() {
    if (!config.watchFolder) return;
    
    try {
        const files = await fs.readdir(config.watchFolder);
        let newFilesFound = 0;
        const processedFiles = [];
        
        for (const fileName of files) {
            if (!isImageFile(fileName)) continue;
            
            // Skip jika sudah pernah diupload
            if (uploadedFiles.has(fileName)) continue;
            
            // Skip jika sudah di queue
            const filePath = path.join(config.watchFolder, fileName);
            if (uploadQueue.includes(filePath)) continue;
            if (processedFiles.includes(filePath)) continue;
            
            // Check if file exists and is readable
            try {
                const stat = await fs.stat(filePath);
                
                // Skip jika file terlalu baru (< 1 detik, mungkin masih di-copy)
                const fileAge = Date.now() - stat.mtimeMs;
                if (fileAge < 1000) continue;
                
                // Add to queue
                uploadQueue.push(filePath);
                processedFiles.push(filePath);
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
    
    // Kemudian scan berkala (setiap 5 detik untuk deteksi lebih cepat)
    scanIntervalId = setInterval(scanFolder, CONFIG.scanInterval);
    sendLog('info', `🔄 Periodic scan started (every ${CONFIG.scanInterval/1000}s)`);
}

function stopPeriodicScan() {
    if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
        sendLog('info', '⏸️ Periodic scan stopped');
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function sendLog(type, message) {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-message', { type, message });
    }
}

function updateStats() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-stats', {
            totalFiles: stats.totalFiles,
            uploadedCount: stats.uploadedCount,
            queueSize: uploadQueue.length
        });
    }
    updateTrayMenu();
}

function isImageFile(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// UPLOAD FUNCTIONS
// ============================================

async function uploadFile(filePath, retryCount = 0) {
    const fileName = path.basename(filePath);
    
    // Skip if already uploaded
    if (uploadedFiles.has(fileName)) {
        sendLog('info', `⏭️ Skipped (already uploaded): ${fileName}`);
        return { success: true, skipped: true };
    }

    try {
        sendLog('info', `📤 Uploading: ${fileName}...`);
        
        let uploadPath = filePath;
        
        // Apply LUT if available
        if (lutData) {
            const tempOutputPath = path.join(app.getPath('temp'), `processed-${fileName}`);
            await applyLUTToImage(filePath, tempOutputPath, lutData);
            uploadPath = tempOutputPath;
            sendLog('info', `🎨 LUT applied to: ${fileName}`);
        }

        // Read file
        const fileBuffer = await fs.readFile(uploadPath);
        const fileStats = await fs.stat(filePath);
        
        // Create form data
        const formData = new FormData();
        formData.append('photo', fileBuffer, {
            filename: fileName,
            contentType: 'image/jpeg'
        });

        // Add session code if available
        if (currentSessionCode) {
            formData.append('session_code', currentSessionCode);
        }

        // Prepare headers
        const headers = {
            ...formData.getHeaders()
        };

        // Add bearer token if available
        if (config.apiToken) {
            headers['Authorization'] = `Bearer ${config.apiToken}`;
        }

        // Upload request
        const response = await axios.post(config.apiUrl, formData, {
            headers,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 60000
        });

        // Mark as uploaded
        uploadedFiles.add(fileName);
        stats.uploadedCount++;

        // Update session code from response
        if (response.data && response.data.session_code && !currentSessionCode) {
            currentSessionCode = response.data.session_code;
            sendLog('info', `📝 Session code: ${currentSessionCode}`);
        }

        sendLog('success', `✅ Upload berhasil: ${fileName}`);
        updateStats();
        saveDatabase();
        
        // Cleanup temp file if LUT was applied
        if (lutData && uploadPath !== filePath) {
            try {
                await fs.unlink(uploadPath);
            } catch (e) {}
        }

        return { success: true };

    } catch (error) {
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
        sendLog('error', `❌ Upload gagal: ${fileName} - ${errorMessage}`);
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
        const filePath = uploadQueue[0]; // Peek first item
        const fileName = path.basename(filePath);
        
        // Check if file still exists
        try {
            await fs.access(filePath);
        } catch (error) {
            sendLog('error', `File not found, removing from queue: ${fileName}`);
            uploadQueue.shift();
            updateStats();
            continue;
        }
        
        updateStats();

        try {
            const result = await uploadFile(filePath);
            
            // Only remove from queue if successfully uploaded or skipped
            if (result.success) {
                uploadQueue.shift();
            } else {
                // Failed upload, keep in queue but move to end
                uploadQueue.shift();
                uploadQueue.push(filePath);
                
                // Add delay before next attempt
                await sleep(5000);
            }
        } catch (error) {
            sendLog('error', `Error processing ${fileName}: ${error.message}`);
            uploadQueue.shift(); // Remove problematic file
        }

        // Small delay between uploads
        await sleep(500);
    }

    isProcessing = false;
    updateStats();
}

// Handle new file detected
async function handleNewFile(filePath) {
    const fileName = path.basename(filePath);

    // Check if image file
    if (!isImageFile(fileName)) {
        return;
    }

    // Check if already in queue or uploaded
    if (uploadQueue.includes(filePath)) {
        return;
    }
    
    if (uploadedFiles.has(fileName)) {
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
    saveDatabase();

    // Process queue
    processQueue();
}

// ============================================
// WINDOW MANAGEMENT
// ============================================

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.png')
    });

    mainWindow.loadFile('index.html');

    // Prevent window from closing, minimize to tray instead
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            
            if (watcher) {
                sendLog('info', '🔔 App minimized to tray - monitoring still active');
            }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ============================================
// IPC HANDLERS
// ============================================

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

ipcMain.handle('select-lut', async () => {
    try {
        await ensureLUTDirectory();
        
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'LUT Files', extensions: ['cube'] }
            ]
        });

        if (result.canceled) {
            return { success: false };
        }

        const lutPath = result.filePaths[0];
        const lutFileName = path.basename(lutPath);
        
        // Copy LUT to app directory
        const destPath = path.join(CONFIG.lutPath, lutFileName);
        await fs.copyFile(lutPath, destPath);
        
        // Parse LUT
        lutData = await parseCubeLUT(destPath);
        currentLUT = destPath;
        
        saveDatabase();
        updateTrayMenu();
        
        return {
            success: true,
            lutPath: destPath,
            lutName: lutFileName
        };

    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('remove-lut', async () => {
    try {
        currentLUT = null;
        lutData = null;
        
        saveDatabase();
        updateTrayMenu();
        
        sendLog('info', '🗑️ LUT removed');
        
        return { success: true };
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('get-lut-info', async () => {
    return {
        hasLUT: !!currentLUT,
        lutName: currentLUT ? path.basename(currentLUT) : null
    };
});

ipcMain.handle('generate-preview', async (event, imagePath) => {
    return await generatePreview(imagePath);
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

        // Start watching with improved settings
        watcher = chokidar.watch(config.watchFolder, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 1000,
                pollInterval: 100
            },
            usePolling: true, // Use polling for better detection
            interval: 100,
            binaryInterval: 300
        });

        watcher.on('add', handleNewFile);

        watcher.on('error', (error) => {
            sendLog('error', `Watcher error: ${error.message}`);
        });
        
        // Start periodic scan
        startPeriodicScan();

        sendLog('info', '✅ Monitoring dimulai! Siap upload foto baru.');
        sendLog('info', `📡 API Endpoint: ${config.apiUrl}`);
        
        if (currentLUT) {
            sendLog('info', `🎨 LUT Active: ${path.basename(currentLUT)}`);
        }
        
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

        isProcessing = false;

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

// ============================================
// APP LIFECYCLE
// ============================================

app.whenReady().then(async () => {
    await ensureLUTDirectory();
    await loadDatabase();
    createTray();
    createWindow();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    } else if (mainWindow) {
        mainWindow.show();
    }
});

app.on('before-quit', () => {
    app.isQuitting = true;
});

app.on('window-all-closed', () => {
    // Don't quit app on window close - keep running in tray
    // Only quit when user explicitly quits from tray
});