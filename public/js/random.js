document.addEventListener('DOMContentLoaded', async () => {
    await loadPlaceholderImages();
    document.getElementById('newImageButton').addEventListener('click', startRandomSpin);
    // Do not automatically start spin on page load
});

let placeholderImages = [];
let didSpin = false; // Track if a spin actually occurred before final image load

async function loadPlaceholderImages() {
    try {
        const response = await fetch('/get-images');
        if (!response.ok) throw new Error(`Failed to load images. Status: ${response.status}`);
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

    // Reset state
    imageElement.classList.remove('final-image-pulse');
    imageElement.src = '';
    imageElement.alt = '';
    textElement.textContent = '';
    errorMessage.textContent = '';
    didSpin = false; // Reset the flag at the start

    if (placeholderImages.length === 0) {
        // If no placeholders, directly fetch final image (no pulse)
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
            // Spinning sequence is complete
            didSpin = true; // Set didSpin to true after spinning completes
            // After spinning finishes, fetch the final image
            fetchFinalRandomImage();
        }
    }

    spinStep();
}

async function fetchFinalRandomImage() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');

    let imageLoaded = false;
    let textLoaded = false;

    // Only apply pulse if we actually spun before final load
    function tryApplyPulse() {
        if (didSpin && imageLoaded && textLoaded) {
            // Stack multiple requestAnimationFrames and add a slight delay
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        imageElement.classList.add('final-image-pulse');
                    }, 50); // Adjust delay as necessary
                });
            });
        }
    }

    try {
        const response = await fetch('/random-image');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();

        // Cache-bust final image load
        imageElement.src = data.image + '?t=' + Date.now();
        imageElement.alt = 'Final Random Image';

        imageElement.onload = () => {
            imageLoaded = true;
            tryApplyPulse();
        };

        if (data.text) {
            // Cache-bust text as well
            const textUrl = data.text + '?t=' + Date.now();
            const textResponse = await fetch(textUrl);
            if (!textResponse.ok) throw new Error(`Failed to load text. Status: ${textResponse.status}`);
            const textData = await textResponse.text();
            textElement.textContent = textData;
            imageElement.alt = textData;
        } else {
            textElement.textContent = 'No associated text available.';
        }

        textLoaded = true;
        tryApplyPulse();

    } catch (error) {
        console.error('Error fetching random image:', error);
        errorMessage.textContent = 'Failed to load random image. Please try again later.';
    }
}

