// public/js/random.js

document.addEventListener('DOMContentLoaded', () => {
    fetchRandomImage();
    document.getElementById('newImageButton').addEventListener('click', fetchRandomImage);
});

async function fetchRandomImage() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('imageText');
    const errorMessage = document.getElementById('errorMessage');

    // Reset content
    imageElement.src = '';
    imageElement.alt = ''; // Clear alt text
    textElement.textContent = '';
    errorMessage.textContent = '';

    try {
        const response = await fetch('/random-image');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        imageElement.src = data.image;

        if (data.text) {
            const textResponse = await fetch(data.text);
            if (!textResponse.ok) {
                throw new Error(`Failed to load text. Status: ${textResponse.status}`);
            }
            const textData = await textResponse.text();
            textElement.textContent = textData;

            // Set the alt text of the image to the text of the prompt
            imageElement.alt = textData;
        } else {
            textElement.textContent = 'No associated text available.';
            imageElement.alt = 'Random Image'; // Default alt text if no prompt available
        }

        imageElement.onload = () => {
            imageElement.style.opacity = '1';
        };
    } catch (error) {
        console.error('Error fetching random image:', error);
        errorMessage.textContent = 'Failed to load random image. Please try again later.';
    }
}
