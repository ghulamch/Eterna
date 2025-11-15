# Eterna Photo Auto Uploader

**Eterna Photo Auto Uploader** is a desktop application built with **Electron** that automatically uploads photos from a local folder to a **Laravel API**. The application monitors a designated folder for new image files and uploads them to your server, streamlining the process of managing photo uploads for any project or business.

---

## Features

- **Automatic Uploads**: Automatically monitors a folder and uploads new photos to a Laravel API.
- **Supports Multiple Formats**: Uploads photos in **JPEG, PNG, JPG, GIF, WEBP, BMP**.
- **Simple Configuration**: Easily configure the monitored folder and API endpoint.
- **Cross-Platform**: Built with Electron, supports Windows, macOS, and Linux.

---

## Installation

### Prerequisites

- **Node.js** (version 12 or higher)
- **npm** (Node package manager)
- **Electron** (for building the app)
- **Laravel API** (server-side application)

### Steps to Install

1. Clone the repository:
    ```bash
    git clone https://github.com/yourusername/eterna-photo-auto-uploader.git
    cd eterna-photo-auto-uploader
    ```

2. Install dependencies:
    ```bash
    npm install
    ```

3. Build the application:
    - For Windows:
      ```bash
      npm run build
      ```

    - For macOS/Linux (optional):
      ```bash
      npm run build-all
      ```

    This will create a packaged `.exe` file for Windows in the `dist/` folder.

---

## Usage

1. **Launch the application**:
    - On Windows, run `Eterna Photo Auto Uploader.exe` after building the app.
    - For macOS/Linux, run the appropriate binary for your OS.

2. **Configure the Monitored Folder**:
    - Select the folder you want to monitor for new images.

3. **Set the API URL**:
    - Enter the URL of your **Laravel API** endpoint where the images will be uploaded.

4. **Start Monitoring**:
    - Click on **Start** to begin monitoring the selected folder. Any new images added to the folder will automatically be uploaded to the Laravel API.

---

## Laravel API Configuration

To integrate with the **Eterna Photo Auto Uploader**, your Laravel application needs to have an API endpoint that accepts photo uploads. Here's an example setup:

1. Create a route in `routes/api.php`:
    ```php
    Route::post('upload-photo', [PhotoController::class, 'upload']);
    ```

2. In the `PhotoController.php`, implement the `upload` method:

    ```php
    use Illuminate\Http\Request;
    use App\Models\Photo;
    use Validator;
    use Storage;

    class PhotoController extends Controller
    {
        public function upload(Request $request)
        {
            // Validate input
            $validator = Validator::make($request->all(), [
                'photo' => 'required|image|mimes:jpeg,png,jpg,gif,webp,bmp|max:10240' // max 10MB
            ]);

            if ($validator->fails()) {
                return response()->json([
                    'success' => false,
                    'message' => 'Validation failed',
                    'errors' => $validator->errors()
                ], 422);
            }

            try {
                if ($request->hasFile('photo')) {
                    $file = $request->file('photo');

                    // Generate a unique filename
                    $originalName = $file->getClientOriginalName();
                    $extension = $file->getClientOriginalExtension();
                    $filename = time() . '_' . uniqid() . '.' . $extension;

                    // Save the file to storage/app/public/photos
                    $path = $file->storeAs('photos', $filename, 'public');

                    // Optionally save to database
                    $photo = Photo::create([
                        'file_path' => $path,
                        'session_code' => now()->format('Hi'),  // Generate session code (e.g., 1213)
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]);

                    return response()->json([
                        'success' => true,
                        'message' => 'Photo uploaded successfully',
                        'data' => [
                            'id' => $photo->id,
                            'file_path' => $photo->file_path,
                            'session_code' => $photo->session_code,
                            'created_at' => $photo->created_at,
                            'url' => Storage::url($path),
                        ]
                    ], 201);
                }

                return response()->json([
                    'success' => false,
                    'message' => 'No file uploaded'
                ], 400);

            } catch (\Exception $e) {
                return response()->json([
                    'success' => false,
                    'message' => 'Error during photo upload',
                    'error' => $e->getMessage()
                ], 500);
            }
        }
    }
    ```

This method will handle the uploaded images, save them in the `photos` directory, and store the information in the database.

---

## Troubleshooting

- **"Cannot find module 'chokidar'"**:
    - Make sure `chokidar` is installed properly in the `node_modules` folder by running `npm install chokidar`.
    - Verify that `node_modules` is correctly included during the packaging by checking your `package.json` file.

- **Application Not Starting**:
    - Ensure that **Node.js** is installed and that all dependencies are installed using `npm install`.

---

## License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.