// public/js/random.js

document.addEventListener('DOMContentLoaded', async () => {
    await loadPlaceholderImages();
    document.getElementById('newImageButton').addEventListener('click', startRandomSpin);
    // Optionally start a spin on page load:
    startRandomSpin();
});

// Global array to store approved images for placeholders
let placeholderImages = [];

/**
 * Fetches the list of approved images from the server and stores them
 * in the placeholderImages array for use as spinning placeholders.
 */
async function loadPlaceholderImages() {
    try {
        const response = await fetch('/get-images');
        if (!response.ok) {
            throw new Error(`Failed to load images. Status: ${response.status}`);
        }
        const data = await response.json();
        // Extract just the image URLs
        placeholderImages = data.images.map(item => item.image).filter(Boolean);
        if (placeholderImages.length === 0) {
            console.warn('No approved images found. Using a fallback placeholder.');
            // If no images are found, use a single fallback image or skip spinning
            placeholderImages = ['/images/fallback.jpg']; // Replace with a real fallback image URL
        }
    } catch (error) {
        console.error('Error fetching placeholder images:', error);
        // If an error occurs, use a fallback
        placeholderImages = ['/images/fallback.jpg']; // Make sure this exists
    }
}

/**
 * Starts the slot-machine style spin by rapidly cycling through placeholder images,
 * gradually slowing down, and then fetching the final random image.
 */
function startRandomSpin() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');

    // Reset content
    imageElement.src = '';
    imageElement.alt = '';
    textElement.textContent = '';
    errorMessage.textContent = '';
    imageElement.classList.remove('final-image-pulse'); // Remove pulse effect if previously applied

    // If we have no placeholders, just fetch the final image
    if (placeholderImages.length === 0) {
        return fetchFinalRandomImage();
    }

    let interval = 100; // Start fast
    let spinCount = 0;
    const maxSpins = 10; // Number of steps before final image is fetched

    function spinStep() {
        // Pick a random placeholder image
        const randomPlaceholder = placeholderImages[Math.floor(Math.random() * placeholderImages.length)];
        imageElement.src = randomPlaceholder;
        imageElement.alt = 'Spinning...';
        imageElement.style.opacity = '1';

        spinCount++;
        if (spinCount < maxSpins) {
            // Increase interval to slow down the spin
            interval += 100; 
            setTimeout(spinStep, interval);
        } else {
            // Finished spinning, now fetch the final random image
            fetchFinalRandomImage();
        }
    }

    spinStep(); // Start the spin
}

/**
 * Fetches the final random image from the server and updates the UI accordingly.
 * Once the image is loaded, applies a pulse animation to indicate completion.
 */
async function fetchFinalRandomImage() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');

    try {
        const response = await fetch('/random-image');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        imageElement.src = data.image;
        imageElement.alt = 'Final Random Image';
        imageElement.style.opacity = '1';

        if (data.text) {
            const textResponse = await fetch(data.text);
            if (!textResponse.ok) {
                throw new Error(`Failed to load text. Status: ${textResponse.status}`);
            }
            const textData = await textResponse.text();
            textElement.textContent = textData;
            imageElement.alt = textData;
        } else {
            textElement.textContent = 'No associated text available.';
        }

        // Once the final image is fully loaded, apply a pulse effect
        imageElement.onload = () => {
            imageElement.classList.add('final-image-pulse');
        };

    } catch (error) {
        console.error('Error fetching random image:', error);
        errorMessage.textContent = 'Failed to load random image. Please try again later.';
    }
}