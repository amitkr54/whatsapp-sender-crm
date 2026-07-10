if (!global.crypto) {
    global.crypto = require('crypto');
}
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const multer = require('multer');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const FormData = require('form-data');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');


const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Auth ---
const AUTH_USER = 'pankaj_thakur87';
const AUTH_PASS = 'Aayush@123';
const AUTHORIZED_MACHINES_FILE = path.join(__dirname, 'authorized_machines.json');

function getAuthorizedMachines() {
    return getJson(AUTHORIZED_MACHINES_FILE, []);
}
function saveAuthorizedMachines(list) {
    fs.writeFileSync(AUTHORIZED_MACHINES_FILE, JSON.stringify(list, null, 2));
}

function requireAuth(req, res, next) {
    if (req.path === '/webhook' || req.path === '/api/login' || req.path === '/api/ping' || req.path === '/api/webhook-url' || req.path === '/api/fix-images' || req.path.startsWith('/media/') || req.path.endsWith('.png') || req.path.endsWith('.css') || req.path.endsWith('.js') || req.path === '/socket.io/socket.io.js' || req.path === '/login.html' || !req.path.startsWith('/api/')) return next();
    const machineId = req.headers['x-machine-id'];
    if (machineId && getAuthorizedMachines().includes(machineId)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

app.use(express.json());
app.use(requireAuth);
app.use(express.static('public', { etag: false, lastModified: false, setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); res.set('Pragma', 'no-cache'); } }));

// Media route — serve from Cloudinary directly
app.use('/media', (req, res, next) => {
    const settings = getSettings();
    if (settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret) {
        const safeName = req.url.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]/g, '_');
        const publicId = safeName.replace(/\.[^.]+$/, '');
        const cloudinaryUrl = `https://res.cloudinary.com/${settings.cloudinaryCloudName}/image/upload/chatlink_media/${publicId}`;
        return res.redirect(cloudinaryUrl);
    }
    // Fallback to local if no Cloudinary configured
    next();
});

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const upload = multer({ dest: 'uploads/' });

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const QUEUE_FILE = path.join(__dirname, 'campaign_queue.json');
const SCHEDULED_FILE = path.join(__dirname, 'scheduled_campaigns.json');
const MEDIA_LIBRARY_FILE = path.join(__dirname, 'media_library.json');

// --- MongoDB & Memory Cache Connection ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://whatsapp_admin:Whatsapp%402026@whatsappapi.0wo4yqn.mongodb.net/whatsapp_crm?appName=WhatsappAPI";
const mongoClient = new MongoClient(MONGODB_URI);
let db = null;

// Memory Cache (synchronized with MongoDB)
const memoryCache = {
    settings: { accessToken: '', phoneNumberId: '', wabaId: '', verifyToken: 'whatsapp123' },
    contacts: {},
    chats: {},
    notifications: [],
    media_library: [],
    scheduled_campaigns: [],
    authorized_machines: [],
    queue: null
};

// Snapshot copies to detect delta changes
const cacheSnapshots = {
    contacts: {},
    chats: {}
};

async function initDatabase() {
    try {
        console.log('[MongoDB] Connecting...');
        await mongoClient.connect();
        db = mongoClient.db('whatsapp_crm');
        console.log('[MongoDB] Connected successfully');

        // Load all data into cache
        console.log('[MongoDB] Loading caches...');
        
        // 1. Settings
        const settingsDoc = await db.collection('settings').findOne({ _id: 'global' });
        if (settingsDoc) {
            const { _id, ...settingsData } = settingsDoc;
            memoryCache.settings = settingsData;
        }

        // 2. Authorized Machines
        const authDoc = await db.collection('authorized_machines').findOne({ _id: 'global' });
        if (authDoc) {
            memoryCache.authorized_machines = authDoc.list || [];
        }

        // 3. Notifications
        const notifDoc = await db.collection('notifications').findOne({ _id: 'global' });
        if (notifDoc) {
            memoryCache.notifications = notifDoc.list || [];
        }

        // 4. Media Library
        const mediaDoc = await db.collection('media_library').findOne({ _id: 'global' });
        if (mediaDoc) {
            memoryCache.media_library = mediaDoc.list || [];
        }

        // 5. Queue
        const queueDoc = await db.collection('queue').findOne({ _id: 'current' });
        if (queueDoc) {
            const { _id, ...queueData } = queueDoc;
            memoryCache.queue = queueData;
        }

        // 6. Contacts
        const contactsList = await db.collection('contacts').find().toArray();
        contactsList.forEach(doc => {
            memoryCache.contacts[doc._id] = {
                name: doc.name,
                tags: doc.tags || [],
                attributes: doc.attributes || {}
            };
        });
        cacheSnapshots.contacts = JSON.parse(JSON.stringify(memoryCache.contacts));

        // 7. Chats
        const chatsList = await db.collection('chats').find().toArray();
        chatsList.forEach(doc => {
            memoryCache.chats[doc._id] = doc.messages || [];
        });
        cacheSnapshots.chats = JSON.parse(JSON.stringify(memoryCache.chats));

        // 8. Scheduled Campaigns
        const scheduledList = await db.collection('scheduled_campaigns').find().toArray();
        memoryCache.scheduled_campaigns = scheduledList.map(doc => {
            const { _id, ...rest } = doc;
            return { id: doc._id, ...rest };
        });

        console.log(`[MongoDB] Cache loaded: ${Object.keys(memoryCache.contacts).length} contacts, ${Object.keys(memoryCache.chats).length} chats`);

        // Start Change Streams to watch for external updates (e.g. from Render to Laptop)
        startChangeStreams();

    } catch (err) {
        console.error('[MongoDB] Initialization failed:', err.message);
        process.exit(1);
    }
}

function startChangeStreams() {
    console.log('[MongoDB] Starting Change Streams...');

    // Watch chats
    db.collection('chats').watch([], { fullDocument: 'updateLookup' }).on('change', next => {
        try {
            if (next.operationType === 'insert' || next.operationType === 'replace' || next.operationType === 'update') {
                const phone = next.documentKey._id;
                const fullDoc = next.fullDocument;
                if (fullDoc) {
                    memoryCache.chats[phone] = fullDoc.messages || [];
                    cacheSnapshots.chats[phone] = JSON.parse(JSON.stringify(fullDoc.messages || []));
                }
            } else if (next.operationType === 'delete') {
                const phone = next.documentKey._id;
                delete memoryCache.chats[phone];
                delete cacheSnapshots.chats[phone];
            }
        } catch (e) {
            console.error('[ChangeStream] Chat error:', e.message);
        }
    });

    // Watch contacts
    db.collection('contacts').watch([], { fullDocument: 'updateLookup' }).on('change', next => {
        try {
            if (next.operationType === 'insert' || next.operationType === 'replace' || next.operationType === 'update') {
                const phone = next.documentKey._id;
                const fullDoc = next.fullDocument;
                if (fullDoc) {
                    memoryCache.contacts[phone] = {
                        name: fullDoc.name,
                        tags: fullDoc.tags || [],
                        attributes: fullDoc.attributes || {}
                    };
                    cacheSnapshots.contacts[phone] = JSON.parse(JSON.stringify(memoryCache.contacts[phone]));
                }
            } else if (next.operationType === 'delete') {
                const phone = next.documentKey._id;
                delete memoryCache.contacts[phone];
                delete cacheSnapshots.contacts[phone];
            }
        } catch (e) {
            console.error('[ChangeStream] Contact error:', e.message);
        }
    });

    // Watch settings
    db.collection('settings').watch([], { fullDocument: 'updateLookup' }).on('change', next => {
        try {
            if (next.documentKey._id === 'global' && next.fullDocument) {
                const { _id, ...settingsData } = next.fullDocument;
                memoryCache.settings = settingsData;
            }
        } catch (e) {}
    });

    // Watch notifications
    db.collection('notifications').watch([], { fullDocument: 'updateLookup' }).on('change', next => {
        try {
            if (next.documentKey._id === 'global' && next.fullDocument) {
                memoryCache.notifications = next.fullDocument.list || [];
            }
        } catch (e) {}
    });
}

function syncContactsDb(contacts) {
    for (const [phone, contact] of Object.entries(contacts)) {
        if (JSON.stringify(contact) !== JSON.stringify(cacheSnapshots.contacts[phone])) {
            db.collection('contacts').replaceOne(
                { _id: phone },
                { _id: phone, name: contact.name, tags: contact.tags, attributes: contact.attributes },
                { upsert: true }
            ).catch(err => console.error(`[MongoDB] Error saving contact ${phone}:`, err.message));
            cacheSnapshots.contacts[phone] = JSON.parse(JSON.stringify(contact));
        }
    }
    // Delete missing
    for (const phone of Object.keys(cacheSnapshots.contacts)) {
        if (!contacts[phone]) {
            db.collection('contacts').deleteOne({ _id: phone })
                .catch(err => console.error(`[MongoDB] Error deleting contact ${phone}:`, err.message));
            delete cacheSnapshots.contacts[phone];
        }
    }
}

function syncChatsDb(chats) {
    for (const [phone, messages] of Object.entries(chats)) {
        if (JSON.stringify(messages) !== JSON.stringify(cacheSnapshots.chats[phone])) {
            db.collection('chats').replaceOne(
                { _id: phone },
                { _id: phone, messages },
                { upsert: true }
            ).catch(err => console.error(`[MongoDB] Error saving chat ${phone}:`, err.message));
            cacheSnapshots.chats[phone] = JSON.parse(JSON.stringify(messages));
        }
    }
    // Delete missing
    for (const phone of Object.keys(cacheSnapshots.chats)) {
        if (!chats[phone]) {
            db.collection('chats').deleteOne({ _id: phone })
                .catch(err => console.error(`[MongoDB] Error deleting chat ${phone}:`, err.message));
            delete cacheSnapshots.chats[phone];
        }
    }
}

function syncScheduledDb(scheduled) {
    for (const item of scheduled) {
        const { id, ...rest } = item;
        db.collection('scheduled_campaigns').replaceOne(
            { _id: id },
            { _id: id, ...rest },
            { upsert: true }
        ).catch(err => console.error(`[MongoDB] Error saving scheduled campaign ${id}:`, err.message));
    }
    // Delete missing
    const currentIds = scheduled.map(item => item.id);
    db.collection('scheduled_campaigns').deleteMany({ _id: { $nin: currentIds } })
        .catch(err => console.error(`[MongoDB] Error cleaning scheduled campaigns:`, err.message));
}

function getMediaLibrary() {
    return getJson(MEDIA_LIBRARY_FILE, []);
}

// --- JSON Helpers (Re-routed to MongoDB Synced Cache) ---
function getJson(file, defaultData = {}) {
    if (file === SETTINGS_FILE) return memoryCache.settings;
    if (file === CONTACTS_FILE) return memoryCache.contacts;
    if (file === CHATS_FILE) return memoryCache.chats;
    if (file === NOTIFICATIONS_FILE) return memoryCache.notifications;
    if (file === MEDIA_LIBRARY_FILE) return memoryCache.media_library;
    if (file === SCHEDULED_FILE) return memoryCache.scheduled_campaigns;
    if (file === AUTHORIZED_MACHINES_FILE) return memoryCache.authorized_machines;
    if (file === QUEUE_FILE) return memoryCache.queue || defaultData;
    return defaultData;
}

function saveJson(file, data) {
    if (file === SETTINGS_FILE) {
        memoryCache.settings = data;
        db.collection('settings').replaceOne({ _id: "global" }, { _id: "global", ...data }, { upsert: true }).catch(err => console.error('DB save settings error:', err.message));
    }
    else if (file === CONTACTS_FILE) {
        memoryCache.contacts = data;
        syncContactsDb(data);
    }
    else if (file === CHATS_FILE) {
        memoryCache.chats = data;
        syncChatsDb(data);
    }
    else if (file === NOTIFICATIONS_FILE) {
        memoryCache.notifications = data;
        db.collection('notifications').replaceOne({ _id: "global" }, { _id: "global", list: data }, { upsert: true }).catch(err => console.error('DB save notifications error:', err.message));
    }
    else if (file === MEDIA_LIBRARY_FILE) {
        memoryCache.media_library = data;
        db.collection('media_library').replaceOne({ _id: "global" }, { _id: "global", list: data }, { upsert: true }).catch(err => console.error('DB save media_library error:', err.message));
    }
    else if (file === SCHEDULED_FILE) {
        memoryCache.scheduled_campaigns = data;
        syncScheduledDb(data);
    }
    else if (file === AUTHORIZED_MACHINES_FILE) {
        memoryCache.authorized_machines = data;
        db.collection('authorized_machines').replaceOne({ _id: "global" }, { _id: "global", list: data }, { upsert: true }).catch(err => console.error('DB save authorized_machines error:', err.message));
    }
    else if (file === QUEUE_FILE) {
        memoryCache.queue = data;
        if (data) {
            db.collection('queue').replaceOne({ _id: "current" }, { _id: "current", ...data }, { upsert: true }).catch(err => console.error('DB save queue error:', err.message));
        } else {
            db.collection('queue').deleteOne({ _id: "current" }).catch(err => console.error('DB delete queue error:', err.message));
        }
    }
}

// --- Cloudinary Backup (Mocked out, since MongoDB is persistent) ---
const BACKUP_FILES = [CHATS_FILE, CONTACTS_FILE, NOTIFICATIONS_FILE, MEDIA_LIBRARY_FILE, AUTHORIZED_MACHINES_FILE, SCHEDULED_FILE];

async function backupToCloudinary() {
    // Persistent MongoDB Atlas makes manual backups redundant
}

let _backupDebounceTimer = null;
function scheduleBackup() {
    // Mocked out
}

async function restoreFromCloudinary() {
    // Hydrated directly from MongoDB on startup
}

function getSettings() {
    return getJson(SETTINGS_FILE, { accessToken: '', phoneNumberId: '', wabaId: '', verifyToken: 'whatsapp123' });
}

function getContacts() {
    return getJson(CONTACTS_FILE, {}); // { "phone": { name, tags:[] } }
}

function getChats() {
    return getJson(CHATS_FILE, {}); // { "phone": [ {id, from, to, text, timestamp, status} ] }
}

function getNotifications() {
    return getJson(NOTIFICATIONS_FILE, []); // [ { id, type, title, message, timestamp, status } ]
}

// --- Phone Number Normalization ---
// Converts any phone format to WhatsApp-ready format (e.g. 919958657208)
// Handles: "91 9958 657208", "9958657208", "09958657208", "+919958657208"
function normalizePhone(raw) {
    if (!raw) return '';
    let phone = raw.toString().replace(/\D/g, ''); // Remove all non-digits
    if (!phone) return '';
    
    // Remove leading 0 (e.g. 09958657208 -> 9958657208)
    if (phone.startsWith('0')) {
        phone = phone.substring(1);
    }
    
    // If exactly 10 digits, add India country code 91
    if (phone.length === 10) {
        phone = '91' + phone;
    }
    
    return phone;
}

// --- Media Download Helper ---
const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// Proxy endpoint: serve media from Meta API if local file is missing
// MUST be before express.static so it doesn't get intercepted
app.get('/media/proxy/:mediaId', async (req, res) => {
    const settings = getSettings();
    const { mediaId } = req.params;
    const safeId = mediaId.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // Check Cloudinary first
    if (settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret) {
        try {
            const result = await cloudinary.api.resource(`whatsapp_media/${safeId}`);
            if (result && result.secure_url) {
                return res.redirect(result.secure_url);
            }
        } catch(e) {}
    }

    // Fallback: fetch from Meta API
    if (!settings.accessToken) return res.status(401).json({ error: 'No token' });
    try {
        const metaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${settings.accessToken}` }
        });
        if (!metaRes.data.url) return res.status(404).json({ error: 'No URL' });

        // Download and upload to Cloudinary for permanent storage
        const fileRes = await axios.get(metaRes.data.url, {
            headers: { Authorization: `Bearer ${settings.accessToken}` },
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        if (settings.cloudinaryCloudName) {
            cloudinary.config({
                cloud_name: settings.cloudinaryCloudName,
                api_key: settings.cloudinaryApiKey,
                api_secret: settings.cloudinaryApiSecret
            });
            const contentType = fileRes.headers['content-type'] || 'application/octet-stream';
            const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
            const result = await cloudinary.uploader.upload(
                Buffer.from(fileRes.data),
                { folder: 'whatsapp_media', public_id: safeId, format: ext, resource_type: 'auto' }
            );
            return res.redirect(result.secure_url);
        }

        // If no Cloudinary, serve raw
        res.set('Content-Type', fileRes.headers['content-type'] || 'application/octet-stream');
        res.send(fileRes.data);
    } catch (err) {
        console.error('Media proxy error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch media' });
    }
});

app.use('/media', express.static(MEDIA_DIR));

async function downloadMedia(mediaId, type, mimeType) {
    const settings = getSettings();
    if (!settings.accessToken) return null;
    
    const safeId = mediaId.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // Configure Cloudinary if credentials are available
    const hasCloudinary = settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret;
    if (hasCloudinary) {
        cloudinary.config({
            cloud_name: settings.cloudinaryCloudName,
            api_key: settings.cloudinaryApiKey,
            api_secret: settings.cloudinaryApiSecret
        });
    }
    
    try {
        // Step 1: Get the media URL from Meta
        const metaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${settings.accessToken}` }
        });
        const mediaUrl = metaRes.data.url;
        
        if (!mediaUrl) {
            console.error(`Media download: No URL returned for mediaId ${mediaId}`);
            return null;
        }
        
        // Step 2: Download the actual file
        const ext = mimeType ? '.' + mimeType.split('/')[1].split(';')[0] : '.bin';
        const filename = `${safeId}${ext}`;
        
        const fileRes = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${settings.accessToken}` },
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        if (!fileRes.data || fileRes.data.length === 0) {
            console.error(`Media download: Empty response for ${mediaId}`);
            return null;
        }
        
        // Step 3a: Upload to Cloudinary if configured
        if (hasCloudinary) {
            try {
                const result = await new Promise((resolve, reject) => {
                    const uploadStream = cloudinary.uploader.upload_stream({
                        folder: 'whatsapp_media',
                        public_id: safeId,
                        resource_type: 'auto'
                    }, (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    });
                    uploadStream.end(Buffer.from(fileRes.data));
                });
                console.log(`Cloudinary uploaded: ${filename} -> ${result.secure_url}`);
                return result.secure_url;
            } catch (cloudErr) {
                console.error('Cloudinary upload failed:', cloudErr.message);
            }
        }
        
        // No local storage — return Cloudinary URL or null
        return null;
    } catch (err) {
        console.error('Media download error:', err.response?.data || err.message);
        return null;
    }
}

// --- Settings API ---
app.post('/api/login', (req, res) => {
    const { username, password, machineId } = req.body;
    if (username === AUTH_USER && password === AUTH_PASS) {
        // Register this device permanently
        if (machineId) {
            const machines = getAuthorizedMachines();
            if (!machines.includes(machineId)) {
                machines.push(machineId);
                saveAuthorizedMachines(machines);
                console.log(`New device registered: ${machineId}`);
            }
        }
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.post('/api/settings', (req, res) => {
    saveJson(SETTINGS_FILE, { ...getSettings(), ...req.body });
    res.json({ success: true });
});

// --- Media Library API ---
app.get('/api/media-library', (req, res) => {
    res.json(getMediaLibrary());
});

app.post('/api/media-library/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const settings = getSettings();
    if (!settings.accessToken || !settings.phoneNumberId) return res.status(400).json({ error: 'Missing credentials' });

    try {
        const formData = new FormData();
        formData.append('messaging_product', 'whatsapp');
        formData.append('file', fs.createReadStream(req.file.path), {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });
        const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
            headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
        });
        const mediaId = uploadRes.data.id;

        // Upload to Cloudinary ONLY — no local storage
        let cloudinaryUrl = null;
        if (settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret) {
            cloudinary.config({
                cloud_name: settings.cloudinaryCloudName,
                api_key: settings.cloudinaryApiKey,
                api_secret: settings.cloudinaryApiSecret
            });
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: 'chatlink_media',
                public_id: `lib_${mediaId}`,
                overwrite: true
            });
            cloudinaryUrl = result.secure_url;
            console.log(`Media uploaded to Cloudinary: ${cloudinaryUrl}`);
        }

        try { fs.unlinkSync(req.file.path); } catch(e) {}

        // Save entry to library with Cloudinary URL
        const library = getMediaLibrary();
        const entry = {
            id: mediaId,
            name: req.body.name || req.file.originalname,
            filename: req.file.originalname,
            url: cloudinaryUrl,
            uploadedAt: Date.now()
        };
        library.unshift(entry);
        saveJson(MEDIA_LIBRARY_FILE, library);

        res.json({ success: true, entry });
    } catch (err) {
        try { fs.unlinkSync(req.file.path); } catch(e) {}
        console.error('Media library upload error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

app.delete('/api/media-library/:id', (req, res) => {
    const library = getMediaLibrary();
    const updated = library.filter(e => e.id !== req.params.id);
    saveJson(MEDIA_LIBRARY_FILE, updated);
    res.json({ success: true });
});

// Fix template header image URLs (public)
app.post('/api/fix-images', (req, res) => {
    const chats = getChats();
    const lib = getMediaLibrary();
    const CORRECT_URL = 'https://res.cloudinary.com/dc22bmzlv/image/upload/v1781975075/chatlink_media/signage_template_header.png';
    let fixed = 0;
    let types = {};

    for (const [phone, msgs] of Object.entries(chats)) {
        for (const msg of msgs) {
            types[msg.type || 'undefined'] = (types[msg.type || 'undefined'] || 0) + 1;
            if (msg.from === 'me' && msg.text && msg.text.includes('Signage')) {
                const old = msg.headerImageUrl;
                msg.headerImageUrl = CORRECT_URL;
                msg.headerType = 'IMAGE';
                msg.type = 'template';
                if (old !== CORRECT_URL) fixed++;
            }
        }
    }
    saveJson(CHATS_FILE, chats);
    backupToCloudinary().catch(() => {});
    res.json({ success: true, fixed, types });
});

// --- Template Sync (AiSensy Style) ---
app.get('/api/templates/sync', async (req, res) => {
    const settings = getSettings();
    if (!settings.accessToken || !settings.wabaId) {
        return res.status(400).json({ error: 'WABA ID and Access Token required.' });
    }
    
    try {
        const response = await axios.get(`https://graph.facebook.com/v20.0/${settings.wabaId}/message_templates`, {
            headers: { 'Authorization': `Bearer ${settings.accessToken}` }
        });
        const approvedTemplates = response.data.data.filter(t => t.status === 'APPROVED');
        res.json({ success: true, templates: approvedTemplates });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

app.get('/api/templates/all', async (req, res) => {
    const settings = getSettings();
    if (!settings.accessToken || !settings.wabaId) {
        return res.status(400).json({ error: 'WABA ID and Access Token required.' });
    }
    
    try {
        const response = await axios.get(`https://graph.facebook.com/v20.0/${settings.wabaId}/message_templates?limit=100`, {
            headers: { 'Authorization': `Bearer ${settings.accessToken}` }
        });
        res.json({ success: true, templates: response.data.data });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

app.post('/api/templates/create', async (req, res) => {
    const settings = getSettings();
    if (!settings.accessToken || !settings.wabaId) {
        return res.status(400).json({ error: 'WABA ID and Access Token required.' });
    }
    
    try {
        const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.wabaId}/message_templates`, req.body, {
            headers: { 
                'Authorization': `Bearer ${settings.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// --- Contacts API ---
app.get('/api/contacts', (req, res) => res.json(getContacts()));

app.post('/api/contacts', (req, res) => {
    const { phone, name, tags, attributes } = req.body;
    const contacts = getContacts();
    if (!contacts[phone]) contacts[phone] = { name: phone, tags: [], attributes: {} };
    if (name !== undefined) contacts[phone].name = name;
    if (tags !== undefined) contacts[phone].tags = tags;
    if (attributes !== undefined) contacts[phone].attributes = attributes;
    saveJson(CONTACTS_FILE, contacts);
    
    // Notify active chat socket of info update
    io.emit('contact_updated', { phone, contact: contacts[phone] });
    
    res.json({ success: true });
});

app.post('/api/contacts/bulk-delete', (req, res) => {
    try {
        const { phones } = req.body;
        if (!phones || !Array.isArray(phones) || phones.length === 0) {
            return res.status(400).json({ success: false, error: 'No phones provided' });
        }

        const contacts = getContacts();
        const chats = getJson(CHATS_FILE, {});
        let deleted = 0;

        phones.forEach(phone => {
            if (contacts[phone]) {
                delete contacts[phone];
                deleted++;
            }
            if (chats[phone]) {
                delete chats[phone];
            }
        });

        saveJson(CONTACTS_FILE, contacts);
        saveJson(CHATS_FILE, chats);

        // Cloudinary backup
        backupToCloudinary(CONTACTS_FILE).catch(() => {});
        backupToCloudinary(CHATS_FILE).catch(() => {});

        io.emit('contact_updated', {});

        console.log(`Bulk deleted ${deleted} contacts`);
        res.json({ success: true, deleted });
    } catch (e) {
        console.error('Bulk delete error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Import Contacts (CSV/Excel) - matches columns and auto-saves additional fields as Custom Attributes
app.post('/api/contacts/import', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const contacts = getContacts();
    const { defaultTags } = req.body;
    let parsedDefaultTags = [];
    if (defaultTags) {
        parsedDefaultTags = defaultTags.split(/[,;]/).map(t => t.trim()).filter(t => t);
    }
    
    const processRow = (row) => {
        // Find phone key
        const phoneKey = Object.keys(row).find(k => ['phone', 'number', 'mobile', 'phone number', 'phonenumber'].includes(k.toLowerCase().trim()));
        if (!phoneKey) return;
        
        let phone = normalizePhone(row[phoneKey]);
        if (!phone) return;
        
        // Find name key
        const nameKey = Object.keys(row).find(k => ['name', 'full name', 'fullname', 'contact name'].includes(k.toLowerCase().trim()));
        const name = nameKey ? row[nameKey].trim() : phone;
        
        // Find tags key
        const tagsKey = Object.keys(row).find(k => ['tags', 'tag'].includes(k.toLowerCase().trim()));
        let tags = [];
        if (tagsKey && row[tagsKey]) {
            tags = row[tagsKey].split(/[,;]/).map(t => t.trim()).filter(t => t);
        }
        if (parsedDefaultTags.length > 0) {
            tags = Array.from(new Set([...tags, ...parsedDefaultTags]));
        }
        
        // Custom Attributes: everything else
        const attributes = {};
        Object.entries(row).forEach(([k, v]) => {
            const keyLower = k.toLowerCase().trim();
            if (keyLower === phoneKey.toLowerCase().trim() || 
                (nameKey && keyLower === nameKey.toLowerCase().trim()) || 
                (tagsKey && keyLower === tagsKey.toLowerCase().trim())) return;
                
            if (v !== undefined && v !== null && v !== '') {
                attributes[k.trim()] = v.toString().trim();
            }
        });
        
        // Skip if contact already exists in database
        if (contacts[phone]) return;
        
        contacts[phone] = { name, tags: [], attributes: {} };
        if (name) contacts[phone].name = name;
        if (tags.length > 0) {
            contacts[phone].tags = Array.from(new Set([...(contacts[phone].tags || []), ...tags]));
        }
        contacts[phone].attributes = { ...(contacts[phone].attributes || {}), ...attributes };
    };

    if (req.file.originalname.endsWith('.csv')) {
        fs.createReadStream(req.file.path)
            .pipe(csv())
            .on('data', (data) => processRow(data))
            .on('end', () => {
                saveJson(CONTACTS_FILE, contacts);
                try { fs.unlinkSync(req.file.path); } catch(e) {}
                res.json({ success: true, message: 'Contacts imported successfully' });
            })
            .on('error', (err) => {
                res.status(500).json({ error: err.message });
            });
    } else {
        try {
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = xlsx.utils.sheet_to_json(sheet);
            data.forEach(row => processRow(row));
            saveJson(CONTACTS_FILE, contacts);
            try { fs.unlinkSync(req.file.path); } catch(e) {}
            res.json({ success: true, message: 'Contacts imported successfully' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
});

// Export Contacts to CSV
app.get('/api/contacts/export', (req, res) => {
    const contacts = getContacts();
    let csvContent = 'Phone,Name,Tags';
    
    // Find all unique custom attribute keys across all contacts to create columns
    const allAttrKeys = new Set();
    Object.values(contacts).forEach(c => {
        if (c.attributes) {
            Object.keys(c.attributes).forEach(k => allAttrKeys.add(k));
        }
    });
    
    const attrKeysArray = Array.from(allAttrKeys);
    if (attrKeysArray.length > 0) {
        csvContent += ',' + attrKeysArray.join(',');
    }
    csvContent += '\n';
    
    Object.entries(contacts).forEach(([phone, c]) => {
        let row = `"${phone}","${(c.name || '').replace(/"/g, '""')}","${(c.tags || []).join(';').replace(/"/g, '""')}"`;
        attrKeysArray.forEach(k => {
            const val = (c.attributes && c.attributes[k] !== undefined) ? c.attributes[k].toString() : '';
            row += `,"${val.replace(/"/g, '""')}"`;
        });
        csvContent += row + '\n';
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts_export.csv');
    res.status(200).send(csvContent);
});

// --- Notifications API ---
app.get('/api/notifications', (req, res) => res.json(getNotifications()));
app.delete('/api/notifications', (req, res) => {
    saveJson(NOTIFICATIONS_FILE, []);
    res.json({ success: true });
});

// --- Chats / Inbox API ---
app.get('/api/chats', (req, res) => res.json(getChats()));

// --- Reports & Insights API ---
app.get('/api/reports/insights', (req, res) => {
    const chats = getChats();
    const contacts = getContacts();
    const stats = {
        totalSent: 0,
        totalDelivered: 0,
        totalRead: 0,
        totalFailed: 0,
        totalReplies: 0,
        deliveryRate: 0,
        readRate: 0,
        replyRate: 0,
        timeline: {},
        contactLog: [],
        topRepliers: [],
        hourlyActivity: Array(24).fill(0)
    };
    
    // Initialize last 14 days
    for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        stats.timeline[dateStr] = { sent: 0, delivered: 0, read: 0, failed: 0, replies: 0 };
    }

    const phonesMessaged = new Set();
    const phonesReplied = new Set();
    
    Object.entries(chats).forEach(([phone, history]) => {
        let sentCount = 0, readCount = 0, deliveredCount = 0, failedCount = 0, replyCount = 0;
        let lastSentStatus = 'sent';
        let lastSentTime = null;
        let lastReplyTime = null;
        let lastError = null;
        let lastBillable = null;
        let lastPricingCategory = null;
        let lastPricingType = null;

        history.forEach(msg => {
            const msgDate = new Date(msg.timestamp);
            const dateStr = msgDate.toISOString().split('T')[0];
            const hour = msgDate.getHours();

            if (msg.from === 'me') {
                sentCount++;
                stats.totalSent++;
                phonesMessaged.add(phone);
                lastSentStatus = msg.status || 'sent';
                lastSentTime = msg.timestamp;

                if (msg.status === 'delivered' || msg.status === 'read') { stats.totalDelivered++; deliveredCount++; }
                if (msg.status === 'read') { stats.totalRead++; readCount++; }
                if (msg.status === 'failed') { stats.totalFailed++; failedCount++; lastError = msg.error || null; }
                if (msg.pricing && msg.pricing.billable !== undefined) {
                    lastBillable = msg.pricing.billable;
                    lastPricingCategory = msg.pricing.category || null;
                    lastPricingType = msg.pricing.type || null;
                }

                if (stats.timeline[dateStr]) {
                    stats.timeline[dateStr].sent++;
                    if (msg.status === 'delivered' || msg.status === 'read') stats.timeline[dateStr].delivered++;
                    if (msg.status === 'read') stats.timeline[dateStr].read++;
                    if (msg.status === 'failed') stats.timeline[dateStr].failed++;
                }
                stats.hourlyActivity[hour]++;
            } else {
                // Incoming reply
                replyCount++;
                stats.totalReplies++;
                phonesReplied.add(phone);
                if (!lastReplyTime || msg.timestamp > lastReplyTime) lastReplyTime = msg.timestamp;
                if (stats.timeline[dateStr]) stats.timeline[dateStr].replies++;
                stats.hourlyActivity[hour]++;
            }
        });

        if (sentCount > 0) {
            stats.contactLog.push({
                phone,
                name: contacts[phone]?.name || phone,
                sent: sentCount,
                delivered: deliveredCount,
                read: readCount,
                failed: failedCount,
                replied: replyCount > 0,
                replyCount,
                lastStatus: lastSentStatus,
                lastTime: lastSentTime,
                lastReplyTime,
                lastError,
                billable: lastBillable,
                pricingCategory: lastPricingCategory,
                pricingType: lastPricingType
            });
        }
    });

    // Calculate rates
    if (stats.totalSent > 0) {
        stats.deliveryRate = Math.round((stats.totalDelivered / stats.totalSent) * 100);
        stats.readRate = Math.round((stats.totalRead / stats.totalSent) * 100);
        stats.replyRate = Math.round((phonesReplied.size / (phonesMessaged.size || 1)) * 100);
    }

    // Calculate estimated cost (India 2026 rates)
    const RATES = {
        marketing: 0.8631,
        utility: 0.1150,
        authentication: 0.1150,
        'authentication-international': 2.4971,
        service: 0
    };
    const GST_RATE = 0.18;
    let costByCategory = { marketing: 0, utility: 0, authentication: 0, service: 0 };
    let countByCategory = { marketing: 0, utility: 0, authentication: 0, service: 0 };

    Object.values(chats).forEach(history => {
        history.forEach(msg => {
            if (msg.from === 'me' && msg.pricing && msg.pricing.billable && msg.pricing.category) {
                const cat = msg.pricing.category;
                countByCategory[cat] = (countByCategory[cat] || 0) + 1;
                costByCategory[cat] = (costByCategory[cat] || 0) + (RATES[cat] || RATES.marketing);
            }
        });
    });

    const subtotal = Object.values(costByCategory).reduce((a, b) => a + b, 0);
    const gst = subtotal * GST_RATE;
    const totalCost = subtotal + gst;

    stats.cost = {
        byCategory: costByCategory,
        countByCategory,
        subtotal: Math.round(subtotal * 100) / 100,
        gst: Math.round(gst * 100) / 100,
        total: Math.round(totalCost * 100) / 100,
        rates: RATES,
        gstRate: GST_RATE * 100
    };

    // Top repliers (most recently active)
    stats.topRepliers = stats.contactLog
        .filter(c => c.replyCount > 0)
        .sort((a, b) => (b.lastReplyTime || 0) - (a.lastReplyTime || 0))
        .slice(0, 5)
        .map(c => ({ name: c.name, phone: c.phone, replies: c.replyCount }));

    // Sort contact log by last sent time desc
    stats.contactLog.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    
    res.json(stats);
});

// --- Tag-Based Analytics ---
app.get('/api/reports/tags', (req, res) => {
    const chats = getChats();
    const contacts = getContacts();
    const tagStats = {};

    Object.entries(chats).forEach(([phone, history]) => {
        const contact = contacts[phone];
        const contactTags = contact?.tags || [];
        if (contactTags.length === 0) return;

        let sentCount = 0, deliveredCount = 0, readCount = 0, replyCount = 0;
        history.forEach(msg => {
            if (msg.from === 'me') {
                sentCount++;
                if (msg.status === 'delivered' || msg.status === 'read') deliveredCount++;
                if (msg.status === 'read') readCount++;
            } else {
                replyCount++;
            }
        });
        if (sentCount === 0) return;

        contactTags.forEach(tag => {
            if (!tagStats[tag]) tagStats[tag] = { tag, sent: 0, delivered: 0, read: 0, replied: 0, contacts: 0 };
            tagStats[tag].sent += sentCount;
            tagStats[tag].delivered += deliveredCount;
            tagStats[tag].read += readCount;
            tagStats[tag].replied += replyCount > 0 ? 1 : 0;
            tagStats[tag].contacts++;
        });
    });

    // Calculate rates
    Object.values(tagStats).forEach(s => {
        s.deliveryRate = s.sent > 0 ? Math.round((s.delivered / s.sent) * 100) : 0;
        s.readRate = s.sent > 0 ? Math.round((s.read / s.sent) * 100) : 0;
        s.replyRate = s.contacts > 0 ? Math.round((s.replied / s.contacts) * 100) : 0;
    });

    res.json({ tags: Object.values(tagStats).sort((a, b) => b.replyRate - a.replyRate) });
});

// --- Campaign Comparison ---
app.get('/api/reports/campaigns', (req, res) => {
    const chats = getChats();
    const campaignStats = {};

    Object.entries(chats).forEach(([phone, history]) => {
        history.forEach(msg => {
            if (msg.from !== 'me') return;
            const cname = msg.campaignName || 'Unknown Campaign';
            if (!campaignStats[cname]) {
                campaignStats[cname] = { name: cname, templateName: msg.templateName || null, sent: 0, delivered: 0, read: 0, replied: 0, contacts: new Set(), repliedContacts: new Set(), tags: new Set(), lastTime: 0 };
            }
            const cs = campaignStats[cname];
            if (msg.templateName && !cs.templateName) cs.templateName = msg.templateName;
            else if (!cs.templateName && msg.text && msg.text.startsWith('[Campaign: ')) {
                const match = msg.text.match(/\[Campaign:\s*([^\]]+)\]/);
                if (match) cs.templateName = match[1];
            } else if (!cs.templateName && msg.text && msg.text.startsWith('[Template: ')) {
                const match = msg.text.match(/\[Template:\s*([^\]]+)\]/);
                if (match) cs.templateName = match[1];
            }
            
            cs.sent++;
            cs.contacts.add(phone);
            if (msg.timestamp > cs.lastTime) cs.lastTime = msg.timestamp;
            if (msg.tags && msg.tags.length) msg.tags.forEach(t => cs.tags.add(t));
            if (msg.status === 'delivered' || msg.status === 'read') cs.delivered++;
            if (msg.status === 'read') cs.read++;
        });
        // Check if this contact replied (any incoming message after a campaign message)
        let hasCampaignMsg = false;
        let hasReply = false;
        history.forEach(msg => {
            if (msg.from === 'me' && msg.campaignName) hasCampaignMsg = true;
            if (msg.from !== 'me' && hasCampaignMsg) hasReply = true;
        });
        if (hasCampaignMsg && hasReply) {
            // Find all campaign names this contact was messaged by
            history.forEach(msg => {
                if (msg.from === 'me' && msg.campaignName && campaignStats[msg.campaignName]) {
                    campaignStats[msg.campaignName].replied++;
                    campaignStats[msg.campaignName].repliedContacts.add(phone);
                }
            });
        }
    });

    // Convert Sets to counts and calculate rates
    const result = Object.values(campaignStats)
        .filter(cs => cs.name !== 'Unknown Campaign')
        .map(cs => ({
        name: cs.name,
        templateName: cs.templateName,
        sent: cs.sent,
        delivered: cs.delivered,
        read: cs.read,
        replied: cs.replied,
        uniqueContacts: cs.contacts.size,
        tags: Array.from(cs.tags),
        lastTime: cs.lastTime,
        deliveryRate: cs.sent > 0 ? Math.round((cs.delivered / cs.sent) * 100) : 0,
        readRate: cs.sent > 0 ? Math.round((cs.read / cs.sent) * 100) : 0,
        replyRate: cs.contacts.size > 0 ? Math.round((cs.replied / cs.contacts.size) * 100) : 0
    })).sort((a, b) => b.lastTime - a.lastTime);

    res.json({ campaigns: result });
});

// --- Tag Drill-Down: get contacts by tag with message status ---
app.get('/api/reports/tags/:tag/contacts', (req, res) => {
    const tag = decodeURIComponent(req.params.tag);
    const chats = getChats();
    const contacts = getContacts();
    const contactList = [];

    Object.entries(contacts).forEach(([phone, contact]) => {
        if (!contact.tags || !contact.tags.includes(tag)) return;
        const history = chats[phone] || [];
        let sent = 0, delivered = 0, read = 0, replied = 0, lastStatus = 'none', lastTime = null;
        let billable = null, pricingCategory = null, pricingType = null;
        history.forEach(msg => {
            if (msg.from === 'me') {
                sent++;
                if (msg.status === 'delivered' || msg.status === 'read') delivered++;
                if (msg.status === 'read') read++;
                lastStatus = msg.status || 'sent';
                lastTime = msg.timestamp;
                if (msg.pricing && msg.pricing.billable !== undefined) {
                    billable = msg.pricing.billable;
                    pricingCategory = msg.pricing.category;
                    pricingType = msg.pricing.type;
                }
            } else {
                replied++;
            }
        });
        contactList.push({
            phone,
            name: contact.name || phone,
            tags: contact.tags || [],
            sent, delivered, read, replied,
            hasReplied: replied > 0,
            lastStatus: sent > 0 ? lastStatus : 'not_sent',
            lastTime,
            billable, pricingCategory, pricingType
        });
    });

    // Sort: replied first, then by last time desc
    contactList.sort((a, b) => {
        if (a.hasReplied && !b.hasReplied) return -1;
        if (!a.hasReplied && b.hasReplied) return 1;
        return (b.lastTime || 0) - (a.lastTime || 0);
    });

    const total = contactList.length;
    const messaged = contactList.filter(c => c.sent > 0).length;
    const repliedList = contactList.filter(c => c.hasReplied);

    res.json({ tag, total, messaged, replied: repliedList.length, contacts: contactList });
});

// --- Campaign Drill-Down: get contacts by campaign name with message status ---
app.get('/api/reports/campaigns/:name/contacts', (req, res) => {
    const campaignName = decodeURIComponent(req.params.name);
    const chats = getChats();
    const contacts = getContacts();
    const contactMap = {};

    Object.entries(chats).forEach(([phone, history]) => {
        history.forEach(msg => {
            if (msg.from === 'me' && msg.campaignName === campaignName) {
                if (!contactMap[phone]) {
                    const ct = contacts[phone] || {};
                    contactMap[phone] = {
                        phone, name: ct.name || phone, tags: ct.tags || [],
                        sent: 0, delivered: 0, read: 0, replied: 0, lastStatus: 'sent', lastTime: null,
                        billable: null, pricingCategory: null, pricingType: null
                    };
                }
                contactMap[phone].sent++;
                if (msg.status === 'delivered' || msg.status === 'read') contactMap[phone].delivered++;
                if (msg.status === 'read') contactMap[phone].read++;
                contactMap[phone].lastStatus = msg.status || 'sent';
                contactMap[phone].lastTime = msg.timestamp;
                if (msg.pricing && msg.pricing.billable !== undefined) {
                    contactMap[phone].billable = msg.pricing.billable;
                    contactMap[phone].pricingCategory = msg.pricing.category;
                    contactMap[phone].pricingType = msg.pricing.type;
                }
            }
        });
        // Check for replies from this contact
        let hasCampaignMsg = false;
        history.forEach(msg => {
            if (msg.from === 'me' && msg.campaignName === campaignName) hasCampaignMsg = true;
            if (msg.from !== 'me' && hasCampaignMsg && contactMap[phone]) {
                contactMap[phone].replied++;
            }
        });
    });

    const contactList = Object.values(contactMap).map(c => ({ ...c, hasReplied: c.replied > 0 }));
    contactList.sort((a, b) => {
        if (a.hasReplied && !b.hasReplied) return -1;
        if (!a.hasReplied && b.hasReplied) return 1;
        return (b.lastTime || 0) - (a.lastTime || 0);
    });

    res.json({ campaignName, total: contactList.length, replied: contactList.filter(c => c.hasReplied).length, contacts: contactList });
});


// --- Webhook Configuration ---
app.get('/webhook', (req, res) => {
    const settings = getSettings();
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode === 'subscribe' && token === (settings.verifyToken || 'whatsapp123')) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    const body = req.body;
    console.log('\n--- WEBHOOK RECEIVED ---');
    console.log(JSON.stringify(body, null, 2));
    
    if (body.object) {
        body.entry?.forEach(entry => {
            entry.changes?.forEach(change => {
                try {
                    const val = change.value;
                    if (!val) return;

                    // Incoming Messages
                    if (val.messages && val.messages.length > 0) {
                        const msg = val.messages[0];
                        const phone = msg.from;
                        const contactName = val.contacts?.[0]?.profile?.name || phone;

                        // 1. Save Contact
                        const contacts = getContacts();
                        if (!contacts[phone]) {
                            contacts[phone] = { name: contactName, tags: ['New Lead'] };
                        } else if (contacts[phone].name === phone && contactName !== phone) {
                            contacts[phone].name = contactName;
                        }
                        saveJson(CONTACTS_FILE, contacts);

                        // 2. Build message record
                        let msgRecord = { id: msg.id, from: phone, to: 'me', timestamp: Date.now() };

                        if (msg.type === 'text') {
                            msgRecord.text = msg.text?.body || '[Text]';
                            msgRecord.type = 'text';
                        } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(msg.type)) {
                            const mediaObj = msg[msg.type];
                            msgRecord.type = msg.type;
                            msgRecord.text = mediaObj.caption || `[${msg.type.charAt(0).toUpperCase() + msg.type.slice(1)}]`;
                            msgRecord.mediaId = mediaObj.id;
                            msgRecord.mimeType = mediaObj.mime_type;
                            if (mediaObj.filename) msgRecord.filename = mediaObj.filename;

                            // Download media in background
                            downloadMedia(mediaObj.id, msg.type, mediaObj.mime_type).then(localPath => {
                                if (localPath) {
                                    const chats = getChats();
                                    if (chats[phone]) {
                                        const m = chats[phone].find(c => c.id === msg.id);
                                        if (m) {
                                            m.mediaUrl = localPath;
                                            saveJson(CHATS_FILE, chats);
                                            io.emit('media_ready', { phone, messageId: msg.id, mediaUrl: localPath });
                                        }
                                    }
                                }
                            }).catch(err => console.error('Media download failed:', err.message));
                        } else if (msg.type === 'location') {
                            msgRecord.type = 'location';
                            msgRecord.text = `📍 Location: ${msg.location?.name || ''} (${msg.location?.latitude}, ${msg.location?.longitude})`;
                            msgRecord.latitude = msg.location?.latitude;
                            msgRecord.longitude = msg.location?.longitude;
                        } else if (msg.type === 'contacts') {
                            msgRecord.type = 'contact';
                            const c = msg.contacts?.[0];
                            msgRecord.text = `👤 Contact: ${c?.name?.formatted_name || 'Unknown'}`;
                        } else if (msg.type === 'unsupported') {
                            msgRecord.type = 'text';
                            const unsupportedType = msg.unsupported?.type || msg.unsupported?.error_code || '';
                            if (unsupportedType) {
                                msgRecord.text = `[Unsupported: ${unsupportedType} message]`;
                                console.log(`[Webhook] Unsupported message from ${phone}: original type = ${unsupportedType}, full = ${JSON.stringify(msg.unsupported)}`);
                            } else {
                                msgRecord.text = `[Message type not supported]`;
                            }
                        } else if (msg.type === 'button') {
                            msgRecord.type = 'text';
                            msgRecord.text = msg.button?.text || msg.button?.payload || '[Button reply]';
                        } else if (msg.type === 'interactive') {
                            const interactive = msg.interactive;
                            if (interactive?.type === 'list_reply') {
                                msgRecord.type = 'text';
                                msgRecord.text = interactive.list_reply?.title || interactive.list_reply?.id || '[List selection]';
                            } else if (interactive?.type === 'button_reply') {
                                msgRecord.type = 'text';
                                msgRecord.text = interactive.button_reply?.title || interactive.button_reply?.id || '[Button reply]';
                            } else {
                                msgRecord.type = 'text';
                                msgRecord.text = JSON.stringify(interactive) || '[Interactive message]';
                            }
                        } else if (msg.type === 'order') {
                            msgRecord.type = 'text';
                            msgRecord.text = msg.order?.catalog_id ? `🛒 Order from catalog` : '🛒 Order message';
                            msgRecord.catalogId = msg.order?.catalog_id;
                        } else if (msg.type === 'system') {
                            msgRecord.type = 'text';
                            msgRecord.text = msg.system?.body || `[System message: ${msg.system?.type || 'update'}]`;
                        } else if (msg.type === 'reaction') {
                            msgRecord.type = 'text';
                            const emoji = msg.reaction?.emoji || '👍';
                            msgRecord.text = `${emoji} Reacted to a message`;
                        } else {
                            msgRecord.type = msg.type || 'text';
                            msgRecord.text = `[${msg.type || 'Message'}]`;
                        }

                        // 3. Save Chat
                        const chats = getChats();
                        if (!chats[phone]) chats[phone] = [];
                        // Prevent duplicate messages (Meta sometimes retries)
                        if (!chats[phone].find(m => m.id === msg.id)) {
                            chats[phone].push(msgRecord);
                            saveJson(CHATS_FILE, chats);
                            scheduleBackup(); // Persist to Cloudinary quickly so restart doesn't lose this msg
                            // 4. Emit Event
                            io.emit('incoming_message', { phone, contact: contacts[phone], message: msgRecord });
                        }
                    }

                    // Delivery Statuses
                    if (val.statuses && val.statuses.length > 0) {
                        const status = val.statuses[0];
                        const phone = status.recipient_id;
                        
                        const chats = getChats();
                        if (chats[phone]) {
                            const msgObj = chats[phone].find(m => m.id === status.id);
                            if (msgObj) {
                                msgObj.status = status.status;
                                if (status.status === 'failed') {
                                    if (status.errors && status.errors.length > 0) {
                                        const err = status.errors[0];
                                        msgObj.error = `Error ${err.code}: ${err.title} - ${err.message}${err.error_data && err.error_data.details ? ' (' + err.error_data.details + ')' : ''}`;
                                        console.log(`[Webhook] Failed msg to ${phone}: ${msgObj.error}`);
                                    } else {
                                        // Failed but no error details — save raw status for debugging
                                        msgObj.error = `Failed (no error details from Meta) | raw: ${JSON.stringify(status)}`;
                                        console.log(`[Webhook] Failed msg to ${phone} with NO error details. Raw status:`, JSON.stringify(status));
                                    }
                                }
                                if (status.pricing) {
                                    msgObj.pricing = {
                                        billable: status.pricing.billable,
                                        type: status.pricing.type,
                                        category: status.pricing.category,
                                        model: status.pricing.pricing_model
                                    };
                                    console.log(`[Webhook] Pricing for ${phone}: billable=${status.pricing.billable} type=${status.pricing.type} category=${status.pricing.category}`);
                                }
                                saveJson(CHATS_FILE, chats);
                                scheduleBackup(); // Keep delivery status synced to Cloudinary
                            }
                        }

                        io.emit('message_status', {
                            recipient: phone,
                            messageId: status.id,
                            status: status.status,
                            timestamp: status.timestamp,
                            error: status.status === 'failed' && status.errors && status.errors.length > 0 ? status.errors[0].message : null,
                            pricing: status.pricing || null
                        });
                    }
                
                // System Notifications (Webhooks like message_template_status_update, phone_number_quality_update, etc.)
                const notificationFields = [
                    'message_template_status_update', 
                    'message_template_quality_update', 
                    'phone_number_quality_update', 
                    'phone_number_name_update',
                    'account_update', 
                    'account_review_update', 
                    'account_alerts', 
                    'security'
                ];

                if (notificationFields.includes(change.field)) {
                    const notifications = getNotifications();
                    let title = change.field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                    let message = 'A system update occurred.';
                    let type = 'info';

                    if (change.field === 'message_template_status_update') {
                        message = `Template "${val.message_template_name}" is now ${val.event}`;
                        type = val.event === 'APPROVED' ? 'success' : (val.event === 'REJECTED' ? 'error' : 'warning');
                    } else if (change.field === 'phone_number_quality_update') {
                        message = `Phone number quality changed. Current state: ${val.current_limit}`;
                        type = 'warning';
                    } else if (change.field === 'message_template_quality_update') {
                        message = `Template "${val.message_template_name}" quality changed to ${val.new_quality_score}`;
                        type = 'warning';
                    } else if (val.alert_description || val.ban_reason) {
                        message = val.alert_description || val.ban_reason;
                        type = 'error';
                    }

                    const notif = {
                        id: Date.now() + Math.floor(Math.random()*1000),
                        field: change.field,
                        type: type,
                        title: title,
                        message: message,
                        timestamp: Date.now(),
                        rawData: val
                    };

                    notifications.unshift(notif); // Add to top
                    // Keep max 100 notifications
                    if (notifications.length > 100) notifications.pop();
                    saveJson(NOTIFICATIONS_FILE, notifications);

                    io.emit('notification', notif);
                }
                } catch (webhookErr) {
                    console.error('Webhook processing error (change skipped):', webhookErr.message, webhookErr.stack);
                }
            });
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// --- Direct Chat Messaging ---
app.post('/api/chat/send', upload.single('file'), async (req, res) => {
    const { phone, text } = req.body;
    console.log('\n--- SEND REPLY REQUEST ---');
    console.log('Phone:', phone);
    console.log('Text:', text);
    const settings = getSettings();
    if (!settings.accessToken || !settings.phoneNumberId) return res.status(400).json({ error: 'Missing credentials' });
    
    try {
        let msgPayload;
        let msgType = 'text';
        
        if (req.file) {
            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(req.file.path), {
                filename: req.file.originalname,
                contentType: req.file.mimetype
            });
            
            const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
            });
            
            const mediaId = uploadRes.data.id;
            
            if (req.file.mimetype.startsWith('image/')) msgType = 'image';
            else if (req.file.mimetype.startsWith('video/')) msgType = 'video';
            else if (req.file.mimetype.startsWith('audio/')) msgType = 'audio';
            else msgType = 'document';
            
            msgPayload = {
                messaging_product: 'whatsapp',
                to: phone,
                type: msgType,
                [msgType]: { id: mediaId }
            };
            
            if (text && msgType !== 'audio') msgPayload[msgType].caption = text;
            if (msgType === 'document') msgPayload.document.filename = req.file.originalname;
            
        } else {
            msgPayload = {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'text',
                text: { body: text }
            };
        }
        
        const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, msgPayload, { headers: { Authorization: `Bearer ${settings.accessToken}` } });
        
        const chats = getChats();
        if (!chats[phone]) chats[phone] = [];
        
        const newMsg = { 
            id: response.data.messages[0].id, 
            from: 'me', 
            to: phone, 
            text: req.file ? (text || `[${msgType}]`) : text, 
            type: msgType,
            timestamp: Date.now(), 
            status: 'sent' 
        };
        
        if (req.file) {
            // Upload to Cloudinary — no local storage
            const stgs = getSettings();
            const hasCloudinary = stgs.cloudinaryCloudName && stgs.cloudinaryApiKey && stgs.cloudinaryApiSecret;
            if (hasCloudinary) {
                try {
                    cloudinary.config({
                        cloud_name: stgs.cloudinaryCloudName,
                        api_key: stgs.cloudinaryApiKey,
                        api_secret: stgs.cloudinaryApiSecret
                    });
                    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'whatsapp_media', resource_type: 'auto' });
                    newMsg.mediaUrl = result.secure_url;
                    console.log(`Outgoing media uploaded to Cloudinary: ${result.secure_url}`);
                } catch(e) { console.error('Cloudinary upload for outgoing media failed:', e.message); }
            }
            try { fs.unlinkSync(req.file.path); } catch(e) {}

            if (msgType === 'document') newMsg.filename = req.file.originalname;
        }
        
        chats[phone].push(newMsg);
        saveJson(CHATS_FILE, chats);

        // Emit real-time update so inbox refreshes on all connected clients
        io.emit('chat_message_sent', { phone, message: newMsg });
        
        res.json({ success: true, message: newMsg });
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data?.error?.message || 'Failed to send message' });
    }
});

app.post('/api/chat/send-template', async (req, res) => {
    const { phone, templateName, languageCode } = req.body;
    const settings = getSettings();
    if (!settings.accessToken || !settings.phoneNumberId) return res.status(400).json({ error: 'Missing credentials' });
    
    try {
        const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: { name: templateName, language: { code: languageCode || 'en' } }
        }, { headers: { Authorization: `Bearer ${settings.accessToken}` } });
        
        const chats = getChats();
        if (!chats[phone]) chats[phone] = [];
        const msgRecord = { id: response.data.messages[0].id, from: 'me', to: phone, text: `[Template: ${templateName}]`, timestamp: Date.now(), status: 'sent' };
        chats[phone].push(msgRecord);
        saveJson(CHATS_FILE, chats);

        // Emit real-time update
        io.emit('chat_message_sent', { phone, message: msgRecord });
        
        res.json({ success: true, message: msgRecord });
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data?.error?.message || 'Failed to send template' });
    }
});

// --- Campaign Queue System ---
let isCampaignRunning = false;

// Helper: Auto-start next queued campaign only if its time has come
function startNextQueuedCampaign() {
    const list = getScheduledCampaigns();
    const now = Date.now();
    
    // Find next queued campaign whose scheduled time has passed
    const readyQueued = list.find(s => s.status === 'queued' && s.scheduleTime <= now);
    if (readyQueued) {
        console.log(`[Queue] Auto-starting queued campaign: ${readyQueued.campaignName} (scheduled time arrived)`);
        readyQueued.status = 'running';
        readyQueued.startedAt = now;
        saveScheduledCampaigns(list);
        
        // Trigger the scheduled campaign send
        const settings = getSettings();
        if (settings.accessToken && settings.phoneNumberId) {
            runScheduledCampaign(readyQueued);
        }
    }
}

// Helper: Run a scheduled campaign
async function runScheduledCampaign(campaign) {
    if (isCampaignRunning) return;
    isCampaignRunning = true;
    
    const settings = getSettings();
    const contacts = campaign.contacts || [];
    let sent = 0, failed = 0;
    
    for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        const phone = contact.parsedPhone || contact.Phone || contact.phone;
        if (!phone) continue;
        
        try {
            let headerMediaId = campaign.headerMediaId;
            
            const payload = {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'template',
                template: {
                    name: campaign.templateName,
                    language: { code: campaign.languageCode || 'en_US' },
                    components: []
                }
            };
            
            // Add header if needed
            if (campaign.headerType && campaign.headerMediaId && payload.template.components.length === 0) {
                payload.template.components.push({
                    type: 'header',
                    parameters: [{ type: 'image', image: { id: headerMediaId } }]
                });
            }
            
            // Add body variables
            if (campaign.mapping && Object.keys(campaign.mapping).length > 0) {
                const bodyParams = Object.values(campaign.mapping).map(v => ({
                    type: 'text',
                    text: String(v).replace(/\{name\}/gi, contact.Name || contact.name || '').replace(/\{phone\}/gi, phone)
                }));
                if (bodyParams.length > 0) {
                    payload.template.components.push({ type: 'body', parameters: bodyParams });
                }
            }
            
            const res = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, payload, {
                headers: { Authorization: `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json' }
            });
            
            if (res.data.messages && res.data.messages[0]) {
                sent++;
                // Save to chats
                const chats = getChats();
                if (!chats[phone]) chats[phone] = [];
                chats[phone].push({
                    from: 'me',
                    text: `[Template: ${campaign.templateName}]`,
                    timestamp: Date.now(),
                    status: 'sent',
                    campaignId: campaign.id,
                    waMsgId: res.data.messages[0].id
                });
                saveJson(CHATS_FILE, chats);
            }
        } catch (err) {
            failed++;
            console.error(`[Queue] Failed to send to ${phone}:`, err.message);
        }
        
        // Delay between messages
        if (i < contacts.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    // Update campaign status
    const list = getScheduledCampaigns();
    const idx = list.findIndex(s => s.id === campaign.id);
    if (idx >= 0) {
        list[idx].status = 'sent';
        list[idx].completedAt = Date.now();
        list[idx].sentCount = sent;
        list[idx].failedCount = failed;
        saveScheduledCampaigns(list);
    }
    
    isCampaignRunning = false;
    io.emit('campaign_finished', { sent, failed, campaignId: campaign.id });
    
    // Auto-start next queued campaign
    startNextQueuedCampaign();
}

// Queue API: Get current status
app.get('/api/queue/status', (req, res) => {
    const queue = getJson(QUEUE_FILE, null);
    if (!queue) return res.json({ exists: false });
    const remaining = queue.contacts.length - queue.sentIndex;
    const dailyLimit = queue.dailyLimit || 200;
    const daysRemaining = Math.ceil(remaining / dailyLimit);
    res.json({
        exists: true,
        campaignName: queue.campaignName,
        templateName: queue.templateName,
        total: queue.contacts.length,
        sentIndex: queue.sentIndex,
        remaining,
        dailyLimit,
        daysRemaining,
        status: queue.status,
        lastRunAt: queue.lastRunAt,
        createdAt: queue.createdAt
    });
});

// Queue API: Run next batch
app.post('/api/queue/run', async (req, res) => {
    if (isCampaignRunning) return res.status(400).json({ error: 'A campaign batch is already running.' });
    const queue = getJson(QUEUE_FILE, null);
    if (!queue) return res.status(404).json({ error: 'No campaign queue found. Please create one first.' });
    if (queue.status === 'completed') return res.status(400).json({ error: 'Campaign is already completed.' });

    const settings = getSettings();
    if (!settings.accessToken || !settings.phoneNumberId) return res.status(400).json({ error: 'API credentials missing.' });

    const { dailyLimit = 200 } = req.body;
    res.json({ success: true, message: 'Batch started' });
    runQueueBatch(queue, parseInt(dailyLimit) || queue.dailyLimit || 200, settings);
});

// Queue API: Clear/delete queue
app.delete('/api/queue/clear', (req, res) => {
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
    res.json({ success: true });
});

// Queue API: Stop running batch
app.post('/api/queue/stop', (req, res) => {
    isCampaignRunning = false;
    // Auto-start next queued campaign
    startNextQueuedCampaign();
    res.json({ success: true, message: 'Stop signal sent.' });
});

// ─── SCHEDULED CAMPAIGNS ───
function getScheduledCampaigns() {
    return getJson(SCHEDULED_FILE, []);
}
function saveScheduledCampaigns(list) {
    saveJson(SCHEDULED_FILE, list);
}

// Schedule API: Create a scheduled campaign
app.post('/api/schedule/create', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'headerFile', maxCount: 1 }]), async (req, res) => {
    if (isCampaignRunning) {
        // Auto-queue: schedule for 5 minutes after current campaign is expected to complete
        // We'll adjust the time automatically when the running campaign finishes
    }

    const { templateName, templateBody, languageCode, mapping, campaignName, headerUrl, headerType, scheduleTime } = req.body;
    const mappingObj = JSON.parse(mapping || '{}');
    const dailyLimit = parseInt(req.body.dailyLimit) || 0;
    const skipExisting = req.body.skipExisting === 'true';
    const skipInCRM = req.body.skipInCRM === 'true';
    const settings = getSettings();
    if (!settings.accessToken || !settings.phoneNumberId) return res.status(400).json({ error: 'API credentials missing.' });

    if (!scheduleTime) return res.status(400).json({ error: 'Schedule time is required' });
    const scheduleDate = new Date(scheduleTime);
    if (isNaN(scheduleDate.getTime()) || scheduleDate <= new Date()) {
        return res.status(400).json({ error: 'Schedule time must be in the future' });
    }

    const contactsFile = req.files && req.files.file ? req.files.file[0] : null;
    const headerFile = req.files && req.files.headerFile ? req.files.headerFile[0] : null;
    if (!contactsFile) return res.status(400).json({ error: 'No CSV/Excel file uploaded' });

    // Handle header media
    let headerMediaId = null;
    const savedMediaId = req.body.savedMediaId || null;
    const requiresHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType);
    if (requiresHeader && !savedMediaId && !headerFile && !headerUrl) {
        return res.status(400).json({ error: `This template requires a ${headerType.toLowerCase()} header.` });
    }

    if (savedMediaId) {
        headerMediaId = savedMediaId;
    } else if (headerFile) {
        try {
            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(headerFile.path), { filename: headerFile.originalname, contentType: headerFile.mimetype });
            const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
            });
            headerMediaId = uploadRes.data.id;
            // Save to Cloudinary
            try {
                let cloudinaryUrl = null;
                if (settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret) {
                    cloudinary.config({ cloud_name: settings.cloudinaryCloudName, api_key: settings.cloudinaryApiKey, api_secret: settings.cloudinaryApiSecret });
                    const cResult = await cloudinary.uploader.upload(headerFile.path, { folder: 'chatlink_media', public_id: `lib_${headerMediaId}`, overwrite: true });
                    cloudinaryUrl = cResult.secure_url;
                }
                const library = getMediaLibrary();
                library.unshift({ id: headerMediaId, name: headerFile.originalname, filename: headerFile.originalname, url: cloudinaryUrl, uploadedAt: Date.now() });
                saveJson(MEDIA_LIBRARY_FILE, library);
            } catch(libErr) { console.error('Failed to save media:', libErr.message); }
            try { fs.unlinkSync(headerFile.path); } catch(e) {}
        } catch (err) {
            try { fs.unlinkSync(headerFile.path); } catch(e) {}
            return res.status(500).json({ error: 'Failed to upload header media' });
        }
    } else if (headerUrl && requiresHeader) {
        try {
            const imageResponse = await axios.get(headerUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const ext = headerUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
            const tempFile = path.join(__dirname, 'uploads', `sched_header_${Date.now()}${ext}`);
            fs.writeFileSync(tempFile, Buffer.from(imageResponse.data));
            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(tempFile), { filename: `header${ext}`, contentType: imageResponse.headers['content-type'] || 'image/jpeg' });
            const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
            });
            headerMediaId = uploadRes.data.id;
            try { fs.unlinkSync(tempFile); } catch(e) {}
        } catch (err) {
            return res.status(500).json({ error: 'Failed to upload header image' });
        }
    }

    // Parse contacts
    const parseAndSchedule = (rawList) => {
        const filteredList = buildFilteredContacts(rawList, skipExisting, skipInCRM);
        try { fs.unlinkSync(contactsFile.path); } catch(e) {}

        const allTags = new Set();
        filteredList.forEach(c => {
            if (c.tags) c.tags.forEach(t => allTags.add(t));
            else {
                const contacts = getContacts();
                const ct = contacts[c.parsedPhone];
                if (ct && ct.tags) ct.tags.forEach(t => allTags.add(t));
            }
        });

        const id = 'sched_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        
        // If a campaign is running, mark new schedule as "queued" - it will auto-start after
        const currentStatus = isCampaignRunning ? 'queued' : 'scheduled';
        
        const scheduled = {
            id,
            campaignName: campaignName || `Scheduled ${scheduleDate.toLocaleDateString()} ${scheduleDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
            templateName, templateBody, languageCode: languageCode || 'en_US',
            mapping: mappingObj, dailyLimit, skipExisting, skipInCRM,
            contacts: filteredList,
            headerType, headerMediaId, headerUrl,
            tags: Array.from(allTags),
            scheduleTime: scheduleDate.getTime(),
            status: currentStatus,
            createdAt: Date.now()
        };

        const list = getScheduledCampaigns();
        list.push(scheduled);
        saveScheduledCampaigns(list);

        console.log(`[Schedule] Campaign "${scheduled.campaignName}" scheduled for ${scheduleDate.toLocaleString()} with ${filteredList.length} contacts`);
        res.json({ success: true, scheduled: true, id: scheduled.id, campaignName: scheduled.campaignName, total: filteredList.length, scheduleTime: scheduleDate.toISOString() });
    };

    if (contactsFile.originalname.endsWith('.csv')) {
        const rawList = [];
        fs.createReadStream(contactsFile.path).pipe(csv())
            .on('data', d => rawList.push(d))
            .on('end', () => parseAndSchedule(rawList));
    } else {
        const workbook = xlsx.readFile(contactsFile.path);
        const rawList = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        parseAndSchedule(rawList);
    }
});

// Schedule API: List scheduled campaigns
app.get('/api/schedule/list', (req, res) => {
    const list = getScheduledCampaigns();
    const summary = list.map(s => ({
        id: s.id,
        campaignName: s.campaignName,
        total: s.contacts.length,
        scheduleTime: s.scheduleTime,
        status: s.status,
        createdAt: s.createdAt
    }));
    res.json(summary);
});

// Schedule API: Cancel a scheduled campaign
app.delete('/api/schedule/:id', (req, res) => {
    let list = getScheduledCampaigns();
    const before = list.length;
    list = list.filter(s => s.id !== req.params.id);
    if (list.length === before) return res.status(404).json({ error: 'Not found' });
    saveScheduledCampaigns(list);
    console.log(`[Schedule] Cancelled campaign ${req.params.id}`);
    res.json({ success: true });
});

// Scheduler cron: check every 30 seconds
setInterval(async () => {
    const list = getScheduledCampaigns();
    const now = Date.now();
    let changed = false;

    for (const sched of list) {
        if (sched.status === 'scheduled' && sched.scheduleTime <= now) {
            console.log(`[Schedule] Triggering campaign "${sched.campaignName}" (${sched.contacts.length} contacts)`);
            sched.status = 'running';
            changed = true;

            if (isCampaignRunning) {
                console.log(`[Schedule] Campaign already running, skipping "${sched.campaignName}"`);
                sched.status = 'failed';
                continue;
            }

            const settings = getSettings();
            if (!settings.accessToken || !settings.phoneNumberId) {
                console.log(`[Schedule] No API credentials, skipping`);
                sched.status = 'failed';
                continue;
            }

            try {
                // Run-time deduplication: remove contacts already messaged by earlier campaigns
                if (sched.skipExisting) {
                    const existingChats = getChats();
                    const before = sched.contacts.length;
                    sched.contacts = sched.contacts.filter(c => !existingChats[c.parsedPhone] || existingChats[c.parsedPhone].length === 0);
                    const removed = before - sched.contacts.length;
                    if (removed > 0) {
                        console.log(`[Schedule] Run-time dedup: removed ${removed} already-messaged contacts, ${sched.contacts.length} remaining`);
                    }
                }

                // Convert headerUrl to media_id if needed
                if (!sched.headerMediaId && sched.headerUrl && sched.headerType && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(sched.headerType)) {
                    try {
                        const imageResponse = await axios.get(sched.headerUrl, { responseType: 'arraybuffer', timeout: 30000 });
                        const ext = sched.headerUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
                        const tempFile = path.join(__dirname, 'uploads', `sched_convert_${Date.now()}${ext}`);
                        fs.writeFileSync(tempFile, Buffer.from(imageResponse.data));
                        const formData = new FormData();
                        formData.append('messaging_product', 'whatsapp');
                        formData.append('file', fs.createReadStream(tempFile), { filename: `header${ext}`, contentType: imageResponse.headers['content-type'] || 'image/jpeg' });
                        const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                            headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
                        });
                        sched.headerMediaId = uploadRes.data.id;
                        try { fs.unlinkSync(tempFile); } catch(e) {}
                    } catch(err) {
                        console.error(`[Schedule] Failed to convert headerUrl:`, err.message);
                    }
                }

                if (sched.dailyLimit > 0 && sched.contacts.length > sched.dailyLimit) {
                    const queue = {
                        campaignName: sched.campaignName, templateName: sched.templateName,
                        templateBody: sched.templateBody, languageCode: sched.languageCode,
                        mapping: sched.mapping, dailyLimit: sched.dailyLimit,
                        contacts: sched.contacts, sentIndex: 0, status: 'running',
                        createdAt: Date.now(), lastRunAt: null,
                        headerType: sched.headerType, headerMediaId: sched.headerMediaId,
                        headerUrl: sched.headerUrl, tags: sched.tags
                    };
                    saveJson(QUEUE_FILE, queue);
                    runQueueBatch(queue, sched.dailyLimit, settings);
                } else {
                    startDirectCampaign(sched.contacts, sched.templateName, sched.templateBody, sched.languageCode, sched.mapping, settings, sched.headerType, sched.headerMediaId, sched.headerUrl, sched.campaignName, sched.tags);
                }
                sched.status = 'sent';
            } catch(err) {
                console.error(`[Schedule] Failed to launch campaign:`, err.message);
                sched.status = 'failed';
            }
        }
    }

    if (changed) saveScheduledCampaigns(list);
}, 30000);

async function runQueueBatch(queue, batchSize, settings) {
    isCampaignRunning = true;
    try {
    // If queue has headerUrl but no headerMediaId, convert URL to media_id first
    if (!queue.headerMediaId && queue.headerUrl && queue.headerType && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(queue.headerType)) {
        try {
            console.log(`runQueueBatch: Converting headerUrl to media_id: ${queue.headerUrl}`);
            const imageResponse = await axios.get(queue.headerUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const ext = queue.headerUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
            const tempFile = path.join(__dirname, 'uploads', `queue_default_${Date.now()}${ext}`);
            fs.writeFileSync(tempFile, Buffer.from(imageResponse.data));
            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(tempFile), {
                filename: `queue_default${ext}`,
                contentType: imageResponse.headers['content-type'] || 'image/jpeg'
            });
            const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
            });
            queue.headerMediaId = uploadRes.data.id;
            saveJson(QUEUE_FILE, queue);
            console.log(`runQueueBatch: headerUrl converted to media_id: ${queue.headerMediaId}`);
            try { fs.unlinkSync(tempFile); } catch(e) {}
        } catch (err) {
            console.error('runQueueBatch: Failed to convert headerUrl to media_id:', err.response?.data || err.message);
            throw new Error('Failed to upload template header image: ' + JSON.stringify(err.response?.data || err.message));
        }
    }

    const start = queue.sentIndex;
    const end = Math.min(start + batchSize, queue.contacts.length);
    const batch = queue.contacts.slice(start, end);

    io.emit('campaign_started', { total: batch.length, batchStart: start, grandTotal: queue.contacts.length });

    for (let i = 0; i < batch.length; i++) {
        if (!isCampaignRunning) {
            io.emit('campaign_stopped', { sentSoFar: start + i });
            // Save progress
            queue.sentIndex = start + i;
            queue.lastRunAt = Date.now();
            saveJson(QUEUE_FILE, queue);
            return;
        }
        const contact = batch[i];
        const phone = contact.parsedPhone;
        const mappingObj = queue.mapping || {};
        const components = [];

        // 1. Add Header parameter
        const headerType = queue.headerType;
        if (headerType && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
            const mediaTypeLower = headerType.toLowerCase();
            const mediaObj = queue.headerMediaId ? { id: queue.headerMediaId } : (queue.headerUrl ? { link: queue.headerUrl } : null);
            if (mediaObj) {
                components.push({
                    type: 'header',
                    parameters: [{ type: mediaTypeLower, [mediaTypeLower]: mediaObj }]
                });
            }
        }

        // 2. Add Body parameter
        const keys = Object.keys(mappingObj).sort();
        if (keys.length > 0) {
            const parameters = keys.map(k => ({ type: 'text', text: (contact[mappingObj[k]] || '').toString() }));
            components.push({ type: 'body', parameters });
        }
        
        try {
            const langCode = queue.languageCode || 'en';
            console.log(`[Queue Campaign] Sending to ${phone} | template: ${queue.templateName} | components: ${JSON.stringify(components)}`);
            const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'template',
                template: { name: queue.templateName, language: { code: langCode }, components }
            }, { headers: { 'Authorization': `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json' } });
            const msgId = response.data.messages[0].id;
            console.log(`[Queue Campaign] Sent to ${phone} | msgId: ${msgId}`);
            
            let previewText = `[Campaign: ${queue.templateName}]`;
            if (queue.templateBody) {
                let body = queue.templateBody;
                const keys = Object.keys(mappingObj).sort();
                keys.forEach((k, idx) => {
                    const val = contact[mappingObj[k]] || '';
                    body = body.replace(`{{${idx + 1}}}`, val);
                });
                previewText = body;
            }

            // Look up header image from media library for display in inbox
            const headerImageUrl = (() => {
                if (queue.headerType === 'IMAGE' && queue.headerMediaId) {
                    const lib = getMediaLibrary();
                    const found = lib.find(e => e.id === queue.headerMediaId);
                    if (found) return found.url || found.localUrl || found.cloudinaryUrl;
                }
                return queue.headerUrl || null;
            })();

            const chats = getChats();
            if (!chats[phone]) chats[phone] = [];
            chats[phone].push({
                id: msgId,
                from: 'me',
                to: phone,
                text: previewText,
                type: 'template',
                headerType: queue.headerType || null,
                headerImageUrl: headerImageUrl,
                timestamp: Date.now(),
                sentAt: Date.now(),
                status: 'sent',
                campaignName: queue.campaignName || null,
                tags: queue.tags || []
            });
            saveJson(CHATS_FILE, chats);

            io.emit('message_sent', { phone, status: 'sent', id: msgId, index: i, globalIndex: start + i });
        } catch (error) {
            const errorData = error.response?.data || error.message;
            const errorMsg = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
            console.error(`Queue send failed for ${phone}:`, errorMsg);

            // Store failed message in chats so it shows in report
            const chats = getChats();
            if (!chats[phone]) chats[phone] = [];
            const failedMsgId = `failed_${Date.now()}_${phone}`;
            chats[phone].push({
                id: failedMsgId,
                from: 'me',
                to: phone,
                text: `[Campaign: ${queue.templateName}]`,
                type: 'template',
                timestamp: Date.now(),
                status: 'failed',
                error: errorMsg,
                campaignName: queue.campaignName || null,
                tags: queue.tags || []
            });
            saveJson(CHATS_FILE, chats);

            io.emit('message_failed', { phone, error: errorMsg, index: i, globalIndex: start + i });
        }
        await new Promise(r => setTimeout(r, 500));
    }

    // Update queue progress
    queue.sentIndex = end;
    queue.lastRunAt = Date.now();
    if (queue.sentIndex >= queue.contacts.length) {
        queue.status = 'completed';
        io.emit('campaign_finished', { completed: true, total: queue.contacts.length });
    } else {
        queue.status = 'paused';
        io.emit('campaign_finished', {
            completed: false,
            sentIndex: queue.sentIndex,
            total: queue.contacts.length,
            remaining: queue.contacts.length - queue.sentIndex
        });
    }
    saveJson(QUEUE_FILE, queue);

    // Post-batch verification: wait 30s then check actual status from Meta API
    const batchPhones = batch.map(c => c.parsedPhone);
    const batchSettings = { ...settings };
    verifyBatchStatus(batchPhones, batchSettings).catch(err => console.error('[Verify] Post-batch verification error:', err.message));

    } catch (err) {
        console.error('Queue batch crashed:', err);
        queue.status = 'error';
        queue.lastRunAt = Date.now();
        saveJson(QUEUE_FILE, queue);
    } finally {
        isCampaignRunning = false;
        io.emit('campaign_finished', { completed: false, error: true });
        // Auto-start next queued campaign
        startNextQueuedCampaign();
    }
}

// --- Message Status Verification ---
// After a campaign batch completes, wait and verify actual status from Meta API
// Meta API accepts messages (returns 200 + wamid) but may silently drop them
// This function queries Meta for the real status of messages stuck as "sent"

async function verifyBatchStatus(batchPhones, settings) {
    if (!settings.accessToken) return;
    console.log(`[Verify] Waiting 30s for Meta status webhooks to arrive...`);
    await new Promise(r => setTimeout(r, 30000));

    const chats = getChats();
    let checked = 0, updated = 0, stuck = 0;
    const stuckMessages = [];

    for (const phone of batchPhones) {
        if (!chats[phone]) continue;
        for (const msg of chats[phone]) {
            if (msg.from !== 'me' || msg.status !== 'sent') continue;
            if (!msg.id || !msg.id.startsWith('wamid.')) continue;
            // Only check messages sent in the last 10 minutes
            if (!msg.sentAt || (Date.now() - msg.sentAt) > 10 * 60 * 1000) continue;

            checked++;
            try {
                const res = await axios.get(`https://graph.facebook.com/v20.0/${msg.id}`, {
                    headers: { Authorization: `Bearer ${settings.accessToken}` },
                    params: { fields: 'status,type,to' },
                    timeout: 10000
                });
                const metaStatus = res.data?.status;
                if (metaStatus && metaStatus !== 'sent') {
                    msg.status = metaStatus;
                    updated++;
                    console.log(`[Verify] ${phone}: ${msg.id} → ${metaStatus}`);
                } else if (!metaStatus) {
                    // Meta accepted but no status — likely dropped
                    console.log(`[Verify] ${phone}: ${msg.id} → no status from Meta (dropped?)`);
                }
            } catch (err) {
                const errCode = err.response?.data?.error?.code;
                // Error 100 = object does not exist, error 80007 = rate limit
                if (errCode === 100 || err.response?.status === 404) {
                    msg.status = 'failed';
                    msg.error = 'Meta API: message not found — silently dropped during processing';
                    updated++;
                    stuckMessages.push({ phone, id: msg.id, error: 'not_found' });
                    console.log(`[Verify] ${phone}: ${msg.id} → FAILED (not found on Meta)`);
                } else if (errCode === 80007) {
                    console.log(`[Verify] Rate limited, pausing verification...`);
                    await new Promise(r => setTimeout(r, 5000));
                } else {
                    console.log(`[Verify] ${phone}: ${msg.id} → query error: ${err.response?.data?.error?.message || err.message}`);
                }
            }
            // Rate limit: max 20 requests/second for Meta Graph API
            await new Promise(r => setTimeout(r, 100));
        }
    }

    if (updated > 0) {
        saveJson(CHATS_FILE, chats);
    }

    console.log(`[Verify] Batch complete: checked=${checked}, updated=${updated}, stuck=${stuckMessages.length}`);
    if (stuckMessages.length > 0) {
        console.log(`[Verify] Stuck messages (silently dropped by Meta):`);
        stuckMessages.forEach(m => console.log(`  - ${m.phone}: ${m.id}`));
    }

    io.emit('verify_complete', { checked, updated, stuck: stuckMessages.length });
    return { checked, updated, stuck: stuckMessages.length, stuckMessages };
}

// Periodic checker: every 5 minutes, check messages stuck as "sent" for >5 minutes
async function checkStuckMessages() {
    const settings = getSettings();
    if (!settings.accessToken || !settings.phoneNumberId) return;

    const chats = getChats();
    const now = Date.now();
    const STUCK_THRESHOLD = 5 * 60 * 1000;
    let checked = 0, updated = 0;
    let rateLimited = false;

    for (const [phone, history] of Object.entries(chats)) {
        if (rateLimited) break;
        for (const msg of history) {
            if (msg.from !== 'me' || msg.status !== 'sent') continue;
            if (!msg.id || !msg.id.startsWith('wamid.')) continue;
            if (!msg.sentAt) {
                // Backfill sentAt from timestamp for old messages
                msg.sentAt = msg.timestamp;
            }
            if ((now - msg.sentAt) < STUCK_THRESHOLD) continue;

            checked++;
            try {
                const res = await axios.get(`https://graph.facebook.com/v20.0/${msg.id}`, {
                    headers: { Authorization: `Bearer ${settings.accessToken}` },
                    params: { fields: 'status' },
                    timeout: 10000
                });
                const metaStatus = res.data?.status;
                if (metaStatus && metaStatus !== 'sent') {
                    msg.status = metaStatus;
                    updated++;
                    console.log(`[StuckCheck] ${phone}: ${msg.id} → ${metaStatus}`);
                }
            } catch (err) {
                const errCode = err.response?.data?.error?.code;
                if (errCode === 100 || err.response?.status === 404) {
                    msg.status = 'failed';
                    msg.error = 'Meta API: message not found — silently dropped during processing';
                    updated++;
                    console.log(`[StuckCheck] ${phone}: ${msg.id} → FAILED (not found on Meta)`);
                } else if (errCode === 80007) {
                    console.log(`[StuckCheck] Rate limited, skipping remaining`);
                    rateLimited = true;
                    break;
                }
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }

    if (updated > 0) {
        saveJson(CHATS_FILE, chats);
        io.emit('message_status_bulk_updated', { checked, updated });
    }
    if (checked > 0) {
        console.log(`[StuckCheck] Checked ${checked} stuck messages, updated ${updated}`);
    }
}

// API endpoint: manually trigger verification for stuck messages
app.post('/api/verify-stuck', async (req, res) => {
    const settings = getSettings();
    if (!settings.accessToken) return res.status(400).json({ error: 'API credentials missing' });

    const chats = getChats();
    const now = Date.now();
    const phonesToCheck = new Set();

    Object.entries(chats).forEach(([phone, history]) => {
        for (const msg of history) {
            if (msg.from === 'me' && msg.status === 'sent' && msg.id?.startsWith('wamid.') && msg.sentAt && (now - msg.sentAt) > 5 * 60 * 1000) {
                phonesToCheck.add(phone);
            }
        }
    });

    if (phonesToCheck.size === 0) {
        return res.json({ message: 'No stuck messages found', checked: 0 });
    }

    res.json({ message: `Verifying ${phonesToCheck.size} contacts with stuck messages...`, checking: true });
    verifyBatchStatus([...phonesToCheck], settings).catch(err => console.error('[Verify] Error:', err.message));
});

// API endpoint: get count of stuck messages
app.get('/api/verify-stuck/count', (req, res) => {
    const chats = getChats();
    const now = Date.now();
    let stuckCount = 0;
    let oldest = null;

    Object.values(chats).forEach(history => {
        for (const msg of history) {
            if (msg.from === 'me' && msg.status === 'sent' && msg.id?.startsWith('wamid.') && msg.sentAt && (now - msg.sentAt) > 5 * 60 * 1000) {
                stuckCount++;
                if (!oldest || msg.sentAt < oldest) oldest = msg.sentAt;
            }
        }
    });

    res.json({ stuckCount, oldestStuckAt: oldest, thresholdMinutes: 5 });
});

// Helper: filter & normalize contacts from raw parsed rows
function buildFilteredContacts(rawList, skipExisting, skipInCRM) {
    const seenPhones = new Set();
    const existingChats = getChats();
    const existingContacts = skipInCRM ? getContacts() : {};
    const result = [];
    for (const contact of rawList) {
        let phone = contact.Phone || contact.phone || contact.Number || contact.number ||
            contact['Phone Number'] || contact['phone number'] || contact['phonenumber'];
        if (!phone) continue;
        phone = normalizePhone(phone);
        if (!phone) continue;
        if (seenPhones.has(phone)) continue;
        if (skipExisting && existingChats[phone] && existingChats[phone].length > 0) continue;
        if (skipInCRM && existingContacts[phone]) continue;
        seenPhones.add(phone);
        result.push({ ...contact, parsedPhone: phone });
    }
    return result;
}

// --- Bulk Campaign (now queue-aware) ---
app.post('/api/send', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'headerFile', maxCount: 1 }]), async (req, res) => {
    if (isCampaignRunning) return res.status(400).json({ error: 'A campaign is already running' });

    const { templateName, templateBody, languageCode, mapping, campaignName, headerUrl, headerType } = req.body;
    const mappingObj = JSON.parse(mapping || '{}');
    const dailyLimit = parseInt(req.body.dailyLimit) || 0;
    const skipExisting = req.body.skipExisting === 'true';
    const skipInCRM = req.body.skipInCRM === 'true';
    const settings = getSettings();

    if (!settings.accessToken || !settings.phoneNumberId) return res.status(400).json({ error: 'API credentials missing.' });
    
    const contactsFile = req.files && req.files.file ? req.files.file[0] : null;
    const headerFile = req.files && req.files.headerFile ? req.files.headerFile[0] : null;
    
    if (!contactsFile) return res.status(400).json({ error: 'No CSV/Excel file uploaded' });

    // Handle header media: use saved media_id from library, or upload new file
    let headerMediaId = null;
    const savedMediaId = req.body.savedMediaId || null;

    // Server-side validation: reject if template requires header media but none provided
    const requiresHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType);
    if (requiresHeader && !savedMediaId && !headerFile && !headerUrl) {
        return res.status(400).json({ error: `This template requires a ${headerType.toLowerCase()} header. Please attach an image/video/document before sending.` });
    }

    if (savedMediaId) {
        // Reuse pre-uploaded media_id — no re-upload needed
        headerMediaId = savedMediaId;
        console.log(`Reusing saved media_id from library: ${headerMediaId}`);
    } else if (headerFile) {
        try {
            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(headerFile.path), {
                filename: headerFile.originalname,
                contentType: headerFile.mimetype
            });
            
            const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
            });
            
            headerMediaId = uploadRes.data.id;

            // Auto-save to media library — Cloudinary only, no local storage
            try {
                let cloudinaryUrl = null;
                if (settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret) {
                    cloudinary.config({
                        cloud_name: settings.cloudinaryCloudName,
                        api_key: settings.cloudinaryApiKey,
                        api_secret: settings.cloudinaryApiSecret
                    });
                    const cResult = await cloudinary.uploader.upload(headerFile.path, {
                        folder: 'chatlink_media',
                        public_id: `lib_${headerMediaId}`,
                        overwrite: true
                    });
                    cloudinaryUrl = cResult.secure_url;
                    console.log(`Campaign header uploaded to Cloudinary: ${cloudinaryUrl}`);
                }

                const library = getMediaLibrary();
                library.unshift({
                    id: headerMediaId,
                    name: headerFile.originalname,
                    filename: headerFile.originalname,
                    url: cloudinaryUrl,
                    uploadedAt: Date.now()
                });
                saveJson(MEDIA_LIBRARY_FILE, library);
                console.log(`Auto-saved new media to library: ${headerMediaId}`);
            } catch(libErr) {
                console.error('Failed to auto-save media to library:', libErr.message);
            }

            try { fs.unlinkSync(headerFile.path); } catch(e) {}
        } catch (err) {
            console.error('Failed to upload campaign header file to Meta:', err.response?.data || err.message);
            try { fs.unlinkSync(headerFile.path); } catch(e) {}
            return res.status(500).json({ error: 'Failed to upload header media: ' + JSON.stringify(err.response?.data || err.message) });
        }
    } else if (headerUrl && requiresHeader) {
        // Template default URL or user-provided URL — download and re-upload to Meta to get a permanent media_id
        // Meta CDN URLs expire, so we must convert them to media_ids before sending
        try {
            console.log(`Downloading template default image from URL and re-uploading to Meta: ${headerUrl}`);
            const imageResponse = await axios.get(headerUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const ext = headerUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg';
            const tempFile = path.join(__dirname, 'uploads', `template_default_${Date.now()}${ext}`);
            fs.writeFileSync(tempFile, Buffer.from(imageResponse.data));

            const formData = new FormData();
            formData.append('messaging_product', 'whatsapp');
            formData.append('file', fs.createReadStream(tempFile), {
                filename: `template_default${ext}`,
                contentType: imageResponse.headers['content-type'] || 'image/jpeg'
            });

            const uploadRes = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/media`, formData, {
                headers: { ...formData.getHeaders(), Authorization: `Bearer ${settings.accessToken}` }
            });

            headerMediaId = uploadRes.data.id;
            console.log(`Template default image uploaded to Meta, media_id: ${headerMediaId}`);

            // Save to Cloudinary only — no local storage
            try {
                let cloudinaryUrl = null;
                if (settings.cloudinaryCloudName && settings.cloudinaryApiKey && settings.cloudinaryApiSecret) {
                    cloudinary.config({
                        cloud_name: settings.cloudinaryCloudName,
                        api_key: settings.cloudinaryApiKey,
                        api_secret: settings.cloudinaryApiSecret
                    });
                    const cResult = await cloudinary.uploader.upload(tempFile, {
                        folder: 'chatlink_media',
                        public_id: `lib_${headerMediaId}`,
                        overwrite: true
                    });
                    cloudinaryUrl = cResult.secure_url;
                }

                const library = getMediaLibrary();
                library.unshift({
                    id: headerMediaId,
                    name: `template_default${ext}`,
                    filename: `template_default${ext}`,
                    url: cloudinaryUrl,
                    uploadedAt: Date.now()
                });
                saveJson(MEDIA_LIBRARY_FILE, library);
                console.log(`Template default image saved to library: ${headerMediaId}`);
            } catch(libErr) {
                console.error('Failed to save template default image to library:', libErr.message);
            }
            try { fs.unlinkSync(tempFile); } catch(e) {}
        } catch (err) {
            console.error('Failed to upload template default URL to Meta:', err.response?.data || err.message);
            return res.status(500).json({ error: 'Failed to upload template default image: ' + JSON.stringify(err.response?.data || err.message) });
        }
    }

    const parseAndStart = (rawList) => {
        const filteredList = buildFilteredContacts(rawList, skipExisting, skipInCRM);
        try { fs.unlinkSync(contactsFile.path); } catch(e) {}

        // Collect all unique tags from the filtered contacts for campaign tracking
        const allTags = new Set();
        filteredList.forEach(c => {
            if (c.tags) c.tags.forEach(t => allTags.add(t));
            else {
                // Look up tags from contacts.json
                const contacts = getContacts();
                const ct = contacts[c.parsedPhone];
                if (ct && ct.tags) ct.tags.forEach(t => allTags.add(t));
            }
        });
        const campaignTags = Array.from(allTags);

        const _now = new Date();
        const _timeStr = _now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const resolvedCampaignName = campaignName || `Campaign ${_now.toLocaleDateString()} ${_timeStr}`;

        if (dailyLimit > 0 && filteredList.length > dailyLimit) {
            // Queue mode: save entire list, send first batch
            const queue = {
                campaignName: resolvedCampaignName,
                templateName, templateBody, languageCode: languageCode || 'en_US',
                mapping: mappingObj, dailyLimit,
                contacts: filteredList,
                sentIndex: 0,
                status: 'paused',
                createdAt: Date.now(),
                lastRunAt: null,
                headerType,
                headerMediaId,
                headerUrl,
                tags: campaignTags
            };
            saveJson(QUEUE_FILE, queue);
            res.json({ success: true, message: 'Queue created', queued: true, total: filteredList.length, dailyLimit });
            runQueueBatch(queue, dailyLimit, settings);
        } else {
            // Direct mode: send all now
            res.json({ success: true, message: 'Campaign started', queued: false });
            startDirectCampaign(filteredList, templateName, templateBody, languageCode, mappingObj, settings, headerType, headerMediaId, headerUrl, resolvedCampaignName, campaignTags);
        }
    };

    if (contactsFile.originalname.endsWith('.csv')) {
        const rawList = [];
        fs.createReadStream(contactsFile.path).pipe(csv())
            .on('data', d => rawList.push(d))
            .on('end', () => parseAndStart(rawList));
    } else {
        const workbook = xlsx.readFile(contactsFile.path);
        const rawList = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        parseAndStart(rawList);
    }
});

async function startDirectCampaign(filteredList, templateName, templateBody, languageCode, mappingObj, settings, headerType, headerMediaId, headerUrl, campaignName, campaignTags) {
    isCampaignRunning = true;
    try {
    io.emit('campaign_started', { total: filteredList.length, grandTotal: filteredList.length });
    for (let i = 0; i < filteredList.length; i++) {
        if (!isCampaignRunning) { io.emit('campaign_stopped', { sentSoFar: i }); return; }
        const contact = filteredList[i];
        const phone = contact.parsedPhone;
        const components = [];

        // 1. Add Header parameter
        if (headerType && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
            const mediaTypeLower = headerType.toLowerCase();
            const mediaObj = headerMediaId ? { id: headerMediaId } : (headerUrl ? { link: headerUrl } : null);
            if (mediaObj) {
                components.push({
                    type: 'header',
                    parameters: [{ type: mediaTypeLower, [mediaTypeLower]: mediaObj }]
                });
            }
        }

        // 2. Add Body parameter
        const keys = Object.keys(mappingObj).sort();
        if (keys.length > 0) {
            const parameters = keys.map(k => ({ type: 'text', text: (contact[mappingObj[k]] || '').toString() }));
            components.push({ type: 'body', parameters });
        }
        
        try {
            const langCode = languageCode || 'en';
            console.log(`[Campaign] Sending to ${phone} | template: ${templateName} | components: ${JSON.stringify(components)}`);
            const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'template',
                template: { name: templateName, language: { code: langCode }, components }
            }, { headers: { 'Authorization': `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json' } });
            const msgId = response.data.messages[0].id;
            console.log(`[Campaign] Sent to ${phone} | msgId: ${msgId}`);
            
            let previewText = `[Campaign: ${templateName}]`;
            if (templateBody) {
                let body = templateBody;
                const keys = Object.keys(mappingObj).sort();
                keys.forEach((k, idx) => {
                    const val = contact[mappingObj[k]] || '';
                    body = body.replace(`{{${idx + 1}}}`, val);
                });
                previewText = body;
            }

            // Look up header image from media library for display in inbox
            const headerImageUrlD = (() => {
                if (headerType === 'IMAGE' && headerMediaId) {
                    const lib = getMediaLibrary();
                    const found = lib.find(e => e.id === headerMediaId);
                    if (found) return found.url || found.localUrl || found.cloudinaryUrl;
                }
                return headerUrl || null;
            })();

            const chats = getChats();
            if (!chats[phone]) chats[phone] = [];
            chats[phone].push({
                id: msgId,
                from: 'me',
                to: phone,
                text: previewText,
                type: 'template',
                headerType: headerType || null,
                headerImageUrl: headerImageUrlD,
                timestamp: Date.now(),
                sentAt: Date.now(),
                status: 'sent',
                campaignName: campaignName || null,
                templateName: templateName || null,
                tags: campaignTags || []
            });
            saveJson(CHATS_FILE, chats);

            io.emit('message_sent', { phone, status: 'sent', id: msgId, index: i, globalIndex: i });
        } catch (error) {
            console.error('Direct campaign send failed:', error.response?.data || error.message);
            io.emit('message_failed', { phone, error: JSON.stringify(error.response?.data || error.message), index: i, globalIndex: i });
        }
        await new Promise(r => setTimeout(r, 500));
    }
    } catch (err) {
        console.error('Direct campaign crashed:', err);
    } finally {
        isCampaignRunning = false;
        io.emit('campaign_finished', { completed: false, total: filteredList.length, error: true });
        // Auto-start next queued campaign
        startNextQueuedCampaign();
    }
}
// Cloud deployment: use app's own URL for webhooks
app.get('/api/ping', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });

app.get('/api/webhook-url', async (req, res) => {
    // In cloud, the app's URL is the webhook URL
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${appUrl}/webhook` });
});

io.on('connection', (socket) => {
    console.log('Client connected to socket');
});

// Global error handlers - prevent crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err.message || err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`\n========================================`);
    console.log(`Server starting on port ${PORT}...`);
    console.log(`========================================`);

    // 1. Initialize MongoDB and Hydrate memoryCache
    await initDatabase();

    console.log(`\n========================================`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`========================================`);
    
    // Cloud deployment info
    if (process.env.APP_URL) {
        console.log(`Cloud URL: ${process.env.APP_URL}`);
        console.log(`Webhook URL: ${process.env.APP_URL}/webhook`);

        // Render self-ping to prevent scaling to zero / sleeping
        console.log('[Cron] Setting up Render self-ping every 10 minutes');
        cron.schedule('*/10 * * * *', async () => {
            try {
                const pingUrl = `${process.env.APP_URL}/api/ping`;
                console.log(`[Cron] Sending self-ping to: ${pingUrl}`);
                const res = await axios.get(pingUrl);
                console.log('[Cron] Self-ping status:', res.data?.status);
            } catch (cronErr) {
                console.error('[Cron] Self-ping failed:', cronErr.message);
            }
        });
    }

    // Fix template header image URLs after database load
    try {
        const CORRECT_IMG = 'https://res.cloudinary.com/dc22bmzlv/image/upload/v1781975075/chatlink_media/signage_template_header.png';
        const chats = getChats();
        let imgFixed = 0;
        let unsupportedFixed = 0;
        let sentAtBackfilled = 0;
        for (const [phone, msgs] of Object.entries(chats)) {
            for (const msg of msgs) {
                if (msg.type === 'template' && msg.from === 'me') {
                    const old = msg.headerImageUrl;
                    msg.headerImageUrl = CORRECT_IMG;
                    msg.headerType = 'IMAGE';
                    if (old !== CORRECT_IMG) imgFixed++;
                }
                if (msg.type === 'unsupported') {
                    msg.type = 'text';
                    msg.text = '[Message type not supported by your WhatsApp version]';
                    unsupportedFixed++;
                }
                // Backfill sentAt for old messages stuck as "sent" (needed for verification)
                if (msg.from === 'me' && msg.status === 'sent' && !msg.sentAt) {
                    msg.sentAt = msg.timestamp;
                    sentAtBackfilled++;
                }
            }
        }
        if (imgFixed > 0 || unsupportedFixed > 0 || sentAtBackfilled > 0) {
            saveJson(CHATS_FILE, chats);
            console.log(`[Startup] Fixed ${imgFixed} image URLs, ${unsupportedFixed} unsupported types, backfilled ${sentAtBackfilled} sentAt timestamps`);
        }
    } catch (err) {
        console.error('Image fix failed:', err.message);
    }

    // Check stuck messages every 5 minutes (messages sent but no status from Meta)
    setInterval(async () => {
        try { await checkStuckMessages(); } catch (e) { console.error('Stuck message check error:', e.message); }
    }, 5 * 60 * 1000);

    // Shutdown handler
    const shutdown = async () => {
        console.log('Shutting down gracefully...');
        try { await mongoClient.close(); } catch (e) {}
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
});

