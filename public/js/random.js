document.addEventListener('DOMContentLoaded', () => {
    const newImageButton = document.getElementById('newImageButton');
    newImageButton.addEventListener('click', fetchRandomImageWithSpinner);
});

/**
 * Fetch a random image and its text, show a spinner while loading.
 */
async function fetchRandomImageWithSpinner() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');
    const spinnerOverlay = document.getElementById('spinnerOverlay');

    // Reset any old content
    imageElement.src = '';
    imageElement.alt = '';
    textElement.textContent = '';
    errorMessage.textContent = '';

    // Show the spinner
    spinnerOverlay.classList.add('showSpinner');

    try {
        // Fetch /random-image (Server endpoint)
        const response = await fetch('/random-image');
        if (!response.ok) {
            throw new Error(`Failed to fetch random image. Status: ${response.status}`);
        }

        const data = await response.json();
        // Add a cache-buster
        const finalImageUrl = data.image + '?t=' + Date.now();
        const finalTextUrl = data.text ? data.text + '?t=' + Date.now() : null;

        // Load the final image
        imageElement.src = finalImageUrl;
        imageElement.alt = 'Loading random image...';

        // When the image finishes loading, hide the spinner
        imageElement.onload = () => {
            spinnerOverlay.classList.remove('showSpinner');
            imageElement.alt = 'Random Image'; // Final alt text
        };

        // Fetch and display the associated text if available
        if (finalTextUrl) {
            const textResponse = await fetch(finalTextUrl);
            if (!textResponse.ok) {
                throw new Error(`Failed to load text. Status: ${textResponse.status}`);
            }
            const textData = await textResponse.text();
            textElement.textContent = textData;
        } else {
            textElement.textContent = 'No associated text available.';
        }

    } catch (error) {
        console.error('Error:', error);
        errorMessage.textContent = 'Failed to load the image. Please try again later.';
        // Hide the spinner on error
        spinnerOverlay.classList.remove('showSpinner');
    }
}