const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const axios = require('axios');
const FormData = require('form-data');

let mainWindow;
let watcher = null;
let uploadedFilesPath;
let watchFolder = null;
let apiUrl = null;
let apiToken = null;

// Konfigurasi retry
const RETRY_CONFIG = {
    maxRetries: 3,        // Maksimal 3 kali retry
    retryDelay: 3000,     // Delay 3 detik antar retry
    retryMultiplier: 1.5  // Multiplier untuk exponential backoff (opsional)
};

// File untuk menyimpan history upload
function getUploadedFilesPath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'uploaded-files.json');
}

// Baca file yang sudah diupload
function getUploadedFiles() {
    try {
        if (fs.existsSync(uploadedFilesPath)) {
            const data = fs.readFileSync(uploadedFilesPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading uploaded files:', error);
    }
    return [];
}

// Simpan file yang sudah diupload
function saveUploadedFile(filename) {
    try {
        const uploadedFiles = getUploadedFiles();
        if (!uploadedFiles.includes(filename)) {
            uploadedFiles.push(filename);
            fs.writeFileSync(uploadedFilesPath, JSON.stringify(uploadedFiles, null, 2));
        }
    } catch (error) {
        console.error('Error saving uploaded file:', error);
    }
}

// Helper function untuk delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Upload foto ke Laravel API dengan retry
async function uploadPhoto(filePath, retryCount = 0) {
    try {
        const filename = path.basename(filePath);
        const uploadedFiles = getUploadedFiles();
        
        // Skip jika sudah pernah diupload
        if (uploadedFiles.includes(filename)) {
            return { success: false, message: 'File sudah pernah diupload', skip: true };
        }

        // Baca file
        const fileBuffer = fs.readFileSync(filePath);
        const formData = new FormData();
        
        formData.append('photo', fileBuffer, {
            filename: filename,
            contentType: `image/${path.extname(filename).slice(1)}`
        });

        // Konfigurasi request
        const config = {
            headers: {
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 30000 // 30 detik timeout
        };

        // Tambahkan bearer token jika ada
        if (apiToken && apiToken.trim() !== '') {
            config.headers['Authorization'] = `Bearer ${apiToken}`;
        }

        // Upload ke API
        const response = await axios.post(apiUrl, formData, config);
        
        // Simpan ke history jika berhasil
        if (response.status === 200 || response.status === 201) {
            saveUploadedFile(filename);
            return { 
                success: true, 
                message: `Berhasil upload ${filename}`,
                data: response.data 
            };
        }

        return { 
            success: false, 
            message: `Upload gagal: ${response.statusText}` 
        };

    } catch (error) {
        console.error('Upload error (attempt ' + (retryCount + 1) + '):', error.message);
        
        // Cek apakah perlu retry
        if (retryCount < RETRY_CONFIG.maxRetries) {
            // Hitung delay dengan exponential backoff
            const delayTime = RETRY_CONFIG.retryDelay * Math.pow(RETRY_CONFIG.retryMultiplier, retryCount);
            
            // Informasikan retry ke user
            const filename = path.basename(filePath);
            mainWindow.webContents.send('log-message', {
                type: 'info',
                message: `Upload gagal untuk ${filename}. Retry ${retryCount + 1}/${RETRY_CONFIG.maxRetries} dalam ${Math.round(delayTime / 1000)} detik...`
            });
            
            // Tunggu sebelum retry
            await delay(delayTime);
            
            // Retry upload
            return uploadPhoto(filePath, retryCount + 1);
        }
        
        // Sudah mencapai max retry, return error
        const errorMessage = error.response?.data?.message || error.message;
        return { 
            success: false, 
            message: `Error setelah ${RETRY_CONFIG.maxRetries} kali percobaan: ${errorMessage}`,
            finalError: true
        };
    }
}

// Cek apakah file adalah foto
function isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
}

// Hitung total file di folder
function countTotalFiles() {
    if (!watchFolder || !fs.existsSync(watchFolder)) {
        return 0;
    }
    
    try {
        const files = fs.readdirSync(watchFolder);
        return files.filter(file => {
            const filePath = path.join(watchFolder, file);
            return fs.statSync(filePath).isFile() && isImageFile(file);
        }).length;
    } catch (error) {
        console.error('Error counting files:', error);
        return 0;
    }
}

// Start monitoring folder
function startWatching() {
    if (!watchFolder) {
        return { success: false, message: 'Folder belum dipilih' };
    }

    if (!apiUrl) {
        return { success: false, message: 'API URL belum diisi' };
    }

    // Stop watcher yang ada
    if (watcher) {
        watcher.close();
    }

    // Start watcher baru
    watcher = chokidar.watch(watchFolder, {
        persistent: true,
        ignoreInitial: true, // Jangan process file yang sudah ada
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100
        }
    });

    // Event ketika ada file baru
    watcher.on('add', async (filePath) => {
        const filename = path.basename(filePath);
        
        // Hanya process file gambar
        if (!isImageFile(filename)) {
            return;
        }

        mainWindow.webContents.send('log-message', {
            type: 'info',
            message: `📸 File baru terdeteksi: ${filename}`
        });

        // Upload foto (dengan auto retry jika gagal)
        const result = await uploadPhoto(filePath);
        
        if (result.skip) {
            mainWindow.webContents.send('log-message', {
                type: 'info',
                message: `⏭️ ${result.message}`
            });
        } else if (result.success) {
            mainWindow.webContents.send('log-message', {
                type: 'success',
                message: `✅ ${result.message}`
            });
            
            // Update statistik
            const totalFiles = countTotalFiles();
            const uploadedCount = getUploadedFiles().length;
            mainWindow.webContents.send('update-stats', { totalFiles, uploadedCount });
        } else {
            // Tentukan tipe log berdasarkan apakah ini final error atau bukan
            const logType = result.finalError ? 'error' : 'info';
            mainWindow.webContents.send('log-message', {
                type: logType,
                message: `❌ ${result.message}`
            });
        }
    });

    watcher.on('error', (error) => {
        mainWindow.webContents.send('log-message', {
            type: 'error',
            message: `Watcher error: ${error.message}`
        });
    });

    return { success: true, message: 'Monitoring dimulai' };
}

// Stop monitoring
function stopWatching() {
    if (watcher) {
        watcher.close();
        watcher = null;
        return { success: true, message: 'Monitoring dihentikan' };
    }
    return { success: false, message: 'Monitoring tidak aktif' };
}

// Create window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.png')
    });

    mainWindow.loadFile('index.html');
    
    // Buka DevTools di development mode
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

// App ready
app.whenReady().then(() => {
    uploadedFilesPath = getUploadedFilesPath();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Quit app
app.on('window-all-closed', () => {
    if (watcher) {
        watcher.close();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        watchFolder = result.filePaths[0];
        const totalFiles = countTotalFiles();
        const uploadedCount = getUploadedFiles().length;
        
        return {
            success: true,
            folderPath: watchFolder,
            totalFiles,
            uploadedCount
        };
    }

    return { success: false };
});

ipcMain.handle('start-monitoring', async (event, config) => {
    apiUrl = config.apiUrl;
    apiToken = config.apiToken;
    
    const result = startWatching();
    
    if (result.success) {
        const totalFiles = countTotalFiles();
        const uploadedCount = getUploadedFiles().length;
        return { ...result, totalFiles, uploadedCount };
    }
    
    return result;
});

ipcMain.handle('stop-monitoring', async () => {
    return stopWatching();
});

ipcMain.handle('reset-history', async () => {
    try {
        fs.writeFileSync(uploadedFilesPath, JSON.stringify([], null, 2));
        const totalFiles = countTotalFiles();
        return { 
            success: true, 
            message: 'History upload berhasil direset',
            totalFiles,
            uploadedCount: 0
        };
    } catch (error) {
        return { 
            success: false, 
            message: `Error reset history: ${error.message}` 
        };
    }
});

ipcMain.handle('get-stats', async () => {
    const totalFiles = countTotalFiles();
    const uploadedCount = getUploadedFiles().length;
    return { totalFiles, uploadedCount };
});
