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
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Auth ---
const AUTH_USER = 'pankaj_thakur87';
const AUTH_PASS = 'Aayush@123';
const authTokens = new Set();

function generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    authTokens.add(token);
    return token;
}

function requireAuth(req, res, next) {
    if (req.path === '/webhook' || req.path === '/api/login' || req.path === '/api/webhook-url' || req.path === '/login.html' || req.path.endsWith('.png') || req.path.endsWith('.css') || req.path.endsWith('.js') || req.path === '/socket.io/socket.io.js') return next();
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    if (token && authTokens.has(token)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login.html');
}

app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

app.use(express.json());
app.use(requireAuth);
app.use(express.static('public'));
app.use('/media', express.static(path.join(__dirname, 'media')));

if (!fs.existsSync(path.join(__dirname, 'media'))) {
    fs.mkdirSync(path.join(__dirname, 'media'));
}

const upload = multer({ dest: 'uploads/' });

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const QUEUE_FILE = path.join(__dirname, 'campaign_queue.json');
const MEDIA_LIBRARY_FILE = path.join(__dirname, 'media_library.json');

function getMediaLibrary() {
    return getJson(MEDIA_LIBRARY_FILE, []);
}

// --- JSON Helpers ---
function getJson(file, defaultData = {}) {
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } 
        catch(e) { return defaultData; }
    }
    return defaultData;
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
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
app.use('/media', express.static(MEDIA_DIR));

async function downloadMedia(mediaId, type, mimeType) {
    const settings = getSettings();
    if (!settings.accessToken) return null;
    
    try {
        // Step 1: Get the media URL from Meta
        const metaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${settings.accessToken}` }
        });
        const mediaUrl = metaRes.data.url;
        
        // Step 2: Download the actual file
        const ext = mimeType ? '.' + mimeType.split('/')[1].split(';')[0] : '';
        const filename = `${mediaId}${ext}`;
        const filePath = path.join(MEDIA_DIR, filename);
        
        const fileRes = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${settings.accessToken}` },
            responseType: 'arraybuffer'
        });
        
        fs.writeFileSync(filePath, fileRes.data);
        console.log(`Media downloaded: ${filename}`);
        return `/media/${filename}`;
    } catch (err) {
        console.error('Media download error:', err.response?.data || err.message);
        return null;
    }
}

// --- Settings API ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === AUTH_USER && password === AUTH_PASS) {
        return res.json({ success: true, token: generateToken() });
    }
    res.json({ success: false });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.post('/api/settings', (req, res) => {
    saveJson(SETTINGS_FILE, req.body);
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

        // Copy file to local media folder for preview
        const ext = path.extname(req.file.originalname) || '.jpg';
        const filename = `lib_${mediaId}${ext}`;
        const dest = path.join(__dirname, 'media', filename);
        fs.copyFileSync(req.file.path, dest);
        try { fs.unlinkSync(req.file.path); } catch(e) {}

        // Save entry to library
        const library = getMediaLibrary();
        const entry = {
            id: mediaId,
            name: req.body.name || req.file.originalname,
            filename: req.file.originalname,
            localUrl: `/media/${filename}`,
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
                if (msg.status === 'failed') { stats.totalFailed++; failedCount++; }

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
                lastTime: lastSentTime
            });
        }
    });

    // Calculate rates
    if (stats.totalSent > 0) {
        stats.deliveryRate = Math.round((stats.totalDelivered / stats.totalSent) * 100);
        stats.readRate = Math.round((stats.totalRead / stats.totalSent) * 100);
        stats.replyRate = Math.round((phonesReplied.size / (phonesMessaged.size || 1)) * 100);
    }

    // Top repliers (most replies received)
    stats.topRepliers = stats.contactLog
        .filter(c => c.replyCount > 0)
        .sort((a, b) => b.replyCount - a.replyCount)
        .slice(0, 5)
        .map(c => ({ name: c.name, phone: c.phone, replies: c.replyCount }));

    // Sort contact log by last sent time desc
    stats.contactLog.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    
    res.json(stats);
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
                        } else {
                            msgRecord.type = msg.type || 'unknown';
                            msgRecord.text = `[${msg.type || 'Unknown'} message]`;
                        }

                        // 3. Save Chat
                        const chats = getChats();
                        if (!chats[phone]) chats[phone] = [];
                        // Prevent duplicate messages (Meta sometimes retries)
                        if (!chats[phone].find(m => m.id === msg.id)) {
                            chats[phone].push(msgRecord);
                            saveJson(CHATS_FILE, chats);
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
                                saveJson(CHATS_FILE, chats);
                            }
                        }

                        io.emit('message_status', {
                            recipient: phone,
                            messageId: status.id,
                            status: status.status,
                            timestamp: status.timestamp
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
            const ext = path.extname(req.file.originalname);
            const filename = newMsg.id + ext;
            const dest = path.join(__dirname, 'media', filename);
            fs.copyFileSync(req.file.path, dest);
            newMsg.mediaUrl = '/media/' + filename;
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
    res.json({ success: true, message: 'Stop signal sent.' });
});

async function runQueueBatch(queue, batchSize, settings) {
    isCampaignRunning = true;
    try {
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
            const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'template',
                template: { name: queue.templateName, language: { code: langCode }, components }
            }, { headers: { 'Authorization': `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json' } });
            const msgId = response.data.messages[0].id;
            
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
                    return lib.find(e => e.id === queue.headerMediaId)?.localUrl || null;
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
                status: 'sent'
            });
            saveJson(CHATS_FILE, chats);

            io.emit('message_sent', { phone, status: 'sent', id: msgId, index: i, globalIndex: start + i });
        } catch (error) {
            console.error('Queue send failed:', error.response?.data || error.message);
            io.emit('message_failed', { phone, error: JSON.stringify(error.response?.data || error.message), index: i, globalIndex: start + i });
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
    } catch (err) {
        console.error('Queue batch crashed:', err);
        queue.status = 'error';
        queue.lastRunAt = Date.now();
        saveJson(QUEUE_FILE, queue);
    } finally {
        isCampaignRunning = false;
        io.emit('campaign_finished', { completed: false, error: true });
    }
}

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

            // Auto-save to media library so it can be reused next time
            try {
                const ext = path.extname(headerFile.originalname) || '.jpg';
                const filename = `lib_${headerMediaId}${ext}`;
                const dest = path.join(__dirname, 'media', filename);
                fs.copyFileSync(headerFile.path, dest);
                const library = getMediaLibrary();
                library.unshift({
                    id: headerMediaId,
                    name: headerFile.originalname,
                    filename: headerFile.originalname,
                    localUrl: `/media/${filename}`,
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
    }

    const parseAndStart = (rawList) => {
        const filteredList = buildFilteredContacts(rawList, skipExisting, skipInCRM);
        try { fs.unlinkSync(contactsFile.path); } catch(e) {}

        if (dailyLimit > 0 && filteredList.length > dailyLimit) {
            // Queue mode: save entire list, send first batch
            const queue = {
                campaignName: campaignName || `Campaign ${new Date().toLocaleDateString()}`,
                templateName, templateBody, languageCode: languageCode || 'en_US',
                mapping: mappingObj, dailyLimit,
                contacts: filteredList,
                sentIndex: 0,
                status: 'paused',
                createdAt: Date.now(),
                lastRunAt: null,
                headerType,
                headerMediaId,
                headerUrl
            };
            saveJson(QUEUE_FILE, queue);
            res.json({ success: true, message: 'Queue created', queued: true, total: filteredList.length, dailyLimit });
            runQueueBatch(queue, dailyLimit, settings);
        } else {
            // Direct mode: send all now
            res.json({ success: true, message: 'Campaign started', queued: false });
            startDirectCampaign(filteredList, templateName, templateBody, languageCode, mappingObj, settings, headerType, headerMediaId, headerUrl);
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

async function startDirectCampaign(filteredList, templateName, templateBody, languageCode, mappingObj, settings, headerType, headerMediaId, headerUrl) {
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
            const response = await axios.post(`https://graph.facebook.com/v20.0/${settings.phoneNumberId}/messages`, {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'template',
                template: { name: templateName, language: { code: langCode }, components }
            }, { headers: { 'Authorization': `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json' } });
            const msgId = response.data.messages[0].id;
            
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
                    return lib.find(e => e.id === headerMediaId)?.localUrl || null;
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
                status: 'sent'
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
    }
}
// Cloud deployment: use app's own URL for webhooks
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
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`========================================`);
    
    // Cloud deployment info
    if (process.env.APP_URL) {
        console.log(`Cloud URL: ${process.env.APP_URL}`);
        console.log(`Webhook URL: ${process.env.APP_URL}/webhook`);
    }
});

