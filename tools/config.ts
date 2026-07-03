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
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim(),
    ollamaModel: (process.env.OLLAMA_MODEL || 'qwen3:8b').trim(),
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

    // Second-brain notes vault — Obsidian-compatible markdown (.md with [[wikilinks]])
    vaultDir: process.env.VAULT_DIR || path.join(PROJECT_ROOT, 'vault'),

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

    // WhatsApp (PRIMARY channel). Proactive scheduler + voice replies send via the
    // OpenClaw gateway CLI (`openclaw message send --channel whatsapp`), which reuses
    // the single linked WhatsApp session — WhatsApp has no bot HTTP API of its own.
    whatsapp: {
        // Where proactive/voice messages are delivered — your personal number, E.164 (e.g. +9725...).
        ownerTarget: (process.env.WHATSAPP_OWNER_TARGET || '').trim(),
        // Astra's own linked WhatsApp number (the dedicated SIM), E.164 — informational only.
        selfNumber: (process.env.WHATSAPP_SELF_NUMBER || '').trim(),
        // OpenClaw channel account id (see `openclaw channels list`).
        account: (process.env.WHATSAPP_ACCOUNT || 'default').trim(),
        // Absolute path to the openclaw CLI — launchd's PATH usually omits /opt/homebrew/bin.
        openclawBin: (process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw').trim(),
    },

    // Telegram (LEGACY fallback). Kept for easy revert; no longer the active channel.
    // Token also lives in ~/.openclaw/openclaw.json.
    telegram: {
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        ownerChatId: (process.env.TELEGRAM_OWNER_CHAT_ID || '').trim(),
    },

    // Proactive scheduler (services/scheduler.ts → dist-services/scheduler.js)
    // Deterministic, no LLM: reads SQLite and pushes formatted messages on a timer.
    scheduler: {
        tickSeconds: parseInt(process.env.SCHEDULER_TICK_SECONDS || '60', 10),
        // Nightly quiet window (no proactive messages). Local hours, Asia/Jerusalem.
        quietNightStart: parseInt(process.env.SCHEDULER_QUIET_NIGHT_START || '22', 10),
        quietNightEnd: parseInt(process.env.SCHEDULER_QUIET_NIGHT_END || '7', 10),
        // Shabbat quiet window (approximate, no sunset math). Friday >= start hour
        // through Saturday < end hour. Errs toward MORE quiet, which is safe.
        quietShabbat: (process.env.SCHEDULER_QUIET_SHABBAT || 'true').toLowerCase() !== 'false',
        shabbatStartHourFri: parseInt(process.env.SCHEDULER_SHABBAT_START_FRI || '18', 10),
        shabbatEndHourSat: parseInt(process.env.SCHEDULER_SHABBAT_END_SAT || '20', 10),
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
