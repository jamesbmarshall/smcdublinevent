require('dotenv').config(); // Load env variables

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

// Validate required env variables
if (
    !AZURE_STORAGE_CONNECTION_STRING ||
    !AZURE_STORAGE_ACCOUNT_NAME ||
    !ADMIN_PASSWORD ||
    !SESSION_SECRET ||
    !MICROSOFT_CLIENT_ID ||
    !MICROSOFT_CLIENT_SECRET ||
    !MICROSOFT_CALLBACK_URL
) {
    console.error('Missing required env vars. Check .env file.');
    process.exit(1);
}

const app = express();

// Azure Blob Service
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

// Container clients
const imagesContainerClient = blobServiceClient.getContainerClient('images');
const pendingContainerClient = blobServiceClient.getContainerClient('pending');
const tokensContainerClient = blobServiceClient.getContainerClient('tokens');

// Ensure containers
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

// Helpers
async function listBlobs(containerClient) {
    const blobs = [];
    for await (const blob of containerClient.listBlobsFlat()) {
        blobs.push(blob.name);
    }
    return blobs;
}

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

// Token Store
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
    await blockBlobClient.uploadData(Buffer.from(updatedContent), {
        blobHTTPHeaders: { blobContentType: "application/json" }
    });
    console.log('Token store updated successfully.');
}

// ================
// In-Memory Logic
// ================
// Each item: { blobName, lockedBy: string|null, lockedAt: number|null }
let inMemoryPending = []; 
const adminLoadMap = {}; // Tracks how many items each admin currently has locked

function rebuildAdminLoadCounts() {
    // Clear all
    for (const key in adminLoadMap) {
        adminLoadMap[key] = 0;
    }
    // Re-count
    inMemoryPending.forEach(item => {
        if (item.lockedBy) {
            adminLoadMap[item.lockedBy] = (adminLoadMap[item.lockedBy] || 0) + 1;
        }
    });
}

function getAllConnectedAdminIds() {
    // We'll store them in a Map: ws -> adminId
    return Array.from(adminClientsMap.values());
}

/**
 * For each unassigned item, find the admin with the fewest items, lock it to them.
 */
function distributeNewItems() {
    const admins = getAllConnectedAdminIds();
    if (admins.length === 0) return;

    rebuildAdminLoadCounts();

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

// Session config
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// Security middlewares
app.use(helmet({
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
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer for image uploads
const storage = multer.memoryStorage();
const uploadMulter = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'), false);
        }
        cb(null, true);
    }
});

// Ex: random image route
app.get('/random-image', async (req, res) => {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
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
            return res.status(404).json({ error: 'Associated text file not found.' });
        }
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(textFilename)}`;
        res.json({ image: imageUrl, text: textUrl });
    } catch (error) {
        console.error('Error fetching random image:', error);
        res.status(500).json({ error: 'Failed to fetch random image.' });
    }
});

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

function requireAdminAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.status(403).send('Access denied. Not authenticated as admin.');
}

// Serve static
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Auth routes
app.get('/login', passport.authenticate('microsoft'));
app.get('/auth/microsoft/callback',
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
            console.error('Auth callback error:', error);
            res.status(500).send('Authentication error.');
        }
    }
);

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.get('/', (req, res) => {
    res.redirect('index.html');
});

// Upload page
app.get('/upload', ensureAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'protected-user', 'upload.html'));
});

// Upload endpoint
app.post('/upload-image', ensureAuthenticated, uploadMulter.single('image'), async (req, res) => {
    try {
        const userToken = req.user.id;
        const store = await readTokenStore();

        if (store[userToken] === true) {
            console.warn(`User with ID ${userToken} tried multiple submissions.`);
            return res.status(403).send('You have already submitted a response.');
        }

        const textRaw = req.body.text;
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }
        if (!textRaw) {
            return res.status(400).send('No text content provided.');
        }
        if (textRaw.length > 1000) {
            return res.status(400).send('Text too long.');
        }

        // Sanitize text
        const textContent = textRaw.replace(/<[^>]*>?/gm, '');
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

        // Upload to 'pending'
        const imageBlobClient = pendingContainerClient.getBlockBlobClient(imageFilename);
        await imageBlobClient.uploadData(imageBuffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype }
        });
        console.log(`Uploaded image: ${imageFilename} to 'pending'.`);

        const textBlobClient = pendingContainerClient.getBlockBlobClient(textFilename);
        await textBlobClient.uploadData(Buffer.from(textContent), {
            blobHTTPHeaders: { blobContentType: 'text/plain' }
        });
        console.log(`Uploaded text file: ${textFilename} to 'pending'.`);

        // Mark user as having submitted
        store[userToken] = true;
        await writeTokenStore(store);

        // Insert into inMemory
        inMemoryPending.push({
            blobName: imageFilename,
            lockedBy: null,
            lockedAt: null
        });

        // Re-distribute
        distributeNewItems();

        // Notify admins
        broadcastPendingImages();

        res.status(200).send('Image + text uploaded; pending approval.');
    } catch (error) {
        console.error('Error uploading image:', error);
        res.status(500).send('Server error.');
    }
});

// Rate-limit admin login attempts
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many admin login attempts. Wait 15 min.'
});

// Admin login
app.post('/admin/login', adminLoginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        console.log('Admin logged in.');
        return res.redirect('/admin');
    } else {
        return res.status(401).send('Incorrect password.');
    }
});

// Admin logout
app.post('/admin/logout', requireAdminAuth, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Admin logout error:', err);
            return res.status(500).send('Error logging out.');
        }
        res.clearCookie('connect.sid');
        console.log('Admin logged out.');
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <link rel="stylesheet" href="/styles/styles.css">
            <head><title>Admin Logout</title></head>
            <body>
                <h1>Admin Logout</h1>
                <p>Logged out successfully.</p>
                <span id="footer"><a href="https://go.microsoft.com/fwlink/?linkid=2259814">Consumer Health Privacy</a> | <a href="https://go.microsoft.com/fwlink/?LinkedId=521839">Privacy & Cookies</a> | <a href="https://go.microsoft.com/fwlink/?LinkID=206977">Terms Of Use</a> | <a href="https://go.microsoft.com/fwlink/?linkid=2196228">Trademarks</a> | &copy; Microsoft 2025</span>
            </body>
            </html>
        `);
    });
});

// Admin page
app.get('/admin', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.sendFile(path.join(__dirname, 'protected-admin', 'admin.html'));
    } else {
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <link rel="stylesheet" href="/styles/styles.css">
            <head><title>Admin Login</title></head>
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

// Admin endpoint to fetch pending images (fallback for older code)
app.get('/admin/pending-images', requireAdminAuth, async (req, res) => {
    try {
        const blobs = await listBlobs(pendingContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
        const images = imageBlobs.map(b => 
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(b)}`
        );
        res.json({ pendingImages: images });
    } catch (error) {
        console.error('Error fetching pending images:', error);
        res.status(500).json({ error: 'Failed to fetch pending images.' });
    }
});

// Wait for a blob copy to finish
async function waitForBlobExistence(containerClient, blobName, description) {
    let exists = false;
    let attempts = 0;
    const maxAttempts = 30;
    const interval = 1000;

    while (!exists && attempts < maxAttempts) {
        attempts++;
        const blobClient = containerClient.getBlockBlobClient(blobName);
        exists = await blobClient.exists();
        console.log(`${description} copy check #${attempts}: exists=${exists}`);
        if (!exists) await new Promise(r => setTimeout(r, interval));
    }
    if (!exists) {
        throw new Error(`${description} copy did not complete in time.`);
    }
}

// Admin approve
app.post('/admin/approve-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Approving image: ${filename} + text: ${textFilename}`);

        const sourceImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const destImageBlob = imagesContainerClient.getBlockBlobClient(filename);
        const imageExists = await sourceImageBlob.exists();
        if (!imageExists) {
            throw new Error(`Image ${filename} not found in 'pending'.`);
        }

        // Copy image
        const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(filename)}`;
        await destImageBlob.startCopyFromURL(imageUrl);
        await waitForBlobExistence(imagesContainerClient, filename, 'Image');

        // Copy text
        const sourceTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);
        const textExists = await sourceTextBlob.exists();
        if (!textExists) {
            throw new Error(`Text file ${textFilename} not found in 'pending'.`);
        }
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(textFilename)}`;
        const destTextBlob = imagesContainerClient.getBlockBlobClient(textFilename);
        await destTextBlob.startCopyFromURL(textUrl);
        await waitForBlobExistence(imagesContainerClient, textFilename, 'Text file');

        // Delete pending
        await sourceImageBlob.deleteIfExists();
        await sourceTextBlob.deleteIfExists();

        // Remove from inMemoryPending
        inMemoryPending = inMemoryPending.filter(item => item.blobName !== filename);

        broadcastNewImages();
        broadcastPendingImages();

        console.log(`Approved: ${filename}`);
        res.status(200).send('Image approved.');
    } catch (error) {
        console.error('Error approving image:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Admin deny
app.post('/admin/deny-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }

    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        const pendingImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const pendingTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);

        await pendingImageBlob.deleteIfExists();
        await pendingTextBlob.deleteIfExists();

        // Remove from inMemoryPending
        inMemoryPending = inMemoryPending.filter(item => item.blobName !== filename);

        broadcastPendingImages();
        res.status(200).send('Image and text denied/removed.');
    } catch (error) {
        console.error('Error denying image:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// get-images route
app.get('/get-images', async (req, res) => {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
        const imagesWithTexts = [];
        for (const b of imageBlobs) {
            const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(b)}`;
            const baseName = b.substring(0, b.lastIndexOf('.'));
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

// Start the server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// ================
// WebSocket Setup
// ================
const wss = new WebSocket.Server({ server });
const clients = new Set();
const adminClients = new Set();
const adminClientsMap = new Map(); // ws -> adminId

wss.on('connection', ws => {
    console.log('WebSocket client connected.');

    ws.on('message', async msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'admin') {
                console.log('Admin WS client connected.');
                // Mark as admin
                adminClients.add(ws);

                // Generate or re-use an admin ID
                const adminId = `admin_${Math.random().toString(36).substr(2, 9)}`;
                adminClientsMap.set(ws, adminId);

                console.log(`Admins: ${adminClients.size}, Clients: ${clients.size}`);

                // Re-distribute items now that a new admin joined
                distributeNewItems();

                // Send the newly assigned items to this admin
                await sendPendingImages(ws);
            } else if (data.type === 'ping') {
                // Heartbeat
                ws.send(JSON.stringify({ type: 'pong' }));
            } else {
                // Regular client
                clients.add(ws);
                console.log(`Regular client connected. Admins: ${adminClients.size}, Clients: ${clients.size}`);
                await sendImages(ws);
            }
        } catch (error) {
            console.error('Error parsing WS message:', error);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        adminClients.delete(ws);

        // If it was an admin, remove from the map, and unlock items
        const adminId = adminClientsMap.get(ws);
        if (adminId) {
            adminClientsMap.delete(ws);
            // Unlock items
            inMemoryPending.forEach(item => {
                if (item.lockedBy === adminId) {
                    item.lockedBy = null;
                    item.lockedAt = null;
                }
            });
            // Re-distribute so other admins might get them
            distributeNewItems();
        }

        console.log('WS client disconnected.');
        console.log(`Admins: ${adminClients.size}, Clients: ${clients.size}`);
    });
});

// ================
// WebSocket Helpers
// ================

// Send all approved images to a WS client
async function sendImages(ws) {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
        const images = imageBlobs.map(b =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(b)}`
        );
        ws.send(JSON.stringify({ images }));
    } catch (error) {
        console.error('Error in sendImages:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch images.' }));
    }
}

// Send items locked to this admin
async function sendPendingImages(ws) {
    try {
        // Get adminId for this WS
        const adminId = adminClientsMap.get(ws);
        if (!adminId) {
            ws.send(JSON.stringify({ pendingImages: [] }));
            return;
        }

        // Filter items locked to this admin
        const lockedItems = inMemoryPending.filter(it => it.lockedBy === adminId);

        // Convert to { url, lockedBy }
        const images = lockedItems.map(it => ({
            url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(it.blobName)}`,
            lockedBy: it.lockedBy
        }));

        ws.send(JSON.stringify({ pendingImages: images }));
    } catch (error) {
        console.error('Error in sendPendingImages:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch locked images.' }));
    }
}

// Broadcast newly approved images to non-admin clients
async function broadcastNewImages() {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
        const images = imageBlobs.map(b =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(b)}`
        );
        const msg = JSON.stringify({ images });

        // Send to regular clients
        clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) {
                c.send(msg);
            }
        });
    } catch (error) {
        console.error('Error broadcasting new images:', error);
    }
}

// Broadcast updated pending items to all admins (but each admin only sees their locked items on next step)
async function broadcastPendingImages() {
    // For each admin, just call sendPendingImages again
    adminClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            sendPendingImages(ws);
        }
    });
}