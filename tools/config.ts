import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
    ownerPhoneNumber: (process.env.OWNER_PHONE_NUMBER || '').replace(/\D/g, ''),
    calendarId: (process.env.CALENDAR_ID || 'primary').trim(),
    serviceAccountPath: process.env.SERVICE_ACCOUNT_PATH || path.join(process.cwd(), 'data', 'service_account.json'),
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').trim(),
    ollamaModel: (process.env.OLLAMA_MODEL || 'nous-hermes').trim(),
    timezone: process.env.TIMEZONE || 'Asia/Jerusalem',
    whitelistJids: (process.env.WHITELIST_JIDS || '').split(',').map(j => j.trim()).filter(Boolean),
    dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'memory.db'),

    // IMAP — Read-only email access (no SMTP)
    imapAccounts: {
        personal: {
            host: process.env.IMAP_HOST || 'imap.gmail.com',
            port: parseInt(process.env.IMAP_PORT || '993', 10),
            user: process.env.IMAP_USER || '',
            password: process.env.IMAP_PASSWORD || '',
        },
        university: {
            host: process.env.IMAP_HOST_UNI || 'imap.gmail.com',
            port: parseInt(process.env.IMAP_PORT_UNI || '993', 10),
            user: process.env.IMAP_USER_UNI || '',
            password: process.env.IMAP_PASSWORD_UNI || '',
        },
    } as Record<string, { host: string; port: number; user: string; password: string }>,
};

// Boot-time validation
if (!config.ownerPhoneNumber) {
    console.warn('[Config] ⚠ OWNER_PHONE_NUMBER is not set!');
} else {
    console.log(`[Config] Owner number: ...${config.ownerPhoneNumber.slice(-4)}`);
}
console.log(`[Config] Ollama: ${config.ollamaBaseUrl} (model: ${config.ollamaModel})`);
console.log(`[Config] DB: ${config.dbPath}`);
