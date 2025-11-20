const fs = require('fs');
const path = require('path');
const https = require('https');

const MODELS_DIR = path.join(__dirname, 'models');
const BASE_URL = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model';

const MODELS = [
    // SSD MobileNet v1
    'ssd_mobilenetv1_model-weights_manifest.json',
    'ssd_mobilenetv1_model-shard1.bin',
    
    // Face Landmark 68
    'face_landmark_68_model-weights_manifest.json',
    'face_landmark_68_model-shard1.bin',
    
    // Face Recognition
    'face_recognition_model-weights_manifest.json',
    'face_recognition_model-shard1.bin',
    'face_recognition_model-shard2.bin'
];

// Create models directory if not exists
if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log('✅ Created models directory');
}

// Download file function
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// Download all models
async function downloadModels() {
    console.log('🤖 Downloading face-api.js models...\n');
    
    for (const model of MODELS) {
        const url = `${BASE_URL}/${model}`;
        const dest = path.join(MODELS_DIR, model);
        
        // Skip if already exists
        if (fs.existsSync(dest)) {
            console.log(`⏭️  ${model} already exists`);
            continue;
        }
        
        try {
            console.log(`📥 Downloading ${model}...`);
            await downloadFile(url, dest);
            console.log(`✅ Downloaded ${model}`);
        } catch (error) {
            console.error(`❌ Failed to download ${model}:`, error.message);
        }
    }
    
    console.log('\n✨ All models downloaded successfully!');
    console.log(`📁 Models saved to: ${MODELS_DIR}`);
}

// Run download
downloadModels().catch(console.error);