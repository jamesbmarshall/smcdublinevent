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

// ===========================
// Azure Blob Service Setup
// ===========================
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
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

// ===========================
// Token Store (Azure + JSON)
// ===========================
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

async function readTokenStore() {
    const tokenBlobName = 'tokenStore.json';
    const blockBlobClient = tokensContainerClient.getBlockBlobClient(tokenBlobName);
    const downloadResponse = await blockBlobClient.download(0);
    const content = (await streamToBuffer(downloadResponse.readableStreamBody)).toString('utf8');
    return JSON.parse(content);
}

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
        throw error;
    }
}

// ===========================
// In-Memory "Pending" Logic
// ===========================
// Store for newly uploaded images that we want to distribute among admins
// Each item: { blobName, lockedBy: string|null, lockedAt: number|null }
let inMemoryPending = [];

// Keep track of how many images each admin is assigned
const adminLoadMap = {};

// Recompute admin load counts
function rebuildAdminLoadCounts() {
    // Reset all
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

// Returns array of admin IDs that are currently connected
function getAllConnectedAdminIds() {
    return Array.from(adminClientsMap.values());
}

/**
 * Distributes any unclaimed items to whichever admin has the fewest assigned items.
 * Then updates each admin client with its newly assigned items.
 */
function distributeNewItems() {
    const admins = getAllConnectedAdminIds();
    if (admins.length === 0) return; // No admins connected?

    rebuildAdminLoadCounts();

    // For each unclaimed item
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
    // After distributing, re-send each admin their locked items
    for (const [ws, adminId] of adminClientsMap.entries()) {
        sendPendingImages(ws); // This sends the items locked to adminId
    }
}

/**
 * Sync existing pending images from Azure container into our in-memory list on server startup
 * so we don't lose older items.
 */
async function syncExistingPending() {
    try {
        const blobs = await listBlobs(pendingContainerClient);
        const jpgs = blobs.filter(name => name.endsWith('.jpg'));

        for (const blobName of jpgs) {
            const alreadyExists = inMemoryPending.some(x => x.blobName === blobName);
            if (!alreadyExists) {
                inMemoryPending.push({
                    blobName,
                    lockedBy: null,
                    lockedAt: null
                });
            }
        }
        // Distribute them among any currently connected admins
        distributeNewItems();
        console.log('Synced existing pending images from Azure into memory.');
    } catch (err) {
        console.error('Error syncing existing pending images:', err);
    }
}

// ===========================
// Express + Session + Helmet
// ===========================
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

// ===========================
// Multer for Uploads
// ===========================
const storage = multer.memoryStorage();
const uploadMulter = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'), false);
        }
        cb(null, true);
    }
});

// ===========================
// Authentication Middleware
// ===========================
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

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
            </body>
            </html>
        `);
}

// ===========================
// Routes
// ===========================
// 1) Sync containers + token store
ensureContainers()
  .then(() => initializeTokenStore())
  .then(() => syncExistingPending()) // load older items from Azure => inMemory
  .catch(err => {
    console.error('Server startup error:', err);
    process.exit(1);
  });

// 2) Public random-image
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
            console.warn(`No associated text for ${randomImage}.`);
            return res.status(404).json({ error: 'Associated text file not found.' });
        }
        
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(textFilename)}`;
        res.json({ image: imageUrl, text: textUrl });
    } catch (error) {
        console.error('Error fetching random image:', error);
        res.status(500).json({ error: 'Failed to fetch random image.' });
    }
});

// 3) Auth routes
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
            console.error('Error during auth callback:', error);
            res.status(500).send('Authentication error.');
        }
    }
);

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// 4) Public
app.get('/', (req, res) => {
    res.redirect('index.html');
});

// 5) Protected Upload
app.get('/upload', ensureAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'protected-user', 'upload.html'));
});

app.post(
    '/upload-image',
    ensureAuthenticated,
    uploadMulter.single('image'),
    async (req, res) => {
        try {
            const userToken = req.user.id;
            const store = await readTokenStore();

            if (store[userToken] === true) {
                console.warn(`User with ID ${userToken} tried multiple submissions.`);
                return res.status(403).send('You have already submitted a response.');
            }

            if (!req.file) {
                return res.status(400).send('No file uploaded.');
            }
            const textContentRaw = req.body.text;
            if (!textContentRaw) {
                return res.status(400).send('No text content provided.');
            }
            if (textContentRaw.length > 1000) {
                return res.status(400).send('Text too long.');
            }

            // Sanitize text
            const textContent = textContentRaw.replace(/<[^>]*>?/gm, '');
            const imageBuffer = req.file.buffer;
            const image = sharp(imageBuffer);
            const metadata = await image.metadata();
            if (metadata.width !== metadata.height) {
                return res.status(400).send('Image must be square.');
            }

            const timestamp = Date.now();
            const baseFilename = `image_${timestamp}`;
            const imageFilename = `${baseFilename}.jpg`;
            const textFilename = `${baseFilename}.txt`;

            // Upload image
            const imageBlobClient = pendingContainerClient.getBlockBlobClient(imageFilename);
            await imageBlobClient.uploadData(imageBuffer, {
                blobHTTPHeaders: { blobContentType: req.file.mimetype },
            });
            console.log(`Uploaded image: ${imageFilename} to 'pending' container.`);

            // Upload text
            const textBlobClient = pendingContainerClient.getBlockBlobClient(textFilename);
            await textBlobClient.uploadData(Buffer.from(textContent), {
                blobHTTPHeaders: { blobContentType: 'text/plain' },
            });
            console.log(`Uploaded text file: ${textFilename} to 'pending' container.`);

            store[userToken] = true;
            await writeTokenStore(store);
            console.log(`User with ID ${userToken} marked as submitted.`);

            // Insert into inMemory + distribute
            inMemoryPending.push({
                blobName: imageFilename,
                lockedBy: null,
                lockedAt: null
            });
            distributeNewItems();

            // Notify admin clients about new item
            broadcastPendingImages();

            res.status(200).send('Image and text uploaded successfully and are pending approval.');
        } catch (error) {
            console.error('Error uploading image:', error);
            res.status(500).send('Server error occurred.');
        }
    }
);

// 6) Admin login + logout
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts from this IP. Please try again later.'
});

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
            <title>Admin Logout</title>
            </head>
            <body>
                <h1>Admin Logout</h1>
                <p>Logged out successfully.</p>
            </body>
            </html>
        `);
    });
});

app.get('/admin', requireAdminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'protected-admin', 'admin-gallery.html'));
});

// 7) Approve / Deny
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

// Approve
app.post('/admin/approve-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Approving image: ${filename} and text: ${textFilename}`);

        const sourceImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const destImageBlob = imagesContainerClient.getBlockBlobClient(filename);

        // Ensure the .jpg file exists
        const imageExists = await sourceImageBlob.exists();
        if (!imageExists) {
            throw new Error(`Image ${filename} not found in 'pending'.`);
        }

        const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(filename)}`;
        await destImageBlob.startCopyFromURL(imageUrl);
        console.log(`Started image copy from ${imageUrl} to images container.`);
        await waitForBlobExistence(imagesContainerClient, filename, 'Image');

        // Copy text
        const sourceTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);
        const destTextBlob = imagesContainerClient.getBlockBlobClient(textFilename);
        const textExists = await sourceTextBlob.exists();
        if (!textExists) {
            throw new Error(`Text file ${textFilename} not found in 'pending' container.`);
        }
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(textFilename)}`;
        await destTextBlob.startCopyFromURL(textUrl);
        console.log(`Started text copy from ${textUrl} to images container.`);
        await waitForBlobExistence(imagesContainerClient, textFilename, 'Text file');

        console.log('Both copies done; deleting source...');
        await sourceImageBlob.deleteIfExists();
        await sourceTextBlob.deleteIfExists();

        // Also remove from inMemoryPending
        inMemoryPending = inMemoryPending.filter(item => item.blobName !== filename);

        // Notify regular clients about new image, and admins about updated pending
        broadcastNewImages();
        broadcastPendingImages();

        res.status(200).send('Image approved successfully.');
    } catch (error) {
        console.error('Error approving image:', error);
        res.status(500).send(`Error approving image: ${error.message}`);
    }
});

// Deny
app.post('/admin/deny-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Denying image: ${filename} and text: ${textFilename}`);

        // Delete .jpg and .txt from 'pending'
        await pendingContainerClient.getBlockBlobClient(filename).deleteIfExists();
        await pendingContainerClient.getBlockBlobClient(textFilename).deleteIfExists();

        // Remove from memory
        inMemoryPending = inMemoryPending.filter(item => item.blobName !== filename);

        broadcastPendingImages();
        res.status(200).send('Image and associated text denied and removed.');
    } catch (error) {
        console.error('Error denying image:', error);
        res.status(500).send(`Error denying image: ${error.message}`);
    }
});

// 8) Public endpoint to get all approved images
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
            }
        }

        res.json({ images: imagesWithTexts });
    } catch (error) {
        console.error('Error fetching images:', error);
        res.status(500).json({ error: 'Failed to fetch images.' });
    }
});

// 9) Admin Delete Endpoint
app.post('/admin/delete-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Deleting image: ${filename} and text: ${textFilename}`);

        // Delete .jpg and .txt from 'images' container
        const imageBlobClient = imagesContainerClient.getBlockBlobClient(filename);
        const textBlobClient = imagesContainerClient.getBlockBlobClient(textFilename);

        await imageBlobClient.deleteIfExists();
        await textBlobClient.deleteIfExists();

        console.log(`Deleted ${filename} and ${textFilename} from 'images' container.`);

        // Notify all admin clients about the deletion
        broadcastImageDeletion(filename);

        res.status(200).send('Image and associated text deleted successfully.');
    } catch (error) {
        console.error('Error deleting image:', error);
        res.status(500).send(`Error deleting image: ${error.message}`);
    }
});

// ===========================
// Start Server
// ===========================
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// ===========================
// WebSocket Setup
// ===========================
const wss = new WebSocket.Server({ server });
const clients = new Set();
const adminClients = new Set();

// Keep a map from ws -> adminId
const adminClientsMap = new Map();

wss.on('connection', ws => {
    console.log('WebSocket client connected.');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'admin') {
                console.log('Admin WebSocket client connected.');
                adminClients.add(ws);

                // Generate unique ID for this admin
                const adminId = `admin_${Math.random().toString(36).substr(2, 9)}`;
                adminClientsMap.set(ws, adminId);

                console.log(`Assigned adminId=${adminId}. Admin count=${adminClients.size}, client count=${clients.size}`);

                // Distribute unclaimed items
                distributeNewItems();

                // Send them their locked items
                await sendPendingImages(ws);

            } else if (data.type === 'client') {
                // Regular gallery client
                clients.add(ws);
                console.log(`Regular client connected. Admins=${adminClients.size}, clients=${clients.size}`);
                await sendImages(ws);
            } else if (data.type === 'ping') {
                // Heartbeat
                ws.send(JSON.stringify({ type: 'pong' }));
            } else {
                console.warn('Unknown message type:', data);
            }
        } catch (error) {
            console.error('Error parsing WS message:', error);
        }
    });

    ws.on('close', () => {
        adminClients.delete(ws);
        clients.delete(ws);

        const adminId = adminClientsMap.get(ws);
        if (adminId) {
            adminClientsMap.delete(ws);
            // Unlock items from this admin
            inMemoryPending.forEach(item => {
                if (item.lockedBy === adminId) {
                    item.lockedBy = null;
                    item.lockedAt = null;
                }
            });
            // Redistribute to remaining admins
            distributeNewItems();
        }

        console.log(`WS client disconnected. Admins=${adminClients.size}, clients=${clients.size}`);
    });
});

// ===========================
// WebSocket Helpers
// ===========================

// Send all approved images to a WS client
async function sendImages(ws) {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const images = imageBlobs.map(blob =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(blob)}`
        );
        ws.send(JSON.stringify({ images }));
    } catch (error) {
        console.error('Error sending images:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch images.' }));
    }
}

/**
 * Send *this* admin's locked items from inMemoryPending. 
 * We convert each locked item => { url, lockedBy } so the admin can see them.
 */
async function sendPendingImages(ws) {
    try {
        // Identify admin
        const adminId = adminClientsMap.get(ws);
        if (!adminId) {
            ws.send(JSON.stringify({ pendingImages: [] }));
            return;
        }
        // Filter items locked to this admin
        const lockedItems = inMemoryPending.filter(item => item.lockedBy === adminId);

        // Convert each to { url, lockedBy }
        const images = lockedItems.map(item => ({
            url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(item.blobName)}`,
            lockedBy: item.lockedBy
        }));

        ws.send(JSON.stringify({ pendingImages: images }));
    } catch (error) {
        console.error('Error sending locked images:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch locked images.' }));
    }
}

/**
 * Broadcast newly approved images to all non-admin clients
 */
async function broadcastNewImages() {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(blob => blob.endsWith('.jpg'));
        const images = imageBlobs.map(blob =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(blob)}`
        );
        const message = JSON.stringify({ images });

        // Send to regular clients
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    } catch (error) {
        console.error('Error broadcasting new images:', error);
    }
}

/**
 * Broadcast updated pending items to all admin clients
 */
async function broadcastPendingImages() {
    try {
        // For each admin, send their locked items
        adminClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                sendPendingImages(ws);
            }
        });
    } catch (error) {
        console.error('Error broadcasting pending images:', error);
    }
}

/**
 * Broadcast image deletion to all admin clients
 * @param {string} filename - The name of the deleted image file
 */
function broadcastImageDeletion(filename) {
    const message = JSON.stringify({ type: 'imageDeleted', filename });

    adminClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}