/**
 * Admin.js
 * Handles the administration interface for approving or denying pending images.
 * Establishes a WebSocket connection to receive real-time updates.
 */

document.addEventListener('DOMContentLoaded', () => {
    initializeWebSocket();
});

let pendingImages = [];
let socket;
let reconnectAttempts = 0;
let heartbeatInterval;
let missedPongs = 0;
const maxMissedPongs = 3; // Adjust as needed

/**
 * Initializes the WebSocket connection and sets up event handlers.
 */
function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
        console.log('WebSocket connection opened as admin.');
        updateConnectionStatus(true);
        reconnectAttempts = 0;
        missedPongs = 0;

        // Identify this client as an admin
        socket.send(JSON.stringify({ type: 'admin' })); // CHANGED OR ADDED

        clearError(); // Clear any error messages upon successful connection
        startHeartbeat(); // Start the heartbeat
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'pong') {
                missedPongs = 0; // Reset missed pongs counter
            } 
            else if (data.pendingImages) {
                // The server might now return only the images locked for *this* admin,
                // or an array of objects with lockedBy, etc.
                console.log('Received updated pending images:', data.pendingImages);

                // If the server returns exactly the subset for this admin, the code below is unchanged:
                //pendingImages = data.pendingImages;

                // If the server returned an array of objects like:
                // [{ url: "...", lockedBy: "admin_xyz" }, { url: "...", lockedBy: "admin_abc" }, ...]
                // and you only want items locked to YOU, you might do:
                pendingImages = data.pendingImages.filter(item => item.lockedBy === 'myAdminId');
                // But if your server is already filtering them, no change is needed.

                displayPendingImages(pendingImages);
            } 
            else if (data.error) {
                console.error('WebSocket error:', data.error);
                displayError(data.error);
            } 
            else {
                console.warn('Unknown message type:', data);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus(false);
        displayError('WebSocket connection error.');
    };

    socket.onclose = (event) => {
        console.log('WebSocket connection closed');
        updateConnectionStatus(false);
        clearInterval(heartbeatInterval); // Stop the heartbeat

        if (event.wasClean) {
            console.log(`WebSocket connection closed cleanly, code=${event.code} reason=${event.reason}`);
        } else {
            console.log('WebSocket connection died');
            displayError('WebSocket connection lost. Attempting to reconnect...');
        }

        // Exponential backoff for reconnection attempts
        reconnectAttempts++;
        const reconnectDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(() => {
            console.log(`Reconnecting to WebSocket server as admin (attempt ${reconnectAttempts})...`);
            initializeWebSocket();
        }, reconnectDelay);
    };
}

/**
 * Starts the heartbeat mechanism to keep the WebSocket connection alive.
 */
function startHeartbeat() {
    heartbeatInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
            missedPongs++;
            if (missedPongs > maxMissedPongs) {
                console.warn('Missed pongs exceeded limit. Closing socket.');
                socket.close();
            }
        }
    }, 10000); // Send a ping every 10 seconds
}

/**
 * Updates the connection status indicator.
 * @param {boolean} isConnected - True if connected, false otherwise.
 */
function updateConnectionStatus(isConnected) {
    const statusIndicator = document.getElementById('connectionStatus');
    if (statusIndicator) {
        if (isConnected) {
            statusIndicator.classList.add('connected');
            statusIndicator.classList.remove('disconnected');
            statusIndicator.title = 'Connected';
        } else {
            statusIndicator.classList.add('disconnected');
            statusIndicator.classList.remove('connected');
            statusIndicator.title = 'Disconnected';
        }
    }
}

/**
 * Displays pending images for admin review.
 * @param {Array<string>} images - Array of image URLs pending approval.
 */
function displayPendingImages(images) {
    const pendingImagesContainer = document.getElementById('pendingImages');
    pendingImagesContainer.innerHTML = ''; // Clear existing content

    if (images.length === 0) {
        const noImagesMessage = document.createElement('p');
        noImagesMessage.textContent = 'No pending images.';
        pendingImagesContainer.appendChild(noImagesMessage);
        return;
    }

    images.forEach((imageSrc) => {
        const imageCard = document.createElement('div');
        imageCard.classList.add('image-card');

        const imgElement = document.createElement('img');
        imgElement.src = imageSrc;
        imgElement.alt = 'Pending Image';
        imgElement.onerror = () => {
            console.error(`Failed to load image: ${imageSrc}`);
            imgElement.src = '';
        };

        // Construct the text file URL by replacing .jpg with .txt
        const textSrc = imageSrc.replace('.jpg', '.txt');
        const textPara = document.createElement('p');
        textPara.textContent = 'Loading associated text...';

        imageCard.appendChild(imgElement);
        imageCard.appendChild(textPara);

        // Fetch associated text from blob storage
        fetch(textSrc)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Text file not found or inaccessible at ${textSrc}. Response status: ${response.status}`);
                }
                return response.text();
            })
            .then(textContent => {
                textPara.textContent = textContent;
            })
            .catch(err => {
                console.error('Error fetching text file:', err);
                textPara.textContent = 'Could not load associated text.';
            });

        const approveButton = document.createElement('button');
        approveButton.textContent = 'Approve';
        approveButton.classList.add('approve-button');
        approveButton.addEventListener('click', () => approveImage(imageSrc));

        const denyButton = document.createElement('button');
        denyButton.textContent = 'Deny';
        denyButton.classList.add('deny-button');
        denyButton.addEventListener('click', () => denyImage(imageSrc));

        imageCard.appendChild(approveButton);
        imageCard.appendChild(denyButton);

        pendingImagesContainer.appendChild(imageCard);
    });
}

/**
 * Sends a request to approve an image.
 * @param {string} imageSrc - The URL of the image to approve.
 */
function approveImage(imageSrc) {
    const data = { imagePath: imageSrc };

    fetch('/admin/approve-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    .then(response => {
        if (response.ok) {
            // Remove the approved image from the array and update the UI
            pendingImages = pendingImages.filter(img => img !== imageSrc);
            displayPendingImages(pendingImages);
        } else {
            return response.text().then(text => {
                throw new Error(text || 'Failed to approve image.');
            });
        }
    })
    .catch(error => {
        console.error('Error approving image:', error);
        alert(`Error approving image: ${error.message}`);
    });
}

/**
 * Sends a request to deny an image.
 * @param {string} imageSrc - The URL of the image to deny.
 */
function denyImage(imageSrc) {
    const data = { imagePath: imageSrc };

    fetch('/admin/deny-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    .then(response => {
        if (response.ok) {
            // Remove the denied image from the array and update the UI
            pendingImages = pendingImages.filter(img => img !== imageSrc);
            displayPendingImages(pendingImages);
        } else {
            return response.text().then(text => {
                throw new Error(text || 'Failed to deny image.');
            });
        }
    })
    .catch(error => {
        console.error('Error denying image:', error);
        alert(`Error denying image: ${error.message}`);
    });
}

/**
 * Displays an error message to the user.
 * @param {string} message - The error message to display.
 */
function displayError(message) {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }
}

/**
 * Clears any existing error messages.
 */
function clearError() {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.style.display = 'none';
    }
}