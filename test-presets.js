// Test script untuk debug preset paths
// Run dengan: node test-presets.js

const path = require('path');
const fs = require('fs').promises;

async function testPresetPaths() {
    console.log('=== Testing Preset Paths ===\n');
    
    const possiblePaths = [
        // Development paths
        path.join(__dirname, 'presets', 'presets.json'),
        path.join(__dirname, '..', 'presets', 'presets.json'),
        // Other possible locations
        path.join(process.cwd(), 'presets', 'presets.json'),
    ];
    
    console.log('Current directory:', __dirname);
    console.log('Working directory:', process.cwd());
    console.log('\nTrying paths:\n');
    
    for (const testPath of possiblePaths) {
        try {
            await fs.access(testPath);
            const content = await fs.readFile(testPath, 'utf8');
            const data = JSON.parse(content);
            
            console.log('✅ SUCCESS:', testPath);
            console.log('   Presets found:', data.presets?.length || 0);
            console.log('   Categories found:', data.categories?.length || 0);
            console.log('');
            
            // Test preset files
            console.log('   Testing preset files:');
            for (const preset of data.presets) {
                if (preset.file) {
                    const folder = preset.type === 'cube' ? 'luts' : 'xmp';
                    const presetFilePath = path.join(path.dirname(testPath), folder, preset.file);
                    try {
                        await fs.access(presetFilePath);
                        console.log('   ✅', preset.name, '→', preset.file);
                    } catch (e) {
                        console.log('   ❌', preset.name, '→', preset.file, '(NOT FOUND)');
                    }
                }
            }
            console.log('');
            
            return; // Success, exit
            
        } catch (error) {
            console.log('❌ FAILED:', testPath);
            console.log('   Error:', error.message);
            console.log('');
        }
    }
    
    console.log('⚠️  No valid preset path found!');
}

testPresetPaths().catch(console.error);