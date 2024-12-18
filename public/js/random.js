document.addEventListener('DOMContentLoaded', async () => {
    await loadPlaceholderImages();
    document.getElementById('newImageButton').addEventListener('click', startRandomSpin);
    startRandomSpin();
});

let placeholderImages = [];

async function loadPlaceholderImages() {
    try {
        const response = await fetch('/get-images');
        if (!response.ok) {
            throw new Error(`Failed to load images. Status: ${response.status}`);
        }
        const data = await response.json();
        placeholderImages = data.images.map(item => item.image).filter(Boolean);
        if (placeholderImages.length === 0) {
            console.warn('No approved images found. Using a fallback placeholder.');
            placeholderImages = ['/images/fallback.jpg'];
        }
    } catch (error) {
        console.error('Error fetching placeholder images:', error);
        placeholderImages = ['/images/fallback.jpg'];
    }
}

function startRandomSpin() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');

    // Reset content
    imageElement.classList.remove('final-image-pulse');
    imageElement.src = '';
    imageElement.alt = '';
    textElement.textContent = '';
    errorMessage.textContent = '';

    if (placeholderImages.length === 0) {
        return fetchFinalRandomImage();
    }

    let interval = 100;
    let spinCount = 0;
    const maxSpins = 10;

    function spinStep() {
        const randomPlaceholder = placeholderImages[Math.floor(Math.random() * placeholderImages.length)];
        imageElement.src = randomPlaceholder;
        imageElement.alt = 'Spinning...';

        spinCount++;
        if (spinCount < maxSpins) {
            interval += 100; 
            setTimeout(spinStep, interval);
        } else {
            fetchFinalRandomImage();
        }
    }

    spinStep();
}

async function fetchFinalRandomImage() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');

    // Flags to track loading
    let imageLoaded = false;
    let textLoaded = false;

    // A helper function to check both flags and apply the pulse
    function tryApplyPulse() {
        if (imageLoaded && textLoaded) {
            imageElement.classList.add('final-image-pulse');
        }
    }

    try {
        const response = await fetch('/random-image');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        // Set the final image with a cache-buster
        imageElement.src = data.image + '?t=' + Date.now(); 
        imageElement.alt = 'Final Random Image';

        // Wait for the image to load
        imageElement.onload = () => {
            imageLoaded = true;
            tryApplyPulse();
        };

        // Fetch the associated text if it exists
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

        // Now the text is considered loaded
        textLoaded = true;
        tryApplyPulse();

    } catch (error) {
        console.error('Error fetching random image:', error);
        errorMessage.textContent = 'Failed to load random image. Please try again later.';
    }
}