const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// Connection URI
const uri = "mongodb+srv://whatsapp_admin:Whatsapp%402026@whatsappapi.0wo4yqn.mongodb.net/whatsapp_crm?appName=WhatsappAPI";
const client = new MongoClient(uri);

async function run() {
    try {
        console.log('Connecting to MongoDB Atlas...');
        await client.connect();
        const db = client.db('whatsapp_crm');
        console.log('Connected successfully to database "whatsapp_crm"');

        // Helper to load JSON
        const getJson = (filename) => {
            const filepath = path.join(__dirname, filename);
            if (fs.existsSync(filepath)) {
                try {
                    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
                } catch (e) {
                    console.error(`Error parsing ${filename}:`, e.message);
                    return null;
                }
            }
            return null;
        };

        // 1. Settings
        const settings = getJson('settings.json');
        if (settings) {
            console.log('Migrating settings...');
            await db.collection('settings').replaceOne(
                { _id: 'global' },
                { _id: 'global', ...settings },
                { upsert: true }
            );
            console.log('Settings migrated.');
        }

        // 2. Authorized Machines
        const auth = getJson('authorized_machines.json');
        if (auth) {
            console.log('Migrating authorized machines...');
            await db.collection('authorized_machines').replaceOne(
                { _id: 'global' },
                { _id: 'global', list: auth },
                { upsert: true }
            );
            console.log('Authorized machines migrated.');
        }

        // 3. Notifications
        const notifications = getJson('notifications.json');
        if (notifications) {
            console.log('Migrating notifications...');
            await db.collection('notifications').replaceOne(
                { _id: 'global' },
                { _id: 'global', list: notifications },
                { upsert: true }
            );
            console.log('Notifications migrated.');
        }

        // 4. Media Library
        const media = getJson('media_library.json');
        if (media) {
            console.log('Migrating media library...');
            await db.collection('media_library').replaceOne(
                { _id: 'global' },
                { _id: 'global', list: media },
                { upsert: true }
            );
            console.log('Media library migrated.');
        }

        // 5. Contacts
        const contacts = getJson('contacts.json');
        if (contacts && Object.keys(contacts).length > 0) {
            console.log(`Migrating ${Object.keys(contacts).length} contacts...`);
            const bulkOps = [];
            for (const [phone, contact] of Object.entries(contacts)) {
                bulkOps.push({
                    replaceOne: {
                        filter: { _id: phone },
                        replacement: { _id: phone, name: contact.name, tags: contact.tags, attributes: contact.attributes },
                        upsert: true
                    }
                });
            }
            // Execute in batches of 1000
            const batchSize = 1000;
            for (let i = 0; i < bulkOps.length; i += batchSize) {
                const batch = bulkOps.slice(i, i + batchSize);
                await db.collection('contacts').bulkWrite(batch);
            }
            console.log('Contacts migrated.');
        }

        // 6. Chats
        const chats = getJson('chats.json');
        if (chats && Object.keys(chats).length > 0) {
            console.log(`Migrating chats for ${Object.keys(chats).length} contacts...`);
            const bulkOps = [];
            for (const [phone, messages] of Object.entries(chats)) {
                bulkOps.push({
                    replaceOne: {
                        filter: { _id: phone },
                        replacement: { _id: phone, messages },
                        upsert: true
                    }
                });
            }
            // Execute in batches of 100
            const batchSize = 100;
            for (let i = 0; i < bulkOps.length; i += batchSize) {
                const batch = bulkOps.slice(i, i + batchSize);
                await db.collection('chats').bulkWrite(batch);
            }
            console.log('Chats migrated.');
        }

        // 7. Scheduled Campaigns
        const scheduled = getJson('scheduled_campaigns.json');
        if (scheduled && scheduled.length > 0) {
            console.log(`Migrating ${scheduled.length} scheduled campaigns...`);
            const bulkOps = [];
            for (const campaign of scheduled) {
                bulkOps.push({
                    replaceOne: {
                        filter: { _id: campaign.id },
                        replacement: campaign,
                        upsert: true
                    }
                });
            }
            await db.collection('scheduled_campaigns').bulkWrite(bulkOps);
            console.log('Scheduled campaigns migrated.');
        }

        // 8. Campaign Queue
        const queue = getJson('campaign_queue.json');
        if (queue) {
            console.log('Migrating campaign queue...');
            await db.collection('queue').replaceOne(
                { _id: 'current' },
                { _id: 'current', ...queue },
                { upsert: true }
            );
            console.log('Campaign queue migrated.');
        }

        console.log('=============================================');
        console.log('MIGRATION COMPLETED SUCCESSFULLY!');
        console.log('=============================================');

    } catch (e) {
        console.error('Migration failed:', e);
    } finally {
        await client.close();
    }
}

run();
