/**
 * admin-gallery.js
 * Handles the administration interface for viewing and deleting approved images.
 * Establishes a WebSocket connection to receive real-time updates.
 */

document.addEventListener('DOMContentLoaded', () => {
    initializeWebSocket();
    fetchApprovedImages();
});

let approvedImages = [];
let socket;
let reconnectAttempts = 0;
let heartbeatInterval;
let missedPongs = 0;
const maxMissedPongs = 3; // Number of missed pongs before considering the connection lost

/**
 * Initializes the WebSocket connection to receive real-time updates.
 * Sends a message to identify as an admin client.
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

            // Handle heartbeat pong
            if (data.type === 'pong') {
                missedPongs = 0;
                return;
            }

            // Handle image deletions
            if (data.type === 'imageDeleted') {
                const { filename } = data;
                console.log(`Image deleted: ${filename}`);
                removeImageFromGallery(filename);
                return;
            }

            // Handle updated pending images (optional, if admin can view pending)
            if (data.pendingImages) {
                console.log('Received updated pending images:', data.pendingImages);
                // Optionally handle pending images
                return;
            }

            // Handle deletion broadcasts
            if (data.type === 'imageDeleted') {
                const { filename } = data;
                console.log(`Image deleted: ${filename}`);
                removeImageFromGallery(filename);
                return;
            }

            // Check for error messages
            if (data.error) {
                console.error('WebSocket error:', data.error);
                displayError(data.error);
                return;
            }

            // Handle new approved images
            if (data.images) {
                console.log('Received updated approved images:', data.images);
                approvedImages = data.images.filter(item => item.image);
                renderGallery(approvedImages);
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

        // Exponential backoff for reconnection attempts
        reconnectAttempts++;
        const reconnectDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Cap at 30 seconds

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
            statusIndicator.setAttribute('aria-label', 'Connection status: Connected');
        } else {
            statusIndicator.classList.add('disconnected');
            statusIndicator.classList.remove('connected');
            statusIndicator.title = 'Disconnected';
            statusIndicator.setAttribute('aria-label', 'Connection status: Disconnected');
        }
    }
}

/**
 * Fetches the list of approved images and their associated texts from the server.
 * Renders the gallery upon successful retrieval.
 * If no images are found, it shows a loading message and retries automatically.
 */
async function fetchApprovedImages() {
    try {
        const response = await fetch('/get-images', {
            method: 'GET',
            credentials: 'omit' // No credentials needed as /get-images is public
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Clear any existing content and error messages
        clearError();

        if (!data.images || data.images.length === 0) {
            // No images returned yet
            displayNoImagesMessage();
            return;
        }

        // Filter out items without valid image URLs
        approvedImages = data.images.filter(item => item.image);

        if (approvedImages.length === 0) {
            // No valid images found at this time
            displayNoImagesMessage();
            return;
        }

        renderGallery(approvedImages);
    } catch (error) {
        console.error('Error fetching images:', error);
        displayNoImagesMessage();
    }
}

/**
 * Renders the gallery with the provided images.
 * Includes delete buttons for each image.
 */
function renderGallery(images) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '';
    gallery.setAttribute('role', 'list'); // Mark the gallery as a list of images

    if (!images || images.length === 0) {
        displayNoImagesMessage();
        return;
    }

    const totalImages = images.length;

    images.forEach((item, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.classList.add('gallery-item');
        itemDiv.setAttribute('role', 'listitem'); // Each item is a list item
        itemDiv.setAttribute('aria-label', `Gallery image ${index + 1} of ${totalImages}`);

        // Create and append the image number
        const imageNumber = document.createElement('div');
        imageNumber.classList.add('image-number');
        imageNumber.textContent = `Image ${index + 1}/${totalImages}`;
        itemDiv.appendChild(imageNumber);

        // Create and append the image
        const img = document.createElement('img');

        if (item.image && item.image !== 'undefined') {
            img.setAttribute('data-src', item.image);

            // Initial alt text indicating position in the gallery
            img.alt = `Gallery Image ${index + 1}`;
        } else {
            console.warn(`Image source is undefined for item at index ${index}.`);
            // Transparent placeholder image
            img.setAttribute('data-src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
            img.alt = 'Image not available';
        }

        // Placeholder image (transparent pixel)
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

        itemDiv.appendChild(img);

        // Create and append the associated text
        const textPara = document.createElement('p');
        if (item.text) {
            // Fetch the associated text content to update alt text with descriptive prompt
            fetch(item.text, {
                method: 'GET',
                credentials: 'omit' // Public text files
            })
                .then(textResponse => {
                    if (!textResponse.ok) {
                        throw new Error(`Failed to load text. Status: ${textResponse.status}`);
                    }
                    return textResponse.text();
                })
                .then(txt => {
                    textPara.textContent = txt;

                    // Update the alt text of the image with the prompt for better accessibility
                    img.alt = txt || `Gallery Image ${index + 1}`;
                })
                .catch(textError => {
                    console.error('Error fetching associated text:', textError);
                    textPara.textContent = 'No associated text available.';
                });
        } else {
            textPara.textContent = 'No associated text available.';
        }

        itemDiv.appendChild(textPara);

        // Create and append the Delete button
        const deleteButton = document.createElement('button');
        deleteButton.classList.add('delete-button');
        deleteButton.textContent = 'Delete';
        deleteButton.setAttribute('aria-label', `Delete Image ${index + 1}`);
        deleteButton.onclick = () => deleteImage(item.image);

        itemDiv.appendChild(deleteButton);

        gallery.appendChild(itemDiv);
    });

    // Initialize lazy loading after gallery is populated
    initializeLazyLoading();
}

/**
 * Initializes lazy loading for images using Intersection Observer.
 */
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
        // Fallback for browsers that don't support IntersectionObserver
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
            image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; 
            image.alt = 'Image failed to load';
        };
        image.removeAttribute('data-src');
    }
}

/**
 * Sends a request to delete an image.
 * @param {string} imageUrl - URL of the image to delete.
 */
function deleteImage(imageUrl) {
    if (!confirm('Are you sure you want to delete this image? This action cannot be undone.')) {
        return;
    }

    const data = { imagePath: imageUrl };

    fetch('/admin/delete-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include' // Include cookies for admin authentication
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(text || 'Deletion failed.');
            });
        }
        // Deletion successful, the server will broadcast the deletion
        console.log('Image deletion requested successfully.');
    })
    .catch(err => {
        console.error('Error deleting image:', err);
        alert(`Error deleting image: ${err.message}`);
    });
}

/**
 * Removes an image from the local gallery view.
 * @param {string} filename - The filename of the image to remove.
 */
function removeImageFromGallery(filename) {
    const gallery = document.getElementById('gallery');
    const items = gallery.getElementsByClassName('gallery-item');

    for (let item of items) {
        const img = item.querySelector('img');
        const src = img.src;
        const currentFilename = src.split('/').pop();

        if (currentFilename === filename) {
            gallery.removeChild(item);
            break;
        }
    }

    // Optionally, you can check if the gallery is empty now
    if (gallery.children.length === 0) {
        displayNoImagesMessage();
    }
}

/**
 * Fetches approved images from the server and renders the gallery.
 */
async function fetchApprovedImages() {
    try {
        const response = await fetch('/get-images', {
            method: 'GET',
            credentials: 'omit' // No credentials needed as /get-images is public
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Clear any existing content and error messages
        clearError();

        if (!data.images || data.images.length === 0) {
            // No images returned yet
            displayNoImagesMessage();
            return;
        }

        // Filter out items without valid image URLs
        approvedImages = data.images.filter(item => item.image);

        if (approvedImages.length === 0) {
            // No valid images found at this time
            displayNoImagesMessage();
            return;
        }

        renderGallery(approvedImages);
    } catch (error) {
        console.error('Error fetching images:', error);
        displayNoImagesMessage();
    }
}

/**
 * Renders the gallery with the provided images.
 * Includes delete buttons for each image.
 */
function renderGallery(images) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '';
    gallery.setAttribute('role', 'list'); // Mark the gallery as a list of images

    if (!images || images.length === 0) {
        displayNoImagesMessage();
        return;
    }

    const totalImages = images.length;

    images.forEach((item, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.classList.add('gallery-item');
        itemDiv.setAttribute('role', 'listitem'); // Each item is a list item
        itemDiv.setAttribute('aria-label', `Gallery image ${index + 1} of ${totalImages}`);

        // Create and append the image number
        const imageNumber = document.createElement('div');
        imageNumber.classList.add('image-number');
        imageNumber.textContent = `Image ${index + 1}/${totalImages}`;
        itemDiv.appendChild(imageNumber);

        // Create and append the image
        const img = document.createElement('img');

        if (item.image && item.image !== 'undefined') {
            img.setAttribute('data-src', item.image);

            // Initial alt text indicating position in the gallery
            img.alt = `Gallery Image ${index + 1}`;
        } else {
            console.warn(`Image source is undefined for item at index ${index}.`);
            // Transparent placeholder image
            img.setAttribute('data-src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
            img.alt = 'Image not available';
        }

        // Placeholder image (transparent pixel)
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

        itemDiv.appendChild(img);

        // Create and append the associated text
        const textPara = document.createElement('p');
        if (item.text) {
            // Fetch the associated text content to update alt text with descriptive prompt
            fetch(item.text, {
                method: 'GET',
                credentials: 'omit' // Public text files
            })
                .then(textResponse => {
                    if (!textResponse.ok) {
                        throw new Error(`Failed to load text. Status: ${textResponse.status}`);
                    }
                    return textResponse.text();
                })
                .then(txt => {
                    textPara.textContent = txt;

                    // Update the alt text of the image with the prompt for better accessibility
                    img.alt = txt || `Gallery Image ${index + 1}`;
                })
                .catch(textError => {
                    console.error('Error fetching associated text:', textError);
                    textPara.textContent = 'No associated text available.';
                });
        } else {
            textPara.textContent = 'No associated text available.';
        }

        itemDiv.appendChild(textPara);

        // Create and append the Delete button
        const deleteButton = document.createElement('button');
        deleteButton.classList.add('delete-button');
        deleteButton.textContent = 'Delete';
        deleteButton.setAttribute('aria-label', `Delete Image ${index + 1}`);
        deleteButton.onclick = () => deleteImage(item.image);

        itemDiv.appendChild(deleteButton);

        gallery.appendChild(itemDiv);
    });

    // Initialize lazy loading after gallery is populated
    initializeLazyLoading();
}

/**
 * Initializes lazy loading for images using Intersection Observer.
 */
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
        // Fallback for browsers that don't support IntersectionObserver
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
            image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; 
            image.alt = 'Image failed to load';
        };
        image.removeAttribute('data-src');
    }
}

/**
 * Sends a request to delete an image.
 * @param {string} imageUrl - URL of the image to delete.
 */
function deleteImage(imageUrl) {
    if (!confirm('Are you sure you want to delete this image? This action cannot be undone.')) {
        return;
    }

    const data = { imagePath: imageUrl };

    fetch('/admin/delete-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include' // Include cookies for admin authentication
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(text || 'Deletion failed.');
            });
        }
        // Deletion successful, the server will broadcast the deletion
        console.log('Image deletion requested successfully.');
    })
    .catch(err => {
        console.error('Error deleting image:', err);
        alert(`Error deleting image: ${err.message}`);
    });
}

/**
 * Removes an image from the local gallery view.
 * @param {string} filename - The filename of the image to remove.
 */
function removeImageFromGallery(filename) {
    const gallery = document.getElementById('gallery');
    const items = gallery.getElementsByClassName('gallery-item');

    for (let item of items) {
        const img = item.querySelector('img');
        const src = img.src;
        const currentFilename = src.split('/').pop();

        if (currentFilename === filename) {
            gallery.removeChild(item);
            break;
        }
    }

    // Optionally, you can check if the gallery is empty now
    if (gallery.children.length === 0) {
        displayNoImagesMessage();
    }
}

/**
 * Fetches approved images from the server and renders the gallery.
 */
async function fetchApprovedImages() {
    try {
        const response = await fetch('/get-images', {
            method: 'GET',
            credentials: 'omit' // No credentials needed as /get-images is public
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Clear any existing content and error messages
        clearError();

        if (!data.images || data.images.length === 0) {
            // No images returned yet
            displayNoImagesMessage();
            return;
        }

        // Filter out items without valid image URLs
        approvedImages = data.images.filter(item => item.image);

        if (approvedImages.length === 0) {
            // No valid images found at this time
            displayNoImagesMessage();
            return;
        }

        renderGallery(approvedImages);
    } catch (error) {
        console.error('Error fetching images:', error);
        displayNoImagesMessage();
    }
}

/**
 * Renders the gallery with the provided images.
 * Includes delete buttons for each image.
 */
function renderGallery(images) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '';
    gallery.setAttribute('role', 'list'); // Mark the gallery as a list of images

    if (!images || images.length === 0) {
        displayNoImagesMessage();
        return;
    }

    const totalImages = images.length;

    images.forEach((item, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.classList.add('gallery-item');
        itemDiv.setAttribute('role', 'listitem'); // Each item is a list item
        itemDiv.setAttribute('aria-label', `Gallery image ${index + 1} of ${totalImages}`);

        // Create and append the image number
        const imageNumber = document.createElement('div');
        imageNumber.classList.add('image-number');
        imageNumber.textContent = `Image ${index + 1}/${totalImages}`;
        itemDiv.appendChild(imageNumber);

        // Create and append the image
        const img = document.createElement('img');

        if (item.image && item.image !== 'undefined') {
            img.setAttribute('data-src', item.image);

            // Initial alt text indicating position in the gallery
            img.alt = `Gallery Image ${index + 1}`;
        } else {
            console.warn(`Image source is undefined for item at index ${index}.`);
            // Transparent placeholder image
            img.setAttribute('data-src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
            img.alt = 'Image not available';
        }

        // Placeholder image (transparent pixel)
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

        itemDiv.appendChild(img);

        // Create and append the associated text
        const textPara = document.createElement('p');
        if (item.text) {
            // Fetch the associated text content to update alt text with descriptive prompt
            fetch(item.text, {
                method: 'GET',
                credentials: 'omit' // Public text files
            })
                .then(textResponse => {
                    if (!textResponse.ok) {
                        throw new Error(`Failed to load text. Status: ${textResponse.status}`);
                    }
                    return textResponse.text();
                })
                .then(txt => {
                    textPara.textContent = txt;

                    // Update the alt text of the image with the prompt for better accessibility
                    img.alt = txt || `Gallery Image ${index + 1}`;
                })
                .catch(textError => {
                    console.error('Error fetching associated text:', textError);
                    textPara.textContent = 'No associated text available.';
                });
        } else {
            textPara.textContent = 'No associated text available.';
        }

        itemDiv.appendChild(textPara);

        // Create and append the Delete button
        const deleteButton = document.createElement('button');
        deleteButton.classList.add('delete-button');
        deleteButton.textContent = 'Delete';
        deleteButton.setAttribute('aria-label', `Delete Image ${index + 1}`);
        deleteButton.onclick = () => deleteImage(item.image);

        itemDiv.appendChild(deleteButton);

        gallery.appendChild(itemDiv);
    });

    // Initialize lazy loading after gallery is populated
    initializeLazyLoading();
}

/**
 * Initializes lazy loading for images using Intersection Observer.
 */
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
        // Fallback for browsers that don't support IntersectionObserver
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
            image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; 
            image.alt = 'Image failed to load';
        };
        image.removeAttribute('data-src');
    }
}

/**
 * Sends a request to delete an image.
 * @param {string} imageUrl - URL of the image to delete.
 */
function deleteImage(imageUrl) {
    if (!confirm('Are you sure you want to delete this image? This action cannot be undone.')) {
        return;
    }

    const data = { imagePath: imageUrl };

    fetch('/admin/delete-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include' // Include cookies for admin authentication
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => {
                throw new Error(text || 'Deletion failed.');
            });
        }
        // Deletion successful, the server will broadcast the deletion
        console.log('Image deletion requested successfully.');
    })
    .catch(err => {
        console.error('Error deleting image:', err);
        alert(`Error deleting image: ${err.message}`);
    });
}

/**
 * Removes an image from the local gallery view.
 * @param {string} filename - The filename of the image to remove.
 */
function removeImageFromGallery(filename) {
    const gallery = document.getElementById('gallery');
    const items = gallery.getElementsByClassName('gallery-item');

    for (let item of items) {
        const img = item.querySelector('img');
        const src = img.src;
        const currentFilename = src.split('/').pop();

        if (currentFilename === filename) {
            gallery.removeChild(item);
            break;
        }
    }

    // Optionally, you can check if the gallery is empty now
    if (gallery.children.length === 0) {
        displayNoImagesMessage();
    }
}

/**
 * Fetches approved images from the server and renders the gallery.
 */
async function fetchApprovedImages() {
    try {
        const response = await fetch('/get-images', {
            method: 'GET',
            credentials: 'omit' // No credentials needed as /get-images is public
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Clear any existing content and error messages
        clearError();

        if (!data.images || data.images.length === 0) {
            // No images returned yet
            displayNoImagesMessage();
            return;
        }

        // Filter out items without valid image URLs
        approvedImages = data.images.filter(item => item.image);

        if (approvedImages.length === 0) {
            // No valid images found at this time
            displayNoImagesMessage();
            return;
        }

        renderGallery(approvedImages);
    } catch (error) {
        console.error('Error fetching images:', error);
        displayNoImagesMessage();
    }
}

/**
 * Displays an error message to the user.
 * The errorMessage element should have role="alert" and aria-live="polite" in HTML.
 */
function displayError(message) {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block'; 
        // Screen readers will announce the new error due to role="alert" and aria-live
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

/**
 * Displays a message indicating that no images are currently available.
 * Mark this message with role="status" or aria-live in the HTML to let users know it's updating.
 */
function displayNoImagesMessage() {
    const gallery = document.getElementById('gallery');
    if (gallery) {
        // This message updates regularly, so aria-live on #gallery or parent would help announce changes
        gallery.innerHTML = `<p>Loading images, please wait...</p>`;
    }
}