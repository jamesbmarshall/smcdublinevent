document.addEventListener('DOMContentLoaded', () => {
    const newImageButton = document.getElementById('newImageButton');
    newImageButton.addEventListener('click', fetchRandomImage);
  });
  
  async function fetchRandomImage() {
    const imageElement = document.getElementById('randomImage');
    const textElement = document.getElementById('associatedText');
    const errorMessage = document.getElementById('errorMessage');
  
    // Clear any existing content from a previous load
    imageElement.src = '';
    imageElement.alt = 'Random Image';
    textElement.textContent = '';
    errorMessage.textContent = '';
  
    try {
      // Fetch the random image data from your server
      const response = await fetch('/random-image');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
  
      const data = await response.json();
      // Cache-bust the image to avoid stale caching
      imageElement.src = data.image + '?t=' + Date.now();
  
      // If there's a text file, fetch and display it
      if (data.text) {
        const textResponse = await fetch(data.text + '?t=' + Date.now());
        if (!textResponse.ok) {
          throw new Error(`Failed to load text. Status: ${textResponse.status}`);
        }
        const textData = await textResponse.text();
        textElement.textContent = textData;
        imageElement.alt = textData; // Optional: alt can be the text
      } else {
        textElement.textContent = 'No associated text available.';
      }
  
    } catch (error) {
      console.error('Error fetching random image:', error);
      errorMessage.textContent = 'Failed to load random image. Please try again later.';
    }
  }