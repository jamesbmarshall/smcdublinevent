/**
 * Admin.js
 * Handles the administration interface for approving or denying pending images.
 * Establishes a WebSocket connection to receive real-time updates.
 */

// We'll store the admin's unique ID that the server provides.
let myAdminId = null; 

document.addEventListener('DOMContentLoaded', () => {
    initializeWebSocket();
});

let pendingImages = []; // Each item: { url, lockedBy }
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
        socket.send(JSON.stringify({ type: 'admin' }));

        clearError(); // Clear any error messages upon successful connection
        startHeartbeat(); // Start the heartbeat
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            // Heartbeat pong
            if (data.type === 'pong') {
                missedPongs = 0; 
                return;
            }

            // The server is giving us a unique admin ID:
            if (data.type === 'initAdminId') {
                myAdminId = data.adminId; // e.g. "admin_abc123"
                console.log(`Received adminId: ${myAdminId}`);
                return;
            }

            // The server is sending updated pending images:
            if (data.pendingImages) {
                console.log('Received updated pending images:', data.pendingImages);

                // data.pendingImages might look like:
                // [ { url: "https://.../image_123.jpg", lockedBy: "admin_abc123" }, ... ]

                // If the server is *already* sending only items locked by *this* admin,
                // we can accept them directly:
                pendingImages = data.pendingImages;

                // Or, if the server is sending *all* items for every admin,
                // we can locally filter:
                // if (myAdminId) {
                //     pendingImages = data.pendingImages.filter(item => item.lockedBy === myAdminId);
                // } else {
                //     // If we haven't received an adminId yet for some reason,
                //     // just store them. (But typically you'd wait for initAdminId)
                //     pendingImages = data.pendingImages;
                // }

                displayPendingImages(pendingImages);
                return;
            }

            // Check for error
            if (data.error) {
                console.error('WebSocket error:', data.error);
                displayError(data.error);
                return;
            }

            console.warn('Unknown message type:', data);
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
            console.log(`Connection closed cleanly, code=${event.code}, reason=${event.reason}`);
        } else {
            console.log('WebSocket connection died');
            displayError('WebSocket connection lost. Attempting to reconnect...');
        }

        // Exponential backoff for reconnection
        reconnectAttempts++;
        const reconnectDelay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
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
    }, 10000); // Ping every 10 seconds
}

/**
 * Updates the connection status indicator (an element in your HTML).
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
 * Displays pending images for this admin.
 * @param {Array<Object>} images - Array of objects, e.g. { url, lockedBy }
 */
function displayPendingImages(images) {
    const container = document.getElementById('pendingImages');
    container.innerHTML = ''; // Clear existing

    if (!images || images.length === 0) {
        const p = document.createElement('p');
        p.textContent = 'No pending images.';
        container.appendChild(p);
        return;
    }

    images.forEach(item => {
        const imageSrc = item.url;
        const lockedBy = item.lockedBy; // might or might not be used in UI

        // Create card
        const card = document.createElement('div');
        card.classList.add('image-card');

        // Image element
        const img = document.createElement('img');
        img.src = imageSrc;
        img.alt = 'Pending Image';
        img.onerror = () => {
            console.error(`Failed to load image: ${imageSrc}`);
            img.src = '';
        };
        card.appendChild(img);

        // Text file
        const textSrc = imageSrc.replace('.jpg', '.txt'); 
        const textPara = document.createElement('p');
        textPara.textContent = 'Loading text...';
        card.appendChild(textPara);

        fetch(textSrc)
            .then(resp => {
                if (!resp.ok) {
                    throw new Error(`Could not load text at ${textSrc}`);
                }
                return resp.text();
            })
            .then(txt => {
                textPara.textContent = txt;
            })
            .catch(err => {
                console.error('Error fetching text:', err);
                textPara.textContent = 'No text found.';
            });

        // Approve / Deny
        const approveButton = document.createElement('button');
        approveButton.classList.add('approve-button');
        approveButton.textContent = 'Approve';
        approveButton.onclick = () => approveImage(imageSrc);

        const denyButton = document.createElement('button');
        denyButton.classList.add('deny-button');
        denyButton.textContent = 'Deny';
        denyButton.onclick = () => denyImage(imageSrc);

        card.appendChild(approveButton);
        card.appendChild(denyButton);

        container.appendChild(card);
    });
}

/**
 * Sends a request to approve an image.
 * @param {string} imageSrc - URL of the image in pending container
 */
function approveImage(imageSrc) {
    const data = { imagePath: imageSrc };

    fetch('/admin/approve-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(text || 'Approval failed.');
            });
        }
        // On success, remove that item from pendingImages and re-display
        pendingImages = pendingImages.filter(obj => obj.url !== imageSrc);
        displayPendingImages(pendingImages);
    })
    .catch(err => {
        console.error('Error approving image:', err);
        alert(`Error approving image: ${err.message}`);
    });
}

/**
 * Sends a request to deny an image.
 * @param {string} imageSrc - URL of the image in pending container
 */
function denyImage(imageSrc) {
    const data = { imagePath: imageSrc };

    fetch('/admin/deny-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(text || 'Denial failed.');
            });
        }
        // On success, remove that item from pendingImages and re-display
        pendingImages = pendingImages.filter(obj => obj.url !== imageSrc);
        displayPendingImages(pendingImages);
    })
    .catch(err => {
        console.error('Error denying image:', err);
        alert(`Error denying image: ${err.message}`);
    });
}

/**
 * Displays an error message to the user.
 */
function displayError(message) {
    const div = document.getElementById('errorMessage');
    if (div) {
        div.textContent = message;
        div.style.display = 'block';
    }
}

/**
 * Clears any error messages.
 */
function clearError() {
    const div = document.getElementById('errorMessage');
    if (div) {
        div.textContent = '';
        div.style.display = 'none';
    }
}