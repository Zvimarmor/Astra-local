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
    /** Repo root, resolved by walking up from this file. Handy for anything that
     *  needs a path relative to the project rather than to the compiled dist/. */
    projectRoot: PROJECT_ROOT,
    ownerPhoneNumber: (process.env.OWNER_PHONE_NUMBER || '').replace(/\D/g, ''),
    calendarId: (process.env.CALENDAR_ID || 'primary').trim(),
    serviceAccountPath: process.env.SERVICE_ACCOUNT_PATH || path.join(PROJECT_ROOT, 'data', 'service_account.json'),
    // Gemini API — replaced the local Ollama endpoint (2026-08-06) to free the
    // ~7.6GB of RAM qwen3:8b was pinning on this 16GB Mac Mini.
    //
    // Model note: `gemini-1.5-flash` and `gemini-2.5-flash` are retired for new
    // API keys ("no longer available to new users"). `gemini-flash-latest` is
    // the current free-tier alias and is what this key can actually call —
    // verify with `geminiHealth()` before pinning a specific version here.
    gemini: {
        apiKey: (process.env.GEMINI_API_KEY || '').trim(),
        model: (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim(),
        timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '60000', 10),
    },
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

    // Telegram (LEGACY channel → now the out-of-band ALERT carrier). Kept for easy
    // revert; used by the scheduler watchdog to warn when WhatsApp is down.
    // Token also lives in ~/.openclaw/openclaw.json.
    telegram: {
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        ownerChatId: (process.env.TELEGRAM_OWNER_CHAT_ID || '').trim(),
    },

    // SMTP — SEND-side email, used ONLY for out-of-band alerts (normal email is
    // read-only IMAP above). Defaults to Gmail; creds fall back to the personal
    // IMAP account since a Gmail app password works for both IMAP and SMTP.
    smtp: {
        host: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
        port: parseInt(process.env.SMTP_PORT || '465', 10),
        user: (process.env.SMTP_USER || '').trim(),
        password: (process.env.SMTP_PASSWORD || '').trim(),
        from: (process.env.SMTP_FROM || '').trim(),
    },

    // Where out-of-band alert emails go (the watchdog's email fallback).
    alertEmail: (process.env.ALERT_EMAIL || '').trim(),

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

        // Channel watchdog — polls WhatsApp (primary) health and alerts out of band
        // (Telegram + email) when it's down. Bypasses quiet hours: a dead primary
        // channel matters at 3am too.
        //
        // Alerting is EDGE-TRIGGERED and deduped in SQLite (settings table), so a
        // multi-day outage produces ONE alert, not one per failed probe. Reminders
        // are opt-in and off by default — set reminderHours>0 for a periodic nudge.
        watchdogEnabled: (process.env.SCHEDULER_WATCHDOG || 'true').toLowerCase() !== 'false',
        watchdogProbeMinutes: Math.max(1, parseInt(process.env.SCHEDULER_WATCHDOG_PROBE_MIN || '5', 10)),
        // Consecutive failed probes required before alerting — debounces the brief
        // "not linked" window during a normal gateway restart (3 × 5min = 15min).
        watchdogFailuresBeforeAlert: Math.max(1, parseInt(process.env.SCHEDULER_WATCHDOG_FAILURES || '3', 10)),
        // Repeat-nag interval while still down. 0 (default) = alert exactly once
        // per outage, then stay quiet until it recovers.
        watchdogReminderHours: Math.max(0, parseFloat(process.env.SCHEDULER_WATCHDOG_REMINDER_HOURS || '0')),
    },
};

// Boot-time validation
if (!config.ownerPhoneNumber) {
    console.warn('[Config] ⚠ OWNER_PHONE_NUMBER is not set!');
} else {
    console.log(`[Config] Owner number: ...${config.ownerPhoneNumber.slice(-4)}`);
}
if (!config.gemini.apiKey) {
    console.warn('[Config] ⚠ GEMINI_API_KEY is not set — cloud inference will fail!');
} else {
    console.log(`[Config] Gemini: ${config.gemini.model} (key ...${config.gemini.apiKey.slice(-4)})`);
}
console.log(`[Config] DB: ${config.dbPath}`);
