/**
 * Handles the initialization and rendering of the image gallery,
 * including fetching data from the server and establishing a WebSocket connection
 * for real-time updates.
 */

document.addEventListener('DOMContentLoaded', () => {
    initializeWebSocket();
    fetchImages();
});

let images = [];
let socket;
let reconnectAttempts = 0;
let heartbeatInterval;
let missedPongs = 0;
const maxMissedPongs = 3; // Number of missed pongs before considering the connection lost
const retryDelay = 5000; // Delay in milliseconds before retrying fetch

function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
        console.log('Connected to WebSocket server');
        updateConnectionStatus(true);
        reconnectAttempts = 0; // Reset reconnection attempts on successful connection
        missedPongs = 0; // Reset missed pongs
        // Identify this client as a regular gallery client
        socket.send(JSON.stringify({ type: 'client' }));
        clearError(); // Clear any error messages upon successful connection

        // Start the heartbeat
        startHeartbeat();
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'pong') {
                // Received pong from server
                missedPongs = 0; // Reset missed pongs counter
            } else if (data.images) {
                console.log('Received updated images:', data.images);
                // Filter out items without valid image URLs
                images = data.images.filter(item => item.image);
                renderGallery(images);
            } else if (data.error) {
                console.error('WebSocket error:', data.error);
                displayError(data.error);
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
            console.log(`Connection closed cleanly, code=${event.code} reason=${event.reason}`);
        } else {
            console.log('WebSocket connection died');
            displayError('WebSocket connection lost. Attempting to reconnect...');
        }

        // Exponential backoff for reconnection attempts
        reconnectAttempts++;
        const reconnectDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Cap at 30 seconds

        setTimeout(() => {
            console.log(`Reconnecting to WebSocket server (attempt ${reconnectAttempts})...`);
            initializeWebSocket();
        }, reconnectDelay);
    };
}

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

async function fetchImages() {
    try {
        const response = await fetch('/get-images', {
            method: 'GET',
            credentials: 'omit'
        });

        if (!response.ok) {
            console.warn(`HTTP error! status: ${response.status}`);
            // Display loading message and retry
            displayNoImagesMessage();
            return;
        }

        const data = await response.json();
        clearError();

        if (!data.images || data.images.length === 0) {
            // No images returned
            displayNoImagesMessage();
            return;
        }

        // Filter out items without valid image URLs
        images = data.images.filter(item => item.image);

        if (images.length === 0) {
            // No valid images found
            displayNoImagesMessage();
            return;
        }

        renderGallery(images);
    } catch (error) {
        console.error('Error fetching images:', error);
        // Instead of showing a final error, show loading and retry
        displayNoImagesMessage();
    }
}

function renderGallery(images) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '';

    if (!images || images.length === 0) {
        displayNoImagesMessage();
        return;
    }

    const totalImages = images.length;

    images.forEach((item, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.classList.add('gallery-item');

        // Create and append the image number
        const imageNumber = document.createElement('div');
        imageNumber.classList.add('image-number');
        imageNumber.textContent = `Image ${index + 1}/${totalImages}`;
        itemDiv.appendChild(imageNumber);

        // Create and append the image
        const img = document.createElement('img');
        if (item.image && item.image !== 'undefined') {
            img.setAttribute('data-src', item.image);
            img.alt = `Gallery Image ${index + 1}`;
        } else {
            console.warn(`Image source is undefined for item at index ${index}.`);
            // Set a transparent placeholder image
            img.setAttribute('data-src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
            img.alt = 'Image not available';
        }

        // Placeholder image (transparent pixel)
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        itemDiv.appendChild(img);

        // Create and append the associated text
        const textPara = document.createElement('p');
        if (item.text) {
            fetch(item.text, {
                method: 'GET',
                credentials: 'omit'
            })
                .then(textResponse => {
                    if (!textResponse.ok) {
                        throw new Error(`Failed to load text. Status: ${textResponse.status}`);
                    }
                    return textResponse.text();
                })
                .then(textData => {
                    textPara.textContent = textData;
                    img.alt = textData;
                })
                .catch(textError => {
                    console.error('Error fetching associated text:', textError);
                    textPara.textContent = 'No associated text available.';
                });
        } else {
            textPara.textContent = 'No associated text available.';
        }

        itemDiv.appendChild(textPara);
        gallery.appendChild(itemDiv);
    });

    // Initialize lazy loading after gallery is populated
    initializeLazyLoading();
}

function initializeLazyLoading() {
    const lazyImages = document.querySelectorAll('img[data-src]');
    const config = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    let observer;

    if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(onIntersection, config);
        lazyImages.forEach(image => {
            observer.observe(image);
        });
    } else {
        lazyImages.forEach(image => {
            loadImage(image);
        });
    }

    function onIntersection(entries, observer) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const image = entry.target;
                loadImage(image);
                observer.unobserve(image);
            }
        });
    }

    function loadImage(image) {
        const src = image.getAttribute('data-src');

        if (!src || src === 'undefined') {
            console.warn('Skipping image with undefined source:', image);
            return;
        }

        image.src = src;
        image.onload = () => {
            image.classList.add('loaded');
        };
        image.onerror = () => {
            console.error(`Error loading image: ${src}`);
            // Optionally handle the error
            image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        };
        image.removeAttribute('data-src');
    }
}

function displayError(message) {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }
}

function clearError() {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.style.display = 'none';
    }
}

/**
 * Instead of showing "No images available" and stopping, now show a loading message
 * and schedule a retry. This ensures that the script keeps trying until images appear.
 */
function displayNoImagesMessage() {
    const gallery = document.getElementById('gallery');
    if (gallery) {
        gallery.innerHTML = '<p>Loading images, please wait... Retrying in 5 seconds.</p>';
    }
    setTimeout(fetchImages, retryDelay);
}

function handleWebSocketUpdate(newImages) {
    images = newImages.filter(item => item.image);
    renderGallery(images);
}