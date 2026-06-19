"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
dotenv_1.default.config();
exports.config = {
    ownerPhoneNumber: (process.env.OWNER_PHONE_NUMBER || '').replace(/\D/g, ''),
    calendarId: (process.env.CALENDAR_ID || 'primary').trim(),
    serviceAccountPath: process.env.SERVICE_ACCOUNT_PATH || path_1.default.join(process.cwd(), 'data', 'service_account.json'),
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').trim(),
    ollamaModel: (process.env.OLLAMA_MODEL || 'hermes3:8b-llama3.1-q8_0').trim(),
    timezone: process.env.TIMEZONE || 'Asia/Jerusalem',
    whitelistJids: (process.env.WHITELIST_JIDS || '').split(',').map(j => j.trim()).filter(Boolean),
    dbPath: process.env.DB_PATH || path_1.default.join(process.cwd(), 'data', 'memory.db'),
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
    },
    // Piper TTS (local text-to-speech)
    piperBinaryPath: process.env.PIPER_BINARY_PATH || '/opt/homebrew/bin/piper',
    piperVoiceModel: process.env.PIPER_VOICE_MODEL || path_1.default.join(os_1.default.homedir(), 'piper-voices', 'en-us-amy-medium.onnx'),
    ttsOutputDir: path_1.default.join(process.cwd(), 'data', 'media', 'tts'),
    // Dashboard
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3001', 10),
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
    // Immich Photo Server
    immichBaseUrl: process.env.IMMICH_BASE_URL || 'http://localhost:2283',
    immichApiKey: process.env.IMMICH_API_KEY || '',
};
// Boot-time validation
if (!exports.config.ownerPhoneNumber) {
    console.warn('[Config] ⚠ OWNER_PHONE_NUMBER is not set!');
}
else {
    console.log(`[Config] Owner number: ...${exports.config.ownerPhoneNumber.slice(-4)}`);
}
console.log(`[Config] Ollama: ${exports.config.ollamaBaseUrl} (model: ${exports.config.ollamaModel})`);
console.log(`[Config] DB: ${exports.config.dbPath}`);
//# sourceMappingURL=config.js.map