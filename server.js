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
    console.error('Missing required environment variables in .env.');
    process.exit(1);
}

const app = express();

// =====================================
//      Azure Blob Service Setup
// =====================================
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const imagesContainerClient = blobServiceClient.getContainerClient('images');
const pendingContainerClient = blobServiceClient.getContainerClient('pending');
const tokensContainerClient = blobServiceClient.getContainerClient('tokens');

// Ensure required containers exist
async function ensureContainers() {
    const containers = [
        { client: imagesContainerClient,   name: 'images' },
        { client: pendingContainerClient,  name: 'pending' },
        { client: tokensContainerClient,   name: 'tokens'  }
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
    console.error('Error ensuring containers exist:', err);
    process.exit(1);
});

// Helper function to list blobs in a container
async function listBlobs(containerClient) {
    const blobs = [];
    for await (const blob of containerClient.listBlobsFlat()) {
        blobs.push(blob.name);
    }
    return blobs;
}

// Converts a ReadableStream to Buffer
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

// =====================================
//   Token Store in Azure Blob
// =====================================
async function initializeTokenStore() {
    const blockBlobClient = tokensContainerClient.getBlockBlobClient('tokenStore.json');
    const exists = await blockBlobClient.exists();
    if (!exists) {
        await blockBlobClient.uploadData(Buffer.from('{}'), {
            blobHTTPHeaders: { blobContentType: 'application/json' }
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
    const blockBlobClient = tokensContainerClient.getBlockBlobClient('tokenStore.json');
    const downloadResponse = await blockBlobClient.download(0);
    const content = (await streamToBuffer(downloadResponse.readableStreamBody)).toString('utf8');
    return JSON.parse(content);
}

async function writeTokenStore(store) {
    const blockBlobClient = tokensContainerClient.getBlockBlobClient('tokenStore.json');
    const data = JSON.stringify(store, null, 2);
    await blockBlobClient.uploadData(Buffer.from(data), {
        blobHTTPHeaders: { blobContentType: 'application/json' }
    });
    console.log('Token store updated successfully.');
}

// =====================================
//  In-Memory Distribution Logic
// =====================================
// Each item: { blobName, lockedBy, lockedAt }
let inMemoryPending = [];

// Track how many images each admin currently holds
const adminLoadMap = {};

// Recompute admin load counts
function rebuildAdminLoadCounts() {
    // Reset all known admin IDs to 0
    for (const key in adminLoadMap) {
        adminLoadMap[key] = 0;
    }
    // Count how many items are locked by each admin
    for (const item of inMemoryPending) {
        if (item.lockedBy) {
            adminLoadMap[item.lockedBy] = (adminLoadMap[item.lockedBy] || 0) + 1;
        }
    }
}

function getAllConnectedAdminIds() {
    return Array.from(adminClientsMap.values());
}

/**
 * Distribute unclaimed items (lockedBy === null) to whichever admin 
 * has the fewest items in memory
 */
function distributeNewItems() {
    const admins = getAllConnectedAdminIds();
    if (admins.length === 0) return; // No admins connected

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
                console.log(`Assigned ${item.blobName} to admin ${targetAdmin}`);
            }
        }
    }
}

// =====================================
//   Express + Session + Passport
// =====================================
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

// =====================================
//   Helmet, CORS, Body Parsers
// =====================================
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

// =====================================
//  Multer Setup
// =====================================
const storage = multer.memoryStorage();
const uploadMulter = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed.'), false);
        }
        cb(null, true);
    }
});

// =====================================
//  Public Endpoint: /random-image
// =====================================
app.get('/random-image', async (req, res) => {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
        if (imageBlobs.length === 0) {
            return res.status(404).json({ error: 'No images found.' });
        }
        const randomImage = imageBlobs[Math.floor(Math.random() * imageBlobs.length)];
        const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(randomImage)}`;

        const baseName = randomImage.substring(0, randomImage.lastIndexOf('.'));
        const textFilename = `${baseName}.txt`;
        const textBlobClient = imagesContainerClient.getBlockBlobClient(textFilename);
        if (!(await textBlobClient.exists())) {
            console.warn(`No associated text for ${randomImage}`);
            return res.status(404).json({ error: 'Associated text not found.' });
        }
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(textFilename)}`;
        res.json({ image: imageUrl, text: textUrl });
    } catch (error) {
        console.error('Error in /random-image:', error);
        res.status(500).json({ error: 'Failed to fetch a random image.' });
    }
});

// =====================================
//  Auth & Admin Middlewares
// =====================================
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

function requireAdminAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <body><h1>Access Denied</h1></body>
        </html>
    `);
}

// =====================================
//  Serve Static
// =====================================
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// =====================================
//  Microsoft OAuth Routes
// =====================================
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
            console.error('Error in /auth/microsoft/callback:', error);
            res.status(500).send('Auth error.');
        }
    }
);

// Optional logout
app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// =====================================
//   Upload & Protected
// =====================================
app.get('/upload', ensureAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'protected-user', 'upload.html'));
});

app.post('/upload-image', ensureAuthenticated, uploadMulter.single('image'), async (req, res) => {
    try {
        const userToken = req.user.id;
        const store = await readTokenStore();

        if (store[userToken] === true) {
            console.warn(`User ID ${userToken} already submitted.`);
            return res.status(403).send('You have already submitted.');
        }

        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }
        const textContentRaw = req.body.text || '';
        if (!textContentRaw) {
            return res.status(400).send('No text content provided.');
        }
        if (textContentRaw.length > 1000) {
            return res.status(400).send('Text too long (max 1000 chars).');
        }

        // Validate square image
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

        // Upload image to 'pending'
        const imageBlobClient = pendingContainerClient.getBlockBlobClient(imageFilename);
        await imageBlobClient.uploadData(imageBuffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype },
        });
        console.log(`Uploaded ${imageFilename} to pending.`);

        // Upload text to 'pending'
        const textContent = textContentRaw.replace(/<[^>]*>?/gm, '');
        const textBlobClient = pendingContainerClient.getBlockBlobClient(textFilename);
        await textBlobClient.uploadData(Buffer.from(textContent), {
            blobHTTPHeaders: { blobContentType: 'text/plain' },
        });
        console.log(`Uploaded ${textFilename} to pending.`);

        // Mark user as having submitted
        store[userToken] = true;
        await writeTokenStore(store);

        // Insert into in-memory
        inMemoryPending.push({
            blobName: imageFilename,
            lockedBy: null,
            lockedAt: null
        });
        distributeNewItems();

        console.log(`User ID ${userToken} submitted an item.`);
        broadcastPendingImages();

        res.status(200).send('Image + text uploaded, pending approval.');
    } catch (error) {
        console.error('Error uploading image:', error);
        res.status(500).send('Server error occurred.');
    }
});

// =====================================
//  Admin Login + Logout
// =====================================
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts, try again later.'
});

app.post('/admin/login', adminLoginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        console.log('Admin logged in.');
        return res.redirect('/admin');
    } else {
        console.warn('Admin login failed.');
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
            <html><body>
            <h1>Admin Logout</h1>
            <p>Logged out successfully.</p>
            </body></html>
        `);
    });
});

app.get('/admin', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.sendFile(path.join(__dirname, 'protected-admin', 'admin.html'));
    } else {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <body>
            <h1>Admin Login</h1>
            <form method="POST" action="/admin/login">
                <input type="password" name="password" required />
                <button type="submit">Login</button>
            </form>
            </body>
            </html>
        `);
    }
});

// =====================================
//  Optional HTTP route for debugging 
//  (If you want to list in-memory items):
// =====================================
app.get('/admin/pending-images', requireAdminAuth, (req, res) => {
    // Return the in-memory distribution, 
    // each with { blobName, lockedBy } or a final "url"
    const data = inMemoryPending.map(item => ({
        url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(item.blobName)}`,
        lockedBy: item.lockedBy
    }));
    res.json({ pendingImages: data });
});

// Helper for copy checks
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
            console.log(`${description} check #${attempts}: exists=${exists}`);
            if (exists) break;
        } catch (err) {
            console.error(`${description} existence check error:`, err);
            throw err;
        }
        await new Promise(r => setTimeout(r, interval));
    }
    if (!exists) {
        throw new Error(`${description} copy did not complete in time.`);
    }
}

// =====================================
//   Approve / Deny Endpoints
// =====================================
app.post('/admin/approve-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }
    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Approving: ${filename} & ${textFilename}`);

        const sourceImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const destImageBlob = imagesContainerClient.getBlockBlobClient(filename);
        if (!(await sourceImageBlob.exists())) {
            throw new Error(`Image ${filename} not found in pending.`);
        }
        const imageUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(filename)}`;
        await destImageBlob.startCopyFromURL(imageUrl);
        await waitForBlobExistence(imagesContainerClient, filename, 'Image');

        const sourceTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);
        if (!(await sourceTextBlob.exists())) {
            throw new Error(`Text ${textFilename} not found in pending.`);
        }
        const textUrl = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(textFilename)}`;
        const destTextBlob = imagesContainerClient.getBlockBlobClient(textFilename);
        await destTextBlob.startCopyFromURL(textUrl);
        await waitForBlobExistence(imagesContainerClient, textFilename, 'Text');

        // Clean up from pending
        await sourceImageBlob.deleteIfExists();
        await sourceTextBlob.deleteIfExists();

        // Remove from in-memory
        inMemoryPending = inMemoryPending.filter(item => item.blobName !== filename);

        broadcastNewImages();
        broadcastPendingImages();
        res.status(200).send('Image approved.');
    } catch (error) {
        console.error('Error approving image:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.post('/admin/deny-image', requireAdminAuth, async (req, res) => {
    const { imagePath } = req.body;
    if (!imagePath) {
        return res.status(400).send('No image specified.');
    }
    try {
        const filename = path.basename(imagePath);
        const baseName = path.parse(filename).name;
        const textFilename = `${baseName}.txt`;

        console.log(`Denying: ${filename} & ${textFilename}`);

        const pendingImageBlob = pendingContainerClient.getBlockBlobClient(filename);
        const pendingTextBlob = pendingContainerClient.getBlockBlobClient(textFilename);

        await pendingImageBlob.deleteIfExists();
        await pendingTextBlob.deleteIfExists();

        // Remove from in-memory
        inMemoryPending = inMemoryPending.filter(item => item.blobName !== filename);

        broadcastPendingImages();
        res.status(200).send('Denied and removed.');
    } catch (error) {
        console.error('Error denying image:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// =====================================
//  Public: /get-images
// =====================================
app.get('/get-images', async (req, res) => {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
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

// =====================================
//   Start the Server
// =====================================
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// =====================================
//   WebSocket Setup
// =====================================
const wss = new WebSocket.Server({ server });
const clients = new Set();      // Non-admin
const adminClients = new Set(); // Admin websockets

// Map each admin WebSocket to a unique adminId
const adminClientsMap = new Map();

wss.on('connection', ws => {
    console.log('WebSocket client connected.');

    ws.on('message', async msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'admin') {
                console.log('Admin WebSocket client connected.');
                adminClients.add(ws);

                // Generate adminId
                const adminId = `admin_${Math.random().toString(36).substr(2,9)}`;
                adminClientsMap.set(ws, adminId);

                console.log(`AdminClients: ${adminClients.size}, Clients: ${clients.size}`);

                distributeNewItems(); // Assign unclaimed items to whichever admin has fewest
                await sendPendingImages(ws); // Send locked items to this admin
            }
            else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
            else {
                // Normal client
                clients.add(ws);
                console.log(`Normal client connected. AdminClients: ${adminClients.size}, Clients: ${clients.size}`);
                await sendImages(ws); // Send them approved images
            }
        } catch (err) {
            console.error('Error parsing WS message:', err);
        }
    });

    ws.on('close', () => {
        adminClients.delete(ws);
        clients.delete(ws);

        // If admin, remove from map and unlock items
        const adminId = adminClientsMap.get(ws);
        if (adminId) {
            adminClientsMap.delete(ws);

            // Unlock items that belonged to that admin
            inMemoryPending.forEach(item => {
                if (item.lockedBy === adminId) {
                    item.lockedBy = null;
                    item.lockedAt = null;
                }
            });
            distributeNewItems(); // Redistribute unlocked items
        }

        console.log('WebSocket client disconnected.');
        console.log(`AdminClients: ${adminClients.size}, Clients: ${clients.size}`);
    });
});

/**
 * Sends all approved images in /images container to a normal client
 */
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

/**
 * Sends only the items locked by this admin from inMemoryPending
 */
async function sendPendingImages(ws) {
    try {
        const adminId = adminClientsMap.get(ws);
        if (!adminId) {
            ws.send(JSON.stringify({ pendingImages: [] }));
            return;
        }

        // Filter items where lockedBy === this admin
        const lockedItems = inMemoryPending.filter(i => i.lockedBy === adminId);
        const data = lockedItems.map(i => ({
            url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/pending/${encodeURIComponent(i.blobName)}`,
            lockedBy: i.lockedBy
        }));

        ws.send(JSON.stringify({ pendingImages: data }));
    } catch (error) {
        console.error('Error in sendPendingImages:', error);
        ws.send(JSON.stringify({ error: 'Failed to fetch locked images.' }));
    }
}

/**
 * Re-sends updated pending images to each admin
 */
async function broadcastPendingImages() {
    for (const ws of adminClients) {
        await sendPendingImages(ws);
    }
}

/**
 * Sends updated /images container to all normal clients
 */
async function broadcastNewImages() {
    try {
        const blobs = await listBlobs(imagesContainerClient);
        const imageBlobs = blobs.filter(b => b.endsWith('.jpg'));
        const images = imageBlobs.map(b =>
            `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/images/${encodeURIComponent(b)}`
        );
        const message = JSON.stringify({ images });

        // Only non-admin clients get this
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    } catch (error) {
        console.error('Error in broadcastNewImages:', error);
    }
}