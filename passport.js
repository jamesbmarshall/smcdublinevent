// passport.js

const passport = require('passport');
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs').promises;
const path = require('path');

// Load environment variables
require('dotenv').config();

// Azure Blob Storage Configuration
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);

// Define your container names
const TOKEN_CONTAINER_NAME = 'tokens'; // Ensure this matches your Azure container
const tokenContainerClient = blobServiceClient.getContainerClient(TOKEN_CONTAINER_NAME);

// Ensure the token store container exists
async function ensureTokenContainer() {
    try {
        await tokenContainerClient.createIfNotExists();
        console.log(`Token store container '${TOKEN_CONTAINER_NAME}' is ready.`);
    } catch (error) {
        console.error(`Error creating token store container '${TOKEN_CONTAINER_NAME}':`, error);
    }
}

ensureTokenContainer();

// Path to token store blob
const TOKEN_STORE_BLOB_NAME = 'tokenStore.json';

// Helper function to read the token store from Azure Blob Storage
async function readTokenStore() {
    try {
        const blockBlobClient = tokenContainerClient.getBlockBlobClient(TOKEN_STORE_BLOB_NAME);
        const downloadBlockBlobResponse = await blockBlobClient.download(0);
        const downloaded = await streamToBuffer(downloadBlockBlobResponse.readableStreamBody);
        const tokenStore = JSON.parse(downloaded.toString());
        return tokenStore;
    } catch (error) {
        if (error.statusCode === 404) {
            // If the blob doesn't exist, return an empty object
            return {};
        }
        throw error;
    }
}

// Helper function to write the token store to Azure Blob Storage
async function writeTokenStore(tokenStore) {
    const blockBlobClient = tokenContainerClient.getBlockBlobClient(TOKEN_STORE_BLOB_NAME);
    const data = JSON.stringify(tokenStore, null, 2);
    await blockBlobClient.upload(data, Buffer.byteLength(data), { overwrite: true });
}

// Converts a ReadableStream to Buffer
async function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on('error', reject);
    });
}

// Passport Serialization
passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

// Configure Microsoft Strategy
passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL: process.env.MICROSOFT_CALLBACK_URL,
    scope: ['user.read']
},
    async (accessToken, refreshToken, profile, done) => {
        try {
            // Read current token store
            const tokenStore = await readTokenStore();

            // Check if user has already uploaded
            const hasUploaded = tokenStore[profile.id] || false;

            // Attach upload status to user profile
            profile.hasUploaded = hasUploaded;

            return done(null, profile);
        } catch (error) {
            return done(error, null);
        }
    }
));

module.exports = passport;