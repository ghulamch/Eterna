const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const chokidar = require('chokidar');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const xml2js = require('xml2js');

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
let currentXMP = null; // XMP preset
let xmpData = null; // Parsed XMP adjustments
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
        
        // Apply XMP if available
        if (xmpData) {
            const tempPath = path.join(app.getPath('temp'), 'preview-temp.jpg');
            const tempOutputPath = path.join(app.getPath('temp'), 'preview-processed.jpg');
            
            await fs.writeFile(tempPath, processedBuffer);
            await applyXMPToImage(tempPath, tempOutputPath, xmpData);
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
            hasLUT: !!lutData,
            hasXMP: !!xmpData
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// ============================================
// XMP FUNCTIONS
// ============================================

// Parse XMP file
async function parseXMP(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const parser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true
        });
        
        const result = await parser.parseStringPromise(content);
        
        // Navigate XMP structure to find Camera Raw/Lightroom settings
        let crsSettings = {};
        
        // Try to find crs (Camera Raw Settings) namespace
        if (result['x:xmpmeta'] && result['x:xmpmeta']['rdf:RDF'] && result['x:xmpmeta']['rdf:RDF']['rdf:Description']) {
            const desc = result['x:xmpmeta']['rdf:RDF']['rdf:Description'];
            
            // Extract all crs: prefixed attributes
            for (const key in desc) {
                if (key.startsWith('crs:')) {
                    const cleanKey = key.replace('crs:', '');
                    crsSettings[cleanKey] = parseFloat(desc[key]) || desc[key];
                }
            }
        }
        
        const adjustments = convertXMPToAdjustments(crsSettings);
        
        sendLog('success', `✅ XMP loaded: ${path.basename(filePath)}`);
        
        return adjustments;
    } catch (error) {
        sendLog('error', `Failed to parse XMP: ${error.message}`);
        throw error;
    }
}

// Convert XMP Camera Raw settings to our adjustment format
function convertXMPToAdjustments(crsSettings) {
    // Default adjustments
    const adjustments = {
        exposure: 0,        // -5.0 to +5.0
        contrast: 0,        // -100 to +100
        highlights: 0,      // -100 to +100
        shadows: 0,         // -100 to +100
        whites: 0,          // -100 to +100
        blacks: 0,          // -100 to +100
        vibrance: 0,        // -100 to +100
        saturation: 0,      // -100 to +100
        temperature: 0,     // -100 to +100 (Kelvin simplified)
        tint: 0,            // -100 to +100
        clarity: 0,         // -100 to +100
        dehaze: 0           // -100 to +100
    };
    
    // Map XMP values to our adjustments
    if (crsSettings.Exposure2012 !== undefined) {
        adjustments.exposure = parseFloat(crsSettings.Exposure2012);
    }
    if (crsSettings.Contrast2012 !== undefined) {
        adjustments.contrast = parseFloat(crsSettings.Contrast2012);
    }
    if (crsSettings.Highlights2012 !== undefined) {
        adjustments.highlights = parseFloat(crsSettings.Highlights2012);
    }
    if (crsSettings.Shadows2012 !== undefined) {
        adjustments.shadows = parseFloat(crsSettings.Shadows2012);
    }
    if (crsSettings.Whites2012 !== undefined) {
        adjustments.whites = parseFloat(crsSettings.Whites2012);
    }
    if (crsSettings.Blacks2012 !== undefined) {
        adjustments.blacks = parseFloat(crsSettings.Blacks2012);
    }
    if (crsSettings.Vibrance !== undefined) {
        adjustments.vibrance = parseFloat(crsSettings.Vibrance);
    }
    if (crsSettings.Saturation !== undefined) {
        adjustments.saturation = parseFloat(crsSettings.Saturation);
    }
    if (crsSettings.Temperature !== undefined) {
        // Convert Kelvin (typically 2000-50000) to -100 to +100
        const temp = parseFloat(crsSettings.Temperature);
        adjustments.temperature = ((temp - 6500) / 100); // Neutral is 6500K
    }
    if (crsSettings.Tint !== undefined) {
        adjustments.tint = parseFloat(crsSettings.Tint);
    }
    if (crsSettings.Clarity2012 !== undefined) {
        adjustments.clarity = parseFloat(crsSettings.Clarity2012);
    }
    if (crsSettings.Dehaze !== undefined) {
        adjustments.dehaze = parseFloat(crsSettings.Dehaze);
    }
    
    return adjustments;
}

// Apply XMP adjustments to image
async function applyXMPToImage(inputPath, outputPath, adjustments) {
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
            let r = data[i];
            let g = data[i + 1];
            let b = data[i + 2];
            
            // Apply adjustments
            [r, g, b] = applyXMPAdjustments(r, g, b, adjustments);
            
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            
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
        console.error('Error applying XMP:', error);
        throw error;
    }
}

// Apply XMP adjustments to a single pixel
function applyXMPAdjustments(r, g, b, adj) {
    // Convert RGB to HSL for some adjustments
    const [h, s, l] = rgbToHsl(r, g, b);
    
    // 1. Exposure (-5 to +5, multiply by 2^exposure)
    if (adj.exposure !== 0) {
        const expFactor = Math.pow(2, adj.exposure);
        r *= expFactor;
        g *= expFactor;
        b *= expFactor;
    }
    
    // 2. Contrast (-100 to +100)
    if (adj.contrast !== 0) {
        const contrastFactor = (adj.contrast + 100) / 100;
        r = ((r / 255 - 0.5) * contrastFactor + 0.5) * 255;
        g = ((g / 255 - 0.5) * contrastFactor + 0.5) * 255;
        b = ((b / 255 - 0.5) * contrastFactor + 0.5) * 255;
    }
    
    // 3. Highlights (-100 to +100) - affect bright areas
    if (adj.highlights !== 0) {
        const brightness = (r + g + b) / 3;
        if (brightness > 128) {
            const factor = 1 + (adj.highlights / 100) * ((brightness - 128) / 127);
            r *= factor;
            g *= factor;
            b *= factor;
        }
    }
    
    // 4. Shadows (-100 to +100) - affect dark areas
    if (adj.shadows !== 0) {
        const brightness = (r + g + b) / 3;
        if (brightness < 128) {
            const factor = 1 + (adj.shadows / 100) * ((128 - brightness) / 128);
            r *= factor;
            g *= factor;
            b *= factor;
        }
    }
    
    // 5. Saturation (-100 to +100)
    if (adj.saturation !== 0) {
        const gray = r * 0.299 + g * 0.587 + b * 0.114;
        const satFactor = 1 + (adj.saturation / 100);
        r = gray + (r - gray) * satFactor;
        g = gray + (g - gray) * satFactor;
        b = gray + (b - gray) * satFactor;
    }
    
    // 6. Vibrance (-100 to +100) - smart saturation
    if (adj.vibrance !== 0) {
        const avg = (r + g + b) / 3;
        const maxChannel = Math.max(r, g, b);
        const minChannel = Math.min(r, g, b);
        const saturation = maxChannel > 0 ? (maxChannel - minChannel) / maxChannel : 0;
        
        // Vibrance affects less saturated colors more
        const vibFactor = 1 + (adj.vibrance / 100) * (1 - saturation);
        r = avg + (r - avg) * vibFactor;
        g = avg + (g - avg) * vibFactor;
        b = avg + (b - avg) * vibFactor;
    }
    
    // 7. Temperature & Tint (simplified)
    if (adj.temperature !== 0) {
        const tempFactor = adj.temperature / 100;
        if (tempFactor > 0) {
            r += tempFactor * 30;
            b -= tempFactor * 30;
        } else {
            r += tempFactor * 30;
            b -= tempFactor * 30;
        }
    }
    
    if (adj.tint !== 0) {
        const tintFactor = adj.tint / 100;
        g += tintFactor * 30;
    }
    
    // Clamp values to 0-255
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));
    
    return [r, g, b];
}

// Helper: RGB to HSL conversion
function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    
    return [h * 360, s * 100, l * 100];
}

// Helper: HSL to RGB conversion
function hslToRgb(h, s, l) {
    h /= 360;
    s /= 100;
    l /= 100;
    
    let r, g, b;
    
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    
    return [
        Math.round(r * 255),
        Math.round(g * 255),
        Math.round(b * 255)
    ];
}

// ============================================
// PRESET LIBRARY FUNCTIONS
// ============================================

// Load preset library from bundled presets.json
async function loadPresetLibrary() {
    // Try multiple paths for development and production
    const possiblePaths = [
        // Production (packaged)
        path.join(process.resourcesPath, 'app.asar.unpacked', 'presets', 'presets.json'),
        path.join(process.resourcesPath, 'presets', 'presets.json'),
        // Development
        path.join(__dirname, 'presets', 'presets.json'),
        path.join(__dirname, '..', 'presets', 'presets.json'),
        // Fallback
        path.join(app.getAppPath(), 'presets', 'presets.json')
    ];
    
    for (const presetsPath of possiblePaths) {
        try {
            console.log('Trying preset path:', presetsPath);
            
            // Check if file exists
            await fs.access(presetsPath);
            
            // Read and parse
            const content = await fs.readFile(presetsPath, 'utf8');
            const library = JSON.parse(content);
            
            console.log('✅ Preset library loaded from:', presetsPath);
            console.log('Loaded presets:', library.presets.length);
            
            return library;
        } catch (error) {
            console.log('❌ Failed to load from:', presetsPath, error.message);
            continue;
        }
    }
    
    // If all paths fail, return default fallback
    console.error('⚠️ Could not load preset library from any path. Using fallback.');
    sendLog('error', 'Failed to load preset library - using defaults');
    
    return {
        presets: [
            {
                id: "none",
                name: "No Filter",
                type: "none",
                file: null,
                description: "Original colors, no grading applied",
                category: "default",
                thumbnail: null
            }
        ],
        categories: [
            {
                id: "default",
                name: "Default",
                icon: "fa-circle"
            }
        ]
    };
}

// Apply preset by ID
async function applyPreset(presetId) {
    try {
        const library = await loadPresetLibrary();
        const preset = library.presets.find(p => p.id === presetId);
        
        if (!preset) {
            throw new Error('Preset not found');
        }
        
        // Clear current filters
        currentLUT = null;
        lutData = null;
        currentXMP = null;
        xmpData = null;
        
        if (preset.type === 'none') {
            // No filter
            sendLog('info', '⭕ No filter applied');
            saveDatabase();
            updateTrayMenu();
            return {
                success: true,
                preset: preset
            };
        }
        
        // Find preset file with multiple path attempts
        const presetFolder = preset.type === 'cube' ? 'luts' : 'xmp';
        
        const possibleBasePaths = [
            // Production
            path.join(process.resourcesPath, 'app.asar.unpacked', 'presets'),
            path.join(process.resourcesPath, 'presets'),
            // Development
            path.join(__dirname, 'presets'),
            path.join(__dirname, '..', 'presets'),
            // Fallback
            path.join(app.getAppPath(), 'presets')
        ];
        
        let presetPath = null;
        for (const basePath of possibleBasePaths) {
            const testPath = path.join(basePath, presetFolder, preset.file);
            try {
                await fs.access(testPath);
                presetPath = testPath;
                console.log('✅ Found preset file at:', presetPath);
                break;
            } catch (error) {
                console.log('❌ Preset not found at:', testPath);
                continue;
            }
        }
        
        if (!presetPath) {
            throw new Error(`Preset file not found: ${preset.file}`);
        }
        
        // Parse based on type
        if (preset.type === 'cube') {
            lutData = await parseCubeLUT(presetPath);
            currentLUT = presetPath;
            sendLog('success', `🎨 Preset applied: ${preset.name} (CUBE)`);
        } else if (preset.type === 'xmp') {
            xmpData = await parseXMP(presetPath);
            currentXMP = presetPath;
            sendLog('success', `🎨 Preset applied: ${preset.name} (XMP)`);
        }
        
        saveDatabase();
        updateTrayMenu();
        
        return {
            success: true,
            preset: preset
        };
        
    } catch (error) {
        console.error('Error applying preset:', error);
        sendLog('error', `Failed to apply preset: ${error.message}`);
        return {
            success: false,
            message: error.message
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
            label: `Filter: ${currentLUT ? '✅ CUBE' : (currentXMP ? '✅ XMP' : '❌ None')}`,
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
            sendLog('info', `🎨 CUBE LUT applied to: ${fileName}`);
        }
        
        // Apply XMP if available (and no LUT)
        if (xmpData && !lutData) {
            const tempOutputPath = path.join(app.getPath('temp'), `processed-${fileName}`);
            await applyXMPToImage(filePath, tempOutputPath, xmpData);
            uploadPath = tempOutputPath;
            sendLog('info', `🎨 XMP Preset applied to: ${fileName}`);
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
        
        // Cleanup temp file if LUT/XMP was applied
        if ((lutData || xmpData) && uploadPath !== filePath) {
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

// Get preset library
ipcMain.handle('get-preset-library', async () => {
    try {
        const library = await loadPresetLibrary();
        return {
            success: true,
            library: library
        };
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

// Apply preset by ID
ipcMain.handle('apply-preset', async (event, presetId) => {
    return await applyPreset(presetId);
});

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
                { name: 'Color Grading Files', extensions: ['cube', 'xmp'] },
                { name: 'LUT Files', extensions: ['cube'] },
                { name: 'XMP Presets', extensions: ['xmp'] }
            ]
        });

        if (result.canceled) {
            return { success: false };
        }

        const filePath = result.filePaths[0];
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).toLowerCase();
        
        // Copy file to app directory
        const destPath = path.join(CONFIG.lutPath, fileName);
        await fs.copyFile(filePath, destPath);
        
        // Parse based on file type
        if (fileExt === '.cube') {
            // Clear XMP if switching to CUBE
            currentXMP = null;
            xmpData = null;
            
            // Parse CUBE LUT
            lutData = await parseCubeLUT(destPath);
            currentLUT = destPath;
            
            sendLog('success', `🎨 CUBE LUT loaded: ${fileName}`);
        } else if (fileExt === '.xmp') {
            // Clear CUBE if switching to XMP
            currentLUT = null;
            lutData = null;
            
            // Parse XMP preset
            xmpData = await parseXMP(destPath);
            currentXMP = destPath;
            
            sendLog('success', `🎨 XMP Preset loaded: ${fileName}`);
        }
        
        saveDatabase();
        updateTrayMenu();
        
        return {
            success: true,
            lutPath: destPath,
            lutName: fileName,
            fileType: fileExt === '.cube' ? 'CUBE' : 'XMP'
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
        currentXMP = null;
        xmpData = null;
        
        saveDatabase();
        updateTrayMenu();
        
        sendLog('info', '🗑️ Color grading removed');
        
        return { success: true };
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
});

ipcMain.handle('get-lut-info', async () => {
    const hasFilter = !!(currentLUT || currentXMP);
    const filterName = currentLUT 
        ? path.basename(currentLUT) 
        : (currentXMP ? path.basename(currentXMP) : null);
    const filterType = currentLUT ? 'CUBE' : (currentXMP ? 'XMP' : null);
    
    return {
        hasLUT: hasFilter,
        lutName: filterName,
        filterType: filterType
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
            sendLog('info', `🎨 CUBE LUT Active: ${path.basename(currentLUT)}`);
        } else if (currentXMP) {
            sendLog('info', `🎨 XMP Preset Active: ${path.basename(currentXMP)}`);
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