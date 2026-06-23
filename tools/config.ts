import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Resolve the project root independently of process.cwd().
 *
 * IMPORTANT: OpenClaw's gateway spawns the MCP server with its own working
 * directory (~/.openclaw), NOT the repo. If paths are derived from
 * process.cwd(), `.env` is never found and better-sqlite3 throws
 * "directory does not exist" on import — the MCP server dies with
 * "Connection closed" and the model silently loses every Astra tool.
 * Anchor everything to the compiled file location instead.
 */
function findProjectRoot(start: string): string {
    let dir = start;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(start, '..');
}

const PROJECT_ROOT = findProjectRoot(__dirname);

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

export const config = {
    ownerPhoneNumber: (process.env.OWNER_PHONE_NUMBER || '').replace(/\D/g, ''),
    calendarId: (process.env.CALENDAR_ID || 'primary').trim(),
    serviceAccountPath: process.env.SERVICE_ACCOUNT_PATH || path.join(PROJECT_ROOT, 'data', 'service_account.json'),
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').trim(),
    ollamaModel: (process.env.OLLAMA_MODEL || 'hermes3:8b-llama3.1-q8_0').trim(),
    timezone: process.env.TIMEZONE || 'Asia/Jerusalem',
    whitelistJids: (process.env.WHITELIST_JIDS || '').split(',').map(j => j.trim()).filter(Boolean),
    dbPath: process.env.DB_PATH || path.join(PROJECT_ROOT, 'data', 'memory.db'),

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

    // Piper TTS (local text-to-speech)
    piperBinaryPath: process.env.PIPER_BINARY_PATH || '/opt/homebrew/bin/piper',
    piperVoiceModel: process.env.PIPER_VOICE_MODEL || path.join(os.homedir(), 'piper-voices', 'en-us-amy-medium.onnx'),
    ttsOutputDir: path.join(PROJECT_ROOT, 'data', 'media', 'tts'),

    // Dashboard
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3001', 10),
    dashboardToken: process.env.DASHBOARD_TOKEN || '',

    // Immich Photo Server
    immichBaseUrl: process.env.IMMICH_BASE_URL || 'http://localhost:2283',
    immichApiKey: process.env.IMMICH_API_KEY || '',

    // Spotify (Web API playback control → spotifyd Connect device)
    spotify: {
        clientId: process.env.SPOTIFY_CLIENT_ID || '',
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
        refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || '',
        // The spotifyd device_name on this Mac (see ~/.config/spotifyd/spotifyd.conf)
        deviceName: process.env.SPOTIFY_DEVICE_NAME || 'Astra_Mac_Mini',
    },
};

// Boot-time validation
if (!config.ownerPhoneNumber) {
    console.warn('[Config] ⚠ OWNER_PHONE_NUMBER is not set!');
} else {
    console.log(`[Config] Owner number: ...${config.ownerPhoneNumber.slice(-4)}`);
}
console.log(`[Config] Ollama: ${config.ollamaBaseUrl} (model: ${config.ollamaModel})`);
console.log(`[Config] DB: ${config.dbPath}`);
