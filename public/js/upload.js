// upload.js

document.addEventListener('DOMContentLoaded', () => {
    const uploadForm = document.getElementById('upload-form');
    const imageInput = document.getElementById('imageInput');
    const textInput = document.getElementById('textInput');
    const messageDiv = document.getElementById('message');

    uploadForm.addEventListener('submit', async (event) => {
        event.preventDefault(); // Prevent default form submission

        // Clear previous messages
        messageDiv.textContent = '';
        messageDiv.classList.remove('success', 'error');

        // Validate form inputs
        if (!imageInput.files || imageInput.files.length === 0) {
            messageDiv.textContent = 'Please select an image to upload.';
            messageDiv.classList.add('error');
            return;
        }

        const imageFile = imageInput.files[0];
        const textContent = textInput.value.trim();

        if (textContent.length === 0) {
            messageDiv.textContent = 'Please enter associated text.';
            messageDiv.classList.add('error');
            return;
        }

        if (textContent.length > 1000) {
            messageDiv.textContent = 'Text exceeds the maximum allowed length of 1000 characters.';
            messageDiv.classList.add('error');
            return;
        }

        // Prepare form data
        const formData = new FormData();
        formData.append('image', imageFile);
        formData.append('text', textContent);

        try {
            const response = await fetch('/upload-image', {
                method: 'POST',
                body: formData,
                //credentials: 'include' // Include cookies for authentication
            });

            if (response.ok) {
                messageDiv.textContent = 'Image and text uploaded successfully and are pending approval.';
                messageDiv.classList.add('success');
                // Reset the form
                uploadForm.reset();
            } else {
                const errorText = await response.text();
                messageDiv.textContent = `Upload failed: ${errorText}`;
                messageDiv.classList.add('error');
            }
        } catch (error) {
            console.error('Error during upload:', error);
            messageDiv.textContent = 'An error occurred during the upload. Please try again.';
            messageDiv.classList.add('error');
        }
    });

      // Logout button event listener
      const logoutButton = document.getElementById('logout-button');
      logoutButton.addEventListener('click', function() {
          fetch('/logout', {
              method: 'GET',
              //credentials: 'include' // Include cookies in the request
          })
          .then(response => {
              if (response.redirected) {
                  // Redirect to the response URL (e.g., homepage)
                  window.location.href = response.url;
              } else {
                  // Handle non-redirect responses if necessary
                  console.error('Logout failed.');
              }
          })
          .catch(error => {
              console.error('Error logging out:', error);
          });
      });
});


  
