/**
 * WhatsApp Media Listener — Read-Only Background Service
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  SAFETY: This is a STANDALONE process. It runs independently    │
 * │  from OpenClaw and the Astra agent. It connects to WhatsApp     │
 * │  via Baileys and ONLY downloads incoming media.                 │
 * │                                                                  │
 * │  ⛔ sendMessage is NEVER called.                                │
 * │  ⛔ This file has NO exports — it cannot be imported by tools.  │
 * │  ⛔ The LLM has no code path to send WhatsApp messages.        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * What it does:
 *   1. Connects to WhatsApp (reuses auth from data/whatsapp_auth/)
 *   2. Listens for incoming messages with media (images, videos, docs)
 *   3. Downloads media files to data/media/whatsapp/
 *   4. Saves metadata to the shared SQLite DB (whatsapp_media table)
 *   5. Logs activity — never responds to messages
 *
 * Run: node dist-services/whatsapp-listener.js
 */

import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    // NOTE: We do NOT import sendMessage or any write functions.
} from '@whiskeysockets/baileys';
import pino from 'pino';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'memory.db');
const AUTH_DIR = path.join(process.cwd(), 'data', 'whatsapp_auth');
const MEDIA_DIR = path.join(process.cwd(), 'data', 'media', 'whatsapp');

// Ensure directories exist
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ─── Database ────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create table if it doesn't exist (same schema as tools/storage.ts)
db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        media_type TEXT NOT NULL,
        mime_type TEXT,
        caption TEXT,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const insertStmt = db.prepare(
    'INSERT INTO whatsapp_media (sender, media_type, mime_type, caption, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?)'
);

// ─── MIME → Extension Mapping ────────────────────────────────────────

function getExtFromMime(mime: string): string {
    const map: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'video/3gpp': '3gp',
        'audio/ogg; codecs=opus': 'ogg',
        'audio/mpeg': 'mp3',
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    };
    return map[mime] || mime.split('/').pop() || 'bin';
}

// ─── Media Message Detection ─────────────────────────────────────────

interface MediaMatch {
    key: string;
    type: string;
}

const MEDIA_TYPES: MediaMatch[] = [
    { key: 'imageMessage', type: 'image' },
    { key: 'videoMessage', type: 'video' },
    { key: 'documentMessage', type: 'document' },
    { key: 'stickerMessage', type: 'image' },
];

// ─── Main Listener ───────────────────────────────────────────────────

async function startListener(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  WhatsApp Media Listener (READ-ONLY)            ║');
    console.log('║  ⛔ Cannot send messages — safety enforced      ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`[Listener] DB: ${DB_PATH}`);
    console.log(`[Listener] Media dir: ${MEDIA_DIR}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Listener] Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }) as any,
        printQRInTerminal: true,
        browser: ['Astra-Listener', 'Safari', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n─── SCAN THIS QR CODE TO AUTHENTICATE ───');
            // QR will be printed by printQRInTerminal: true
            console.log('──────────────────────────────────────────\n');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Listener] Connection closed (status: ${statusCode})`);

            if (shouldReconnect) {
                console.log('[Listener] Reconnecting in 5s...');
                setTimeout(startListener, 5000);
            } else {
                console.log('[Listener] Logged out. Delete data/whatsapp_auth/ and restart to re-authenticate.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('[Listener] ✓ Connected to WhatsApp (read-only mode — NOT sending messages)');
        }
    });

    // ─── Message Handler (Media Download Only) ───────────────────

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg?.message) continue;

            const remoteJid = msg.key.remoteJid || '';
            const sender = remoteJid
                .replace('@s.whatsapp.net', '')
                .replace(/@g\.us$/, '-group');

            // Unwrap possible message wrappers
            const innerMessage = msg.message.ephemeralMessage?.message
                || msg.message.viewOnceMessage?.message
                || msg.message.viewOnceMessageV2?.message
                || msg.message.documentWithCaptionMessage?.message
                || msg.message;

            // Check each media type
            for (const { key, type } of MEDIA_TYPES) {
                const mediaMsg = (innerMessage as any)[key];
                if (!mediaMsg) continue;

                try {
                    const mimeType = mediaMsg.mimetype || `${type}/*`;
                    const caption = mediaMsg.caption || mediaMsg.fileName || null;

                    console.log(`[Listener] 📥 ${type} from ${sender} (${mimeType})`);

                    // Download media
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;

                    // Save to disk
                    const ext = getExtFromMime(mimeType);
                    const timestamp = Date.now();
                    const filename = `${type}_${sender}_${timestamp}.${ext}`;
                    const filePath = path.join(MEDIA_DIR, filename);
                    fs.writeFileSync(filePath, buffer);

                    // Save metadata to SQLite
                    insertStmt.run(sender, type, mimeType, caption, filePath, buffer.length);

                    console.log(`[Listener] ✓ Saved: ${filename} (${Math.round(buffer.length / 1024)} KB)`);
                } catch (err: any) {
                    console.error(`[Listener] ✗ Failed to download ${type} from ${sender}:`, err.message);
                }
            }
        }
    });
}

// ─── Entry Point ─────────────────────────────────────────────────────

startListener().catch(err => {
    console.error('[Fatal] Listener startup error:', err);
    process.exit(1);
});
