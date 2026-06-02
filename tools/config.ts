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
};

// Boot-time validation
if (!config.ownerPhoneNumber) {
    console.warn('[Config] ⚠ OWNER_PHONE_NUMBER is not set!');
} else {
    console.log(`[Config] Owner number: ...${config.ownerPhoneNumber.slice(-4)}`);
}
console.log(`[Config] Ollama: ${config.ollamaBaseUrl} (model: ${config.ollamaModel})`);
console.log(`[Config] DB: ${config.dbPath}`);
