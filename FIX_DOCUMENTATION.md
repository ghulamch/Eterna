# 🔧 FIX ERROR 422 - Laravel API Compatibility

## 🔍 Masalah yang Ditemukan

### Error 422 (Unprocessable Entity)

Error ini terjadi karena **ketidakcocokan field antara Electron app dan Laravel API**.

### Penyebab:

1. **Field `session_code` Missing**
   - Laravel API requires: `session_code` (required)
   - Electron app hanya send: `photo` only
   - Result: Validation error 422

2. **URL Endpoint Berbeda**
   - Electron default: `/api/upload-photo`
   - Laravel API: `/api/photos/upload`

---

## ✅ Solusi yang Diterapkan

### 1. **Update main.js**

#### Perubahan Upload Function:

**BEFORE (ERROR):**
```javascript
const formData = new FormData();
formData.append('photo', fileBuffer, {
    filename: fileName,
    contentType: 'image/jpeg'
});
// ❌ Tidak ada session_code!
```

**AFTER (FIXED):**
```javascript
// Generate session code otomatis
const sessionCode = config.sessionCode || 
    `AUTO_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

const formData = new FormData();
formData.append('photo', fileBuffer, {
    filename: fileName,
    contentType: 'image/jpeg'
});
formData.append('session_code', sessionCode); // ✅ Session code added!
```

#### Enhanced Error Handling:

```javascript
if (error.response) {
    const status = error.response.status;
    
    if (status === 422) {
        // Detailed validation error
        errorMessage = 'Validation Error: ';
        if (data.errors) {
            errorMessage += Object.values(data.errors).flat().join(', ');
        }
    } else if (status === 401) {
        errorMessage = 'Authentication failed - Check Bearer token';
    }
}
```

### 2. **Update index.html**

#### Added Session Code Field:

```html
<div class="form-group">
    <label>Session Code <span class="label-optional">(Opsional)</span></label>
    <input type="text" id="sessionCode" placeholder="EVENT_001 atau kosongkan untuk auto-generate">
    <small class="form-hint">Kosongkan untuk auto-generate berdasarkan timestamp</small>
</div>
```

#### Updated Default API URL:

```html
<!-- OLD -->
<input type="text" id="apiUrl" value="http://localhost:8000/api/upload-photo">

<!-- NEW -->
<input type="text" id="apiUrl" value="http://localhost:8000/api/photos/upload">
```

### 3. **Update renderer.js**

#### Save/Load Session Code:

```javascript
const sessionCode = sessionCodeInput.value.trim();

const result = await window.electronAPI.startMonitoring({
    watchFolder: selectedFolder,
    apiUrl,
    apiToken,
    sessionCode  // ✅ Added
});
```

---

## 🚀 Cara Menggunakan Versi Fixed

### 1. Install Dependencies

```bash
cd electron-photo-uploader-fixed
npm install
```

### 2. Setup Laravel Backend

Pastikan Laravel backend sudah running:

```bash
php artisan serve
```

Generate API token (opsional untuk testing):

```bash
php artisan tinker
```

```php
$token = App\Models\ApiToken::generate('Electron Upload Token');
echo $token->token;
exit
```

### 3. Jalankan Electron App

```bash
npm start
```

### 4. Konfigurasi di Aplikasi

1. **Pilih Folder** yang akan dimonitor
2. **API URL**: `http://localhost:8000/api/photos/upload` (sudah default)
3. **Bearer Token**: Paste token dari Laravel (optional)
4. **Session Code**: 
   - Isi manual (misal: `EVENT_001`, `WEDDING_2024`)
   - Atau kosongkan untuk auto-generate (misal: `AUTO_lnx5w_4K2M9P`)
5. Klik **"Mulai"**

### 5. Test Upload

1. Copy foto ke folder yang dimonitor
2. Lihat log aktivitas:
   ```
   📸 File baru terdeteksi: IMG_001.jpg
   ➕ Ditambahkan ke antrian (Total: 1)
   📤 Mengupload IMG_001.jpg...
   ✅ Upload berhasil: IMG_001.jpg (Session: EVENT_001)
   ```

---

## 📊 Session Code Behavior

### Manual Session Code

Jika Anda isi field "Session Code" dengan `EVENT_001`:

```
Semua foto akan diupload dengan session_code: EVENT_001
```

**Use case:**
- Event tertentu (pernikahan, konferensi, dll)
- Grouping foto per event
- Easy filtering di Laravel

### Auto-Generated Session Code

Jika kosongkan field "Session Code":

```
Setiap foto akan dapat session_code otomatis unique
Format: AUTO_{timestamp}_{random}
Contoh: AUTO_lnx5w_4K2M9P, AUTO_lnx5x_7H3N2Q
```

**Use case:**
- Testing
- Mixed events
- Don't need grouping

---

## 🔍 Debugging Error

### Check Laravel Logs

```bash
tail -f storage/logs/laravel.log
```

### Common Errors & Solutions

#### 1. Error 422 - Validation Failed

**Symptoms:**
```
❌ Upload gagal: Validation Error: The photo field is required, The session_code field is required
```

**Solutions:**
- ✅ Pastikan menggunakan versi FIXED ini
- ✅ Check API URL benar: `/api/photos/upload`
- ✅ Check Laravel controller menerima `photo` dan `session_code`

#### 2. Error 401 - Unauthorized

**Symptoms:**
```
❌ Upload gagal: Authentication failed - Check Bearer token
```

**Solutions:**
- Generate token baru di Laravel tinker
- Copy paste dengan benar (no spaces)
- Check token belum expired
- Test tanpa token dulu (kosongkan field)

#### 3. Error: No response from server

**Symptoms:**
```
❌ Upload gagal: No response from server - Check API URL and network
```

**Solutions:**
- Pastikan Laravel running: `php artisan serve`
- Check URL correct: `http://localhost:8000/api/photos/upload`
- Test dengan cURL:
  ```bash
  curl -X POST http://localhost:8000/api/photos/upload \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -F "photo=@test.jpg" \
    -F "session_code=TEST"
  ```

#### 4. Error: ECONNREFUSED

**Symptoms:**
```
❌ Upload gagal: connect ECONNREFUSED 127.0.0.1:8000
```

**Solutions:**
- Laravel tidak running, jalankan: `php artisan serve`
- Check port 8000 available
- Atau ganti port di Laravel: `php artisan serve --port=8001`
  Dan update API URL di Electron app

---

## 📝 Laravel API Controller Reference

Controller Anda harus seperti ini:

```php
<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Photo;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class PhotoController extends Controller
{
    public function upload(Request $request)
    {
        $request->validate([
            'photo' => 'required|image|max:10240', // Max 10MB
            'session_code' => 'required|string|max:255',
        ]);

        try {
            $file = $request->file('photo');
            
            // Generate unique filename
            $filename = Str::random(40) . '.' . $file->getClientOriginalExtension();
            $path = $file->storeAs('photos', $filename, 'public');

            // Create photo record
            $photo = Photo::create([
                'file_path' => $path,
                'session_code' => $request->session_code,
                'original_filename' => $file->getClientOriginalName(),
                'file_size' => $file->getSize(),
                'mime_type' => $file->getMimeType(),
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Photo uploaded successfully',
                'data' => [
                    'id' => $photo->id,
                    'session_code' => $photo->session_code,
                    'url' => Storage::url($photo->file_path),
                    'uploaded_at' => $photo->created_at->toISOString(),
                ],
            ], 201);

        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to upload photo',
                'error' => $e->getMessage(),
            ], 500);
        }
    }
}
```

### Routes (api.php):

```php
use App\Http\Controllers\Api\PhotoController;

Route::middleware(['api.token'])->group(function () {
    Route::post('/photos/upload', [PhotoController::class, 'upload']);
});
```

---

## ✨ Improvements dari Versi Lama

### 1. **Better Error Messages**

**OLD:**
```
❌ Upload gagal: IMG_001.jpg - Error: Request failed with status code 422
```

**NEW:**
```
❌ Upload gagal: IMG_001.jpg - Validation Error: The session_code field is required
```

### 2. **Session Code Support**

- Manual entry untuk grouping
- Auto-generate untuk flexibility
- Logged di setiap upload

### 3. **Correct Default URL**

- Old: `/api/upload-photo` (non-standard)
- New: `/api/photos/upload` (RESTful, matches Laravel route)

### 4. **Enhanced Logging**

```
✅ Monitoring dimulai! Siap upload foto baru.
📍 API Endpoint: http://localhost:8000/api/photos/upload
🏷️ Session Code: EVENT_001
```

---

## 🎯 Quick Test

### Test dengan cURL (tanpa Electron):

```bash
# Generate token dulu
php artisan tinker
# $token = App\Models\ApiToken::generate('Test'); echo $token->token; exit

# Upload test
curl -X POST http://localhost:8000/api/photos/upload \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -F "photo=@test.jpg" \
  -F "session_code=TEST_001"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Photo uploaded successfully",
  "data": {
    "id": 1,
    "session_code": "TEST_001",
    "url": "http://localhost:8000/storage/photos/xxx.jpg",
    "uploaded_at": "2024-11-21T10:30:00.000000Z"
  }
}
```

Jika berhasil, Electron app pasti work!

---

## 📦 Build Executable (Optional)

Jika sudah test OK, build untuk production:

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

Output: `dist/Photo Uploader Simple Setup.exe` (atau sesuai OS)

---

## ✅ Checklist Setup

- [ ] Laravel backend running (`php artisan serve`)
- [ ] API token generated (optional)
- [ ] Electron dependencies installed (`npm install`)
- [ ] API URL correct: `http://localhost:8000/api/photos/upload`
- [ ] Bearer token filled (if required)
- [ ] Session code set (or leave empty for auto)
- [ ] Folder selected
- [ ] Click "Mulai"
- [ ] Test dengan copy foto ke folder
- [ ] Check Laravel database untuk photo records

---

## 🆘 Still Having Issues?

1. **Check Laravel logs**: `tail -f storage/logs/laravel.log`
2. **Check Electron console**: Click View > Toggle Developer Tools
3. **Test API with Postman/cURL** untuk isolate masalah
4. **Verify database** migration sudah run: `php artisan migrate`
5. **Check file permissions** di Laravel storage folder

---

## 🎉 Summary

**Error 422 Fixed!**

- ✅ Session code field added
- ✅ Correct API endpoint
- ✅ Better error messages
- ✅ Laravel compatible
- ✅ Auto-generate session code
- ✅ Production ready

**Just run and enjoy auto-upload! 🚀**

---

**Version:** 3.0.1 - Laravel Compatible  
**Fixed:** Error 422 Validation  
**Status:** Production Ready ✅
