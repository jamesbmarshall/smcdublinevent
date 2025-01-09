require('dotenv').config(); // Load environment variables

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const WebSocket = require('ws');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const passport = require('./passport'); // Import the configured Passport instance
const { BlobServiceClient } = require('@azure/storage-blob');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
    AZURE_STORAGE_CONNECTION_STRING,
    AZURE_STORAGE_ACCOUNT_NAME,
    ADMIN_PASSWORD,
    SESSION_SECRET,
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_CALLBACK_URL,
    PORT = 8080,
} = process.env;

// Validate required environment variables
if (
    !AZURE_STORAGE_CONNECTION_STRING ||
    !AZURE_STORAGE_ACCOUNT_NAME ||
    !ADMIN_PASSWORD ||
    !SESSION_SECRET ||
    !MICROSOFT_CLIENT_ID ||
    !MICROSOFT_CLIENT_SECRET ||
    !MICROSOFT_CALLBACK_URL
) {
    console.error(
        'Missing required environment variables. Please ensure all necessary variables are set in the .env file.'
    );
    process.exit(1);
}

const app = express();

// Initialize Azure Blob Service Client
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

// Define container clients
const imagesContainerClient = blobServiceClient.getContainerClient('images');
const pendingContainerClient = blobServiceClient.getContainerClient('pending');
const tokensContainerClient = blobServiceClient.getContainerClient('tokens');

// Ensure required containers exist
async function ensureContainers() {
    const containers = [
        { client: imagesContainerClient, name: 'images' },
        { client: pendingContainerClient, name: 'pending' },
        { client: tokensContainerClient, name: 'tokens' }
    ];

    for (const { client, name } of containers) {
        const exists = await client.exists();
        if (!exists) {
            await client.create();
            console.log(`Container "${name}" created.`);
        } else {
            console.log(`Container "${name}" already exists.`);
        }
    }
}
ensureContainers().catch(err => {
    console.error('Error ensuring containers:', err);
    process.exit(1);
});

// Helper function to list all blobs in a container
async function listBlobs(containerClient) {
    const blobs = [];
    for await (const blob of containerClient.listBlobsFlat()) {
        blobs.push(blob.name);
    }
    return blobs;
}

// Helper function to convert a readable stream to a buffer
async function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', data => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on('end', () => resolve(Buffer.concat(chunks)));
        readableStream.on('error', reject);
    });
}

// Initialize token store if not present
async function initializeTokenStore() {
    const tokenBlobName = 'tokenStore.json';
    const blockBlobClient = tokensContainerClient.getBlockBlobClient(tokenBlobName);
    const exists = await blockBlobClient.exists();
    if (!exists) {
        await blockBlobClient.uploadData(Buffer.from('{}'), {
            blobHTTPHeaders: { blobContentType: "application/json" }
        });
        console.log('Initialized tokenStore.json in Blob Storage.');
    } else {
        console.log('tokenStore.json already exists.');
    }
}
initializeTokenStore().catch(err => {
    console.error('Error initializing token store:', err);
    process.exit(1);
});

// Function to read the token store
async function readTokenStore() {
    const tokenBlobName = 'tokenStore.json';
    const blockBlobClient = tokensContainerClient.getBlockBlobClient(tokenBlobName);
    const downloadResponse = await blockBlobClient.download(0);
    const content = (await streamToBuffer(downloadResponse.readableStreamBody)).toString('utf8');
    return JSON.parse(content);
}

// Function to write to the token store
async function writeTokenStore(store) {
    const tokenBlobName = 'tokenStore.json';
    const blockBlobClient = tokensContainerClient.getBlockBlobClient(tokenBlobName);
    const updatedContent = JSON.stringify(store, null, 2);
    try {
        await blockBlobClient.uploadData(Buffer.from(updatedContent), {
            blobHTTPHeaders: { blobContentType: "application/json" }
        });
        console.log('Token store updated successfully.');
    } catch (error) {
        console.error('Failed to write token store:', error);
        throw error; // Re-throw to be caught by outer try-catch
    }
}

// ================
//  In-Memory Logic
// ================
// Store for newly uploaded images that we want to distribute among admins
// Each item: { blobName, lockedBy: string|null, lockedAt: number|null }
let inMemoryPending = [];

// Keep track of how many images each admin is assigned, so we can distribute
const adminLoadMap = {};

// Recompute admin load counts
function rebuildAdminLoadCounts() {
    // Clear
    for (const key in adminLoadMap) {
        adminLoadMap[key] = 0;
    }
    // For each item in memory, increment the assigned admin's count
    inMemoryPending.forEach(item => {
        if (item.lockedBy) {
            adminLoadMap[item.lockedBy] = (adminLoadMap[item.lockedBy] || 0) + 1;
        }
    });
}

function getAllConnectedAdminIds() {
    return Array.from(adminClientsMap.values());
}

/**
 * Distributes unassigned items to whichever admin has the fewest assigned items.
 */
function distributeNewItems() {
    const admins = getAllConnectedAdminIds();
    if (admins.length === 0) return;

    // Rebuild counts first
    rebuildAdminLoadCounts();

    // For each unclaimed item, find the admin with the smallest load
    for (const item of inMemoryPending) {
        if (!item.lockedBy) {
            let targetAdmin = null;
            let minLoad = Infinity;

            for (const adminId of admins) {
                const load = adminLoadMap[adminId] || 0;
                if (load < minLoad) {
                    minLoad = load;
                    targetAdmin = adminId;
                }
            }
            if (targetAdmin) {
                item.lockedBy = targetAdmin;
                item.lockedAt = Date.now();
                adminLoadMap[targetAdmin] = (adminLoadMap[targetAdmin] || 0) + 1;
            }
        }
    }
}

// Session configuration
app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { 
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            sameSite: 'lax'
        }
    })
);

// Initialize Passport and restore authentication state
app.use(passport.initialize());
app.use(passport.session());

app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "img-src": [
            "'self'",
            "data:",
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`
          ],
          "connect-src": [
            "'self'",
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`
          ],
        },
      },
    })
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Multer setup for image uploads
const storage = multer.memoryStorage();
const uploadMulter = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'), false);
        }
        cb(null, true);
    }
});

// Public endpoint to get a random approved image and its associated text
app.get('/random-image', async (req, res) => {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        if (imageBlobs.length === 0) {
            return res.status(404).json({ error: 'No images found' });
        }
        const randomImage = imageBlobs[Math.floor(Math.random() * imageBlobs.length)];
        const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(randomImage)}`;
        
        const baseName = randomImage.substring(0, randomImage.lastIndexOf('.'));
        const textFilename = `${baseName}.txt`;
        const textBlobClient = imagesContainerClient.getBlockBlobClient(textFilename);
        const textExists = await textBlobClient.exists();
        
        if (!textExists) {
            console.warn(`Associated text file ${textFilename} not found for image ${randomImage}.`);
            return res.status(404).json({ error: 'Associated text file not found.' });
        }
        
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(textFilename)}`;
        res.json({ image: imageUrl, text: textUrl });
    } catch (error) {
        console.error('Error fetching random image:', error);
        res.status(500).json({ error: 'Failed to fetch random image.' });
    }
});

// Authentication middleware
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

// Admin authentication middleware
function requireAdminAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="en">
            <link rel="stylesheet" href="/styles/styles.css">
            <title>Admin Login</title>
            </head>
            <body>
                <h1>Admin</h1>
                <p>Access denied. Not authenticated as an admin.</p>
                 <span id="footer"><a href="https://go.microsoft.com/fwlink/?linkid=2259814">Consumer Health Privacy</a> | <a href="https://go.microsoft.com/fwlink/?LinkedId=521839">Privacy & Cookies</a> | <a href="https://go.microsoft.com/fwlink/?LinkID=206977">Terms Of Use</a> | <a href="https://go.microsoft.com/fwlink/?linkid=2196228">Trademarks</a> | &copy; Microsoft 2025</span>
            </body>
            </html>
        `);
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html']
}));

// Authentication Routes
app.get('/login', passport.authenticate('microsoft'));
app.get(
    '/auth/microsoft/callback',
    passport.authenticate('microsoft', { failureRedirect: '/login' }),
    async (req, res) => {
        try {
            const userToken = req.user.id; 
            req.userToken = userToken;

            const store = await readTokenStore();
            if (store[userToken] === true) {
                console.warn(`User with ID ${userToken} has already submitted.`);
            }
            res.redirect('/upload');
        } catch (error) {
            console.error('Error during authentication callback:', error);
            res.status(500).send('Authentication error.');
        }
    }
);

// Logout Route (Optional)
app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// Public Routes
app.get('/', (req, res) => {
    res.redirect('index.html');
});

// Protected Upload Routes
app.get('/upload', ensureAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'protected-user', 'upload.html'));
});

// 1) Insert newly uploaded item into inMemory + auto-distribute
app.post(
    '/upload-image',
    ensureAuthenticated,
    uploadMulter.single('image'),
    async (req, res) => {
        try {
            const userToken = req.user.id;
            const store = await readTokenStore();

            if (store[userToken] === true) {
                console.warn(`User with ID ${userToken} attempted multiple submissions.`);
                return res.status(403).send('You have already submitted a response.');
            }

            const textContentRaw = req.body.text;
            if (!req.file) {
                console.warn('Upload attempt without image file.');
                return res.status(400).send('No file uploaded.');
            }
            if (!textContentRaw) {
                console.warn('Upload attempt without text content.');
                return res.status(400).send('No text content provided.');
            }
            if (textContentRaw.length > 1000) {
                console.warn('Upload attempt with excessively long text.');
                return res.status(400).send('Text too long.');
            }

            const textContent = textContentRaw.replace(/<[^>]*>?/gm, '');
            const imageBuffer = req.file.buffer;
            const image = sharp(imageBuffer);
            const metadata = await image.metadata();
            if (metadata.width !== metadata.height) {
                console.warn('Uploaded image is not square.');
                return res.status(400).send('Image must be square.');
            }

            const timestamp = Date.now();
            const baseFilename = `image_${timestamp}`;
            const imageFilename = `${baseFilename}.jpg`;
            const textFilename = `${baseFilename}.txt`;

            // Upload .jpg to 'pending'
            const imageBlobClient = pendingContainerClient.getBlockBlobClient(imageFilename);
            await imageBlobClient.uploadData(imageBuffer, {
                blobHTTPHeaders: { blobContentType: req.file.mimetype },
            });
            console.log(`Uploaded image: ${imageFilename} to 'pending' container.`);

            // Upload .txt to 'pending'
            const textBlobClient = pendingContainerClient.getBlockBlobClient(textFilename);
            await textBlobClient.uploadData(Buffer.from(textContent), {
                blobHTTPHeaders: { blobContentType: 'text/plain' },
            });
            console.log(`Uploaded text file: ${textFilename} to 'pending' container.`);

            // Mark user as having submitted
            store[userToken] = true;
            await writeTokenStore(store);

            // 2) Insert into inMemoryPending
            inMemoryPending.push({
                blobName: imageFilename,
                lockedBy: null,
                lockedAt: null
            });

            // 3) Distribute newly added item to an admin with fewest load
            distributeNewItems();

            console.log(`User with ID ${userToken} marked as submitted.`);
            broadcastPendingImages();

            res.status(200).send('Image and text uploaded successfully and are pending approval.');
        } catch (error) {
            console.error('Error uploading image:', error);
            res.status(500).send('Server error occurred.');
        }
    }
);

// Rate limit
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts from this IP. Please try again later.'
});

// Admin login route
app.post('/admin/login', adminLoginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        console.log('Admin logged in.');
        return res.redirect('/admin');
    } else {
        console.warn('Admin login attempt failed.');
        return res.status(401).send('Incorrect password.');
    }
});

// Admin logout route
app.post('/admin/logout', requireAdminAuth, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error during admin logout:', err);
            return res.status(500).send('Error logging out.');
        }
        res.clearCookie('connect.sid');
        console.log('Admin logged out.');
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <link rel="stylesheet" href="/styles/styles.css">
            <title>Admin Login</title>
            </head>
            <body>
                <h1>Admin Logout</h1>
                <p>Logged out successfully.</p>
                 <span id="footer"><a href="https://go.microsoft.com/fwlink/?linkid=2259814">Consumer Health Privacy</a> | <a href="https://go.microsoft.com/fwlink/?LinkedId=521839">Privacy & Cookies</a> | <a href="https://go.microsoft.com/fwlink/?LinkID=206977">Terms Of Use</a> | <a href="https://go.microsoft.com/fwlink/?linkid=2196228">Trademarks</a> | &copy; Microsoft 2025</span>
            </body>
            </html>
        `);
    });
});

// Serve admin page
app.get('/admin', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.sendFile(path.join(__dirname, 'protected-admin', 'admin.html'));
    } else {
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <link rel="stylesheet" href="/styles/styles.css">
            <title>Admin Login</title>
            </head>
            <body>
                <h1>Admin Login</h1>
                <form method="POST" action="/admin/login">
                    <input type="password" name="password" placeholder="Admin Password" required>
                    <button type="submit">Login</button>
                </form>
                 <span id="footer"><a href="https://go.microsoft.com/fwlink/?linkid=2259814">Consumer Health Privacy</a> | <a href="https://go.microsoft.com/fwlink/?LinkedId=521839">Privacy & Cookies</a> | <a href="https://go.microsoft.com/fwlink/?LinkID=206977">Terms Of Use</a> | <a href="https://go.microsoft.com/fwlink/?linkid=2196228">Trademarks</a> | &copy; Microsoft 2025</span>
            </body>
            </html>
        `);
    }
});

// Admin endpoint to fetch pending images
app.get('/admin/pending-images', requireAdminAuth, async (req, res) => {
    try {
        // STILL listing from Azure so existing logic isn't broken
        const blobs = await listBlobs(pendingContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const images = imageBlobs.map(blob =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(blob)}`
        );
        res.json({ pendingImages: images });
    } catch (error) {
        console.error('Error fetching pending images:', error);
        res.status(500).json({ error: 'Failed to fetch pending images.' });
    }
});

// Helper function to wait for a blob to appear in the destination container
async function waitForBlobExistence(containerClient, blobName, description) {
    let exists = false;
    let attempts = 0;
    const maxAttempts = 30;
    const interval = 1000;

    while (!exists && attempts < maxAttempts) {
        attempts++;
        try {
            const blobClient = containerClient.getBlockBlobClient(blobName);
            exists = await blobClient.exists();
            console.log(`${description} copy check #${attempts}: exists=${exists}`);
            if (exists) break;
        } catch (error) {
            console.error(`Error checking existence for ${description}:`, error);
            throw error;
        }
        await new Promise(r => setTimeout(r, interval));
    }

    if (!exists) {
        throw new Error(`${description} copy did not complete in time.`);
    }
}

// Admin approve image endpoint
app.post('/admin/approve-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        console.warn('Approve image request without imagePath.');
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Approving image: ${filename} and text: ${textFilename}`);

        const sourceImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const destImageBlob = imagesContainerClient.getBlockBlobClient(filename);

        const imageExists = await sourceImageBlob.exists();
        if (!imageExists) {
            throw new Error(`Image file ${filename} not found in 'pending' container.`);
        }

        const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(filename)}`;
        console.log(`Starting image copy from ${imageUrl} to ${destImageBlob.url}`);

        await destImageBlob.startCopyFromURL(imageUrl);
        console.log(`Image copy initiated for ${filename}. Waiting...`);
        await waitForBlobExistence(imagesContainerClient, filename, 'Image');

        const sourceTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);
        const destTextBlob = imagesContainerClient.getBlockBlobClient(textFilename);
        const textExists = await sourceTextBlob.exists();
        if (!textExists) {
            throw new Error(`Text file ${textFilename} not found in 'pending' container.`);
        }
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(textFilename)}`;
        console.log(`Starting text file copy from ${textUrl} to ${destTextBlob.url}`);
        await destTextBlob.startCopyFromURL(textUrl);
        console.log(`Text file copy initiated for ${textFilename}. Waiting...`);
        await waitForBlobExistence(imagesContainerClient, textFilename, 'Text file');

        console.log('Both copies succeeded. Deleting source blobs...');
        await sourceImageBlob.deleteIfExists();
        await sourceTextBlob.deleteIfExists();
        console.log(`Deleted image: ${filename} and text: ${textFilename}`);

        broadcastNewImages();
        broadcastPendingImages();

        console.log('Image approved successfully.');
        res.status(200).send('Image approved successfully.');
    } catch (error) {
        console.error('Error approving image:', error);
        res.status(500).send(`Error approving image: ${error.message}`);
    }
});

// Admin deny image endpoint
app.post('/admin/deny-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        console.warn('Deny image request without imagePath.');
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        const pendingImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const pendingTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);

        console.log(`Denying image: ${filename} and text: ${textFilename}`);

        await pendingImageBlob.deleteIfExists();
        console.log(`Deleted image: ${filename} from 'pending' container.`);

        await pendingTextBlob.deleteIfExists();
        console.log(`Deleted text file: ${textFilename} from 'pending' container.`);

        broadcastPendingImages();
        res.status(200).send('Image and associated text denied and removed.');
    } catch (error) {
        console.error('Error denying image:', error);
        res.status(500).send(`Error denying image: ${error.message}`);
    }
});

// Public endpoint to get all approved images and their associated texts
app.get('/get-images', async (req, res) => {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const imagesWithTexts = [];

        for (const imageBlob of imageBlobs) {
            const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(imageBlob)}`;
            
            const baseName = imageBlob.substring(0, imageBlob.lastIndexOf('.'));
            const textFilename = `${baseName}.txt`;
            const textBlobClient = imagesContainerClient.getBlockBlobClient(textFilename);
            const textExists = await textBlobClient.exists();
            
            if (textExists) {
                const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(textFilename)}`;
                imagesWithTexts.push({ image: imageUrl, text: textUrl });
            } else {
                imagesWithTexts.push({ image: imageUrl, text: null });
                console.warn(`No associated text file found for image: ${imageBlob}`);
            }
        }

        res.json({ images: imagesWithTexts });
    } catch (error) {
        console.error('Error fetching approved images and texts:', error);
        res.status(500).json({ error: 'Failed to fetch approved images and texts.' });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// WebSocket Setup
const wss = new WebSocket.Server({ server });
const clients = new Set();
const adminClients = new Set();

// For "automatic distribution," we need to identify each admin
// so we can store lockedBy. We'll keep a map from WebSocket -> adminId
const adminClientsMap = new Map();

wss.on('connection', ws => {
    console.log('WebSocket client connected.');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'admin') {
                console.log('Admin WebSocket client connected.');
                adminClients.add(ws);

                // Generate a simple unique adminId
                const adminId = `admin_${Math.random().toString(36).substr(2, 9)}`;
                adminClientsMap.set(ws, adminId);

                console.log(`Current Admin Clients: ${adminClients.size}, Current Clients: ${clients.size}`);

                // Attempt to distribute any unassigned items
                distributeNewItems();

                // Send pending images from container, unchanged
                await sendPendingImages(ws);
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            } else {
                clients.add(ws);
                console.log(`Regular client connected. Current Admin Clients: ${adminClients.size}, Current Clients: ${clients.size}`);
                await sendImages(ws);
            }
        } catch (error) {
            console.error('Error parsing message from WebSocket client:', error);
        }
    });

    ws.on('close', () => {
        adminClients.delete(ws);
        clients.delete(ws);

        // If it was an admin, remove from the map
        const adminId = adminClientsMap.get(ws);
        if (adminId) {
            adminClientsMap.delete(ws);
            // Optionally, unlock items assigned to them
            inMemoryPending.forEach(item => {
                if (item.lockedBy === adminId) {
                    item.lockedBy = null;
                    item.lockedAt = null;
                }
            });
            distributeNewItems();
        }

        console.log(`WebSocket client disconnected.`);
        console.log(`Current Admin Clients: ${adminClients.size}, Current Clients: ${clients.size}`);
    });
});

// Function to send all approved images to a WebSocket client
async function sendImages(ws) {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const images = imageBlobs.map(blob =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(blob)}`
        );
        ws.send(JSON.stringify({ images }));
    } catch (error) {
        console.error('Error sending images via WebSocket:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch images.' }));
    }
}

// Function to send all pending images to an admin WebSocket client (still uses Azure listing)
async function sendPendingImages(ws) {
    try {
        // 1) Get this admin's ID
        const adminId = adminClientsMap.get(ws);
        if (!adminId) {
            // If we don't have an ID, do nothing
            ws.send(JSON.stringify({ pendingImages: [] }));
            return;
        }

        // 2) Filter only items locked to this admin
        const lockedItems = inMemoryPending.filter(item => item.lockedBy === adminId);

        // 3) Convert to full pending URLs
        const images = lockedItems.map(item =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(item.blobName)}`
        );

        // 4) Send those to the admin
        ws.send(JSON.stringify({ pendingImages: images }));

    } catch (error) {
        console.error('Error sending locked images:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch locked images.' }));
    }
}

// Broadcast new approved images to all non-admin clients
async function broadcastNewImages() {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const images = imageBlobs.map(blob =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(blob)}`
        );
        const message = JSON.stringify({ images });

        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    } catch (error) {
        console.error('Error broadcasting new images:', error);
    }
}

// Broadcast updated pending images to all admin clients, as before
async function broadcastPendingImages() {
    try {
        const blobs = await listBlobs(pendingContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const images = imageBlobs.map(blob =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(blob)}`
        );
        const message = JSON.stringify({ pendingImages: images });

        adminClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    } catch (error) {
        console.error('Error broadcasting pending images:', error);
    }
}