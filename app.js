// app.js

const canvas = document.getElementById('imageGrid');
const ctx = canvas.getContext('2d');
const maxImages = 784;
const canvasWidth = 512;
const canvasHeight = 512;
canvas.width = canvasWidth;
canvas.height = canvasHeight;
let images = [];

let prevGridSize = 0; // Variable to track the previous grid size

// Off-screen canvas for double buffering
const offCanvas = document.createElement('canvas');
const offCtx = offCanvas.getContext('2d');
offCanvas.width = canvasWidth;
offCanvas.height = canvasHeight;

// Dynamically determine WebSocket URL
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const host = window.location.host;
const socket = new WebSocket(`${protocol}//${host}`);

socket.onopen = () => {
    console.log('Connected to WebSocket server');
    // Identify this client as a regular client
    socket.send(JSON.stringify({ type: 'client' }));
};

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.images) {
        // Server now returns full public blob URLs for images
        const newImages = data.images.slice(0, maxImages); // Limit to maxImages
        console.log('Received images:', newImages);
        updateImages(newImages);
    }
};

socket.onclose = () => {
    console.log('Disconnected from WebSocket server');
};

function updateImages(newImages) {
    images = newImages;
    updateImageCount(); // Update the image count display
    drawImages();
}

function updateImageCount() {
    const imageCountElement = document.getElementById('imageCount');
    imageCountElement.textContent = `Images: ${images.length} / 784`;
}

// Function to load all images from Blob Storage URLs
function loadAllImages(imageSources) {
    const promises = imageSources.map(src => {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous'; // Handle CORS for blob storage
            img.src = src;
            img.onload = () => resolve({ img, src });
            img.onerror = () => {
                console.error(`Error loading image: ${src}`);
                // Even if an image fails to load, we resolve to proceed with others
                resolve({ img: null, src });
            };
        });
    });
    return Promise.all(promises);
}

// Function to dynamically resize and draw images using off-screen canvas
function drawImages() {
    const numImages = images.length;
    const gridSize = Math.ceil(Math.sqrt(numImages));

    // Check if the grid size has changed
    if (gridSize !== prevGridSize) {
        console.log('Grid size changed, clearing off-screen canvas');
        offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
    } else {
        console.log('Grid size unchanged, not clearing off-screen canvas');
    }

    const imageSize = Math.min(canvasWidth / gridSize, canvasHeight / gridSize);

    loadAllImages(images).then(loadedImages => {
        loadedImages.forEach(({ img }, index) => {
            if (img) {
                const col = index % gridSize;
                const row = Math.floor(index / gridSize);
                const x = col * imageSize;
                const y = row * imageSize;
                offCtx.drawImage(img, x, y, imageSize, imageSize);
            }
        });

        // Draw the off-screen canvas onto the main canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(offCanvas, 0, 0);

        // Update the previous grid size
        prevGridSize = gridSize;
    });
}