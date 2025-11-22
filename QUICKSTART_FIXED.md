# ⚡ Quick Start - Fixed Version

## 🎯 Error 422 SOLVED!

Versi ini sudah fix error 422 dan fully compatible dengan Laravel API.

---

## 🚀 Super Fast Setup (3 Steps)

### 1️⃣ Install Dependencies (1 menit)

```bash
cd electron-photo-uploader-fixed
npm install
```

### 2️⃣ Pastikan Laravel Running

```bash
# Di terminal Laravel
php artisan serve
```

### 3️⃣ Run Electron App

```bash
npm start
```

---

## 💡 Setup di Aplikasi (30 detik)

1. **Pilih Folder** - Folder yang akan dimonitor
2. **API URL** - `http://localhost:8000/api/photos/upload` (sudah default ✅)
3. **Bearer Token** - Paste token atau kosongkan untuk testing
4. **Session Code** - Isi manual atau kosongkan untuk auto-generate
5. **Klik "Mulai"** - Done! ✅

---

## 🧪 Test Upload

Copy foto apapun ke folder yang dipilih, tunggu 1-2 detik:

```
✅ Expected Log:
📸 File baru terdeteksi: IMG_001.jpg
➕ Ditambahkan ke antrian (Total: 1)
📤 Mengupload IMG_001.jpg...
✅ Upload berhasil: IMG_001.jpg (Session: AUTO_lnx5w_4K2M9P)
```

Check Laravel database:
```bash
php artisan tinker
```
```php
App\Models\Photo::latest()->first()
```

---

## 🔑 Generate API Token (Optional)

Untuk production, generate token di Laravel:

```bash
php artisan tinker
```

```php
$token = App\Models\ApiToken::generate('Electron Upload Token');
echo $token->token;
exit
```

Copy token, paste ke Electron app field "Bearer Token".

---

## 🆘 Troubleshooting

### Error masih 422?

1. Pastikan pakai versi FIXED ini (bukan yang lama)
2. Check API URL: `/api/photos/upload` bukan `/api/upload-photo`
3. Check Laravel logs: `tail -f storage/logs/laravel.log`

### No response from server?

```bash
# Check Laravel running
php artisan serve

# Test dengan cURL
curl http://localhost:8000/api/photos/upload
```

### Upload terlalu lama?

- Check network speed
- Reduce foto size (<2MB recommended)
- Check Laravel timeout config

---

## 📝 What's Fixed?

### ✅ Fixed Issues:

1. **Session code field added** - Required by Laravel API
2. **Correct API endpoint** - `/api/photos/upload`
3. **Better error messages** - Know exactly what went wrong
4. **Auto-generate session code** - No need manual input
5. **Enhanced validation** - Clear feedback

### 🆕 New Features:

- Manual session code input
- Auto-generate session code
- Detailed error logging
- Better UI hints
- Laravel-specific instructions

---

## 🎉 It Works!

```
OLD (Error 422):
❌ Upload gagal: Error 422 Unprocessable Entity

NEW (Success):
✅ Upload berhasil: IMG_001.jpg (Session: EVENT_001)
```

---

## 📚 More Info

- **FIX_DOCUMENTATION.md** - Detailed fix explanation
- **README.md** - Full documentation
- Laravel API: Check `photobooth-app/` dari package sebelumnya

---

## 🚀 Ready to Go!

Aplikasi sekarang **100% compatible** dengan Laravel API yang sudah dibuat!

**No more 422 errors! 🎉**

---

**Version:** 3.0.1 - Laravel Compatible  
**Status:** Tested & Working ✅  
**Setup Time:** 3 minutes
