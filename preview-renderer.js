// Preview Window Renderer - Simple Latest Photo Display
let currentPhoto = null;

// DOM Elements
const photoContainer = document.getElementById('photoContainer');
const emptyState = document.getElementById('emptyState');
const closeBtn = document.getElementById('closeBtn');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    requestPhotos();
});

// Setup Event Listeners
function setupEventListeners() {
    closeBtn.addEventListener('click', () => {
        window.electronAPI.closePreview();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.electronAPI.closePreview();
        }
    });
}

// Request photos from main process
function requestPhotos() {
    window.electronAPI.getUploadedPhotos();
}

// Listen for photos data
window.electronAPI.onPhotosData((data) => {
    if (data && data.length > 0) {
        // Show the latest photo
        const latestPhoto = data[data.length - 1];
        showPhoto(latestPhoto);
    }
});

// Listen for new photo
window.electronAPI.onNewPhoto((photoData) => {
    // Show the new photo with animation
    showPhoto(photoData, true);
});

// Show photo
function showPhoto(photoData, isNew = false) {
    // Hide empty state
    emptyState.style.display = 'none';
    
    // Remove previous photo elements
    const existingPhotos = photoContainer.querySelectorAll('.photo');
    existingPhotos.forEach(photo => {
        photo.classList.remove('active');
        setTimeout(() => photo.remove(), 1000);
    });
    
    // Create new photo element
    const photoDiv = document.createElement('div');
    photoDiv.className = 'photo';
    if (isNew) {
        photoDiv.classList.add('new-photo');
    }
    
    const img = document.createElement('img');
    img.src = photoData.path;
    img.alt = photoData.filename;
    
    // Handle image load
    img.onload = () => {
        photoDiv.classList.add('active');
    };
    
    // Handle image error
    img.onerror = () => {
        console.error('Failed to load image:', photoData.path);
        photoDiv.remove();
        if (photoContainer.querySelectorAll('.photo').length === 0) {
            emptyState.style.display = 'flex';
        }
    };
    
    photoDiv.appendChild(img);
    photoContainer.appendChild(photoDiv);
    
    currentPhoto = photoData;
}

// Cleanup on close
window.addEventListener('beforeunload', () => {
    currentPhoto = null;
});