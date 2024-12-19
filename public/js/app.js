const canvas = document.getElementById('imageGrid');
const ctx = canvas.getContext('2d');
const maxImages = 784;
let images = [];

let prevGridSize = 0; // Track the previous grid size for potential optimization

// Off-screen canvas for double buffering
const offCanvas = document.createElement('canvas');
const offCtx = offCanvas.getContext('2d');

// Dynamically resize the canvas to be a square fitting the screen
function resizeCanvas() {
    const margin = 40; // Adjust to add some padding around the canvas
    const size = Math.min(window.innerWidth, window.innerHeight) - margin;
    const finalSize = Math.max(size, 50); // Ensure a minimum size
    
    canvas.width = finalSize;
    canvas.height = finalSize;
    offCanvas.width = finalSize;
    offCanvas.height = finalSize;

    // Redraw the images after resizing, if any
    drawImages();
}

// Listen for window resize and re-draw the canvas and images
window.addEventListener('resize', resizeCanvas);

// Initial resize on page load
resizeCanvas();

let socket;
let reconnectAttempts = 0;
let heartbeatInterval;
let missedPongs = 0;
const maxMissedPongs = 3; // Number of missed pongs before considering the connection lost

function connectWebSocket() {
    // Dynamically determine WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
        console.log('Connected to WebSocket server');
        reconnectAttempts = 0;
        missedPongs = 0;
        // Identify this client as a regular client
        socket.send(JSON.stringify({ type: 'client' }));

        // Start the heartbeat
        startHeartbeat();
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'pong') {
                missedPongs = 0; // Reset missed pongs counter
            } else if (data.images) {
                // Received an array of image URLs
                const newImages = data.images.slice(0, maxImages); 
                console.log('Received images:', newImages);
                updateImages(newImages);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    socket.onclose = (event) => {
        console.log('WebSocket connection closed');
        clearInterval(heartbeatInterval); // Stop the heartbeat

        if (event.wasClean) {
            console.log(`Connection closed cleanly, code=${event.code}, reason=${event.reason}`);
        } else {
            console.log('WebSocket connection died');
        }

        reconnectAttempts++;
        const reconnectDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Cap at 30 seconds

        setTimeout(() => {
            console.log(`Reconnecting to WebSocket server (attempt ${reconnectAttempts})...`);
            connectWebSocket();
        }, reconnectDelay);
    };
}

// Initiate the WebSocket connection
connectWebSocket();

/**
 * Starts the heartbeat mechanism to keep the WebSocket connection alive.
 */
function startHeartbeat() {
    heartbeatInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
            missedPongs++;

            if (missedPongs > maxMissedPongs) {
                console.warn('Missed pongs exceeded limit. Closing socket.');
                socket.close();
            }
        }
    }, 10000); // Send a ping every 10 seconds
}

function updateImages(newImages) {
    images = newImages;
    updateImageCount();
    drawImages();
}

function updateImageCount() {
    const imageCountElement = document.getElementById('imageCount');
    if (imageCountElement) {
        imageCountElement.textContent = `Images: ${images.length} / ${maxImages}`;
    }
}

// Load all images from provided URLs
function loadAllImages(imageSources) {
    const promises = imageSources.map(src => {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.src = src;
            img.onload = () => resolve({ img, src });
            img.onerror = () => {
                console.error(`Error loading image: ${src}`);
                resolve({ img: null, src });
            };
        });
    });
    return Promise.all(promises);
}

// Draw images onto the off-screen canvas, then onto the main canvas
function drawImages() {
    if (!images || images.length === 0) {
        // If no images, just clear the canvases
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
        return;
    }

    const numImages = images.length;
    const gridSize = Math.ceil(Math.sqrt(numImages));
    const imageSize = Math.min(offCanvas.width / gridSize, offCanvas.height / gridSize);

    // Clear off-screen canvas if grid size changed
    if (gridSize !== prevGridSize) {
        console.log('Grid size changed, clearing off-screen canvas');
        offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
    } else {
        console.log('Grid size unchanged, not clearing off-screen canvas');
    }

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

        // Draw from off-screen to the visible canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(offCanvas, 0, 0);

        // Update prevGridSize
        prevGridSize = gridSize;
    }).catch(error => {
        console.error('Error drawing images:', error);
    });
}