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

let socket;
let reconnectAttempts = 0;

function connectWebSocket() {
    // Dynamically determine WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    socket = new WebSocket(`${protocol}//${host}`);

    // Handle WebSocket connection open
    socket.onopen = () => {
        console.log('Connected to WebSocket server');
        reconnectAttempts = 0; // Reset reconnection attempts
        // Identify this client as a regular client
        socket.send(JSON.stringify({ type: 'client' }));
    };

    // Handle incoming WebSocket messages
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.images) {
                // Server sends an array of image URLs
                const newImages = data.images.slice(0, maxImages); // Limit to maxImages
                console.log('Received images:', newImages);
                updateImages(newImages);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    // Handle WebSocket errors
    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    // Handle WebSocket connection close
    socket.onclose = (event) => {
        if (event.wasClean) {
            console.log(
                `WebSocket connection closed cleanly, code=${event.code} reason=${event.reason}`
            );
        } else {
            console.log('WebSocket connection died');
        }

        reconnectAttempts++;
        const reconnectDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Cap delay at 30 seconds

        setTimeout(() => {
            console.log(`Reconnecting to WebSocket server (attempt ${reconnectAttempts})...`);
            connectWebSocket();
        }, reconnectDelay);
    };
}

// Initiate the WebSocket connection
connectWebSocket();

function updateImages(newImages) {
    images = newImages;
    updateImageCount(); // Update the image count display
    drawImages();
}

function updateImageCount() {
    const imageCountElement = document.getElementById('imageCount');
    if (imageCountElement) {
        imageCountElement.textContent = `Images: ${images.length} / ${maxImages}`;
    }
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
    }).catch(error => {
        console.error('Error drawing images:', error);
    });
}
