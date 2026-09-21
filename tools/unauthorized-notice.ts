/**
 * Polite Hebrew redirect for strangers who message Astra's WhatsApp line.
 *
 * WHY THIS FILE IS NOT LIKE THE REST OF tools/
 * --------------------------------------------
 * Every other module here is loaded by our own processes (the MCP server, the
 * scheduler). This one is loaded by the **OpenClaw gateway process**, from a
 * patch applied to the installed @openclaw/whatsapp plugin — because OpenClaw
 * drops unauthorized DMs inside the WhatsApp ingress gate, before any hook,
 * agent or MCP tool can see them (see docs/WHATSAPP-UNAUTHORIZED-NOTICE.md).
 *
 * That has two hard consequences, and both are the reason this file
 * deliberately duplicates a little of tools/storage.ts instead of importing it:
 *
 *   1. NO dotenv. tools/config.ts calls dotenv on import, which would inject
 *      all ~45 keys of our .env into the gateway's environment — including
 *      PORT and GEMINI_API_KEY. Silently repointing the gateway's port is not
 *      a price worth paying for a cooldown check.
 *   2. NO import of tools/storage.ts. Importing it would execute the whole
 *      schema bootstrap (and its config import) inside the gateway.
 *
 * So: better-sqlite3 + node builtins only, one tiny table, own connection.
 * The equivalent helpers on tools/storage.ts (claimSenderNotice et al.) remain
 * the ones to use from inside Astra's own processes; both read and write the
 * same `unauthorized_sender_notices` rows in the same DB, which is safe
 * because storage.ts puts the database in WAL mode.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/** 7 days. A stranger gets the redirect once, not once per message. */
export const UNAUTHORIZED_NOTICE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 604_800_000

/**
 * The owner's primary number is NOT hardcoded: this repo is public, and a
 * personal mobile number in git history is forever. It lives in `.env`
 * (gitignored) as OWNER_PRIMARY_NUMBER.
 *
 * Reading it is fiddly precisely because of this file's no-dotenv rule (see
 * the header). The gateway is launched by launchd and inherits none of our
 * .env, so `process.env` alone would be empty there — but calling dotenv would
 * inject all ~45 keys into the gateway process, which is the thing we are
 * avoiding. So: parse the one key we need straight out of the file, and never
 * touch process.env.
 */
const ENV_PATH = path.join(__dirname, '..', '.env');

let primaryNumberCache: string | null | undefined;

function readPrimaryNumber(): string | null {
    if (primaryNumberCache !== undefined) return primaryNumberCache;

    // An already-populated process.env wins (our own tools do load dotenv).
    const fromEnv = (process.env.OWNER_PRIMARY_NUMBER || '').trim();
    if (fromEnv) {
        primaryNumberCache = fromEnv;
        return primaryNumberCache;
    }

    try {
        for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
            const match = /^\s*OWNER_PRIMARY_NUMBER\s*=\s*(.*)$/.exec(line);
            if (!match) continue;
            const value = match[1].trim().replace(/^['"]|['"]$/g, '').trim();
            if (value) {
                primaryNumberCache = value;
                return primaryNumberCache;
            }
        }
    } catch {
        // .env absent or unreadable — fall through to null.
    }

    primaryNumberCache = null;
    return primaryNumberCache;
}

/** The text sent to an unapproved sender, or null if no number is configured. */
export function buildUnauthorizedRedirectMessage(): string | null {
    const primary = readPrimaryNumber();
    if (!primary) return null;
    return [
        'היי! זהו מספר ייעודי של העוזרת האישית שלי (אסטרה) 🤖.',
        `לתקשורת ישירה איתי, מוזמנים לכתוב למספר הראשי שלי: ${primary}.`,
        'שיהיה יום מעולה!',
    ].join('\n');
}

// Mirrors tools/config.ts's resolution without importing it (see header).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'memory.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
    if (db) return db;
    const handle = new Database(DB_PATH);
    handle.pragma('journal_mode = WAL');
    // The gateway may well open this before the MCP server ever runs, so this
    // module cannot assume storage.ts has already created the table.
    handle.exec(`
        CREATE TABLE IF NOT EXISTS unauthorized_sender_notices (
            sender_e164 TEXT PRIMARY KEY,
            last_notified_at INTEGER NOT NULL
        );
    `);
    db = handle;
    return db;
}

/**
 * Reduce any E.164-ish form to bare digits. The same human reaches us as
 * "+972…", "972…" or a LID-resolved form depending on the code path, and three
 * spellings would otherwise mean three notices.
 */
export function normalizeSenderE164(sender: string): string {
    return (sender || '').replace(/\D/g, '');
}

/**
 * Atomic check-and-set. Returns the message to send, or null to stay silent.
 *
 * Fails CLOSED: if the database is unreachable we return null rather than
 * sending. A stranger getting no reply is a much smaller failure than a
 * stranger getting one on every single message because the cooldown ledger
 * could not be written.
 */
export function claimUnauthorizedNotice(
    sender: string,
    now: number = Date.now(),
): string | null {
    const key = normalizeSenderE164(sender);
    if (!key) return null;

    // Resolve the text BEFORE claiming the cooldown slot: burning a sender's
    // once-per-7-days slot on a message we then cannot send would mean they
    // get nothing now and nothing for a week either.
    const message = buildUnauthorizedRedirectMessage();
    if (!message) {
        console.error('[astra-notice] OWNER_PRIMARY_NUMBER is not set in .env — staying silent.');
        return null;
    }

    try {
        const handle = getDb();
        const claim = handle.transaction((): boolean => {
            const row = handle
                .prepare('SELECT last_notified_at FROM unauthorized_sender_notices WHERE sender_e164 = ?')
                .get(key) as { last_notified_at: number } | undefined;
            if (row && now - row.last_notified_at < UNAUTHORIZED_NOTICE_COOLDOWN_MS) return false;
            handle.prepare(
                'INSERT INTO unauthorized_sender_notices (sender_e164, last_notified_at) VALUES (?, ?) ' +
                'ON CONFLICT(sender_e164) DO UPDATE SET last_notified_at = excluded.last_notified_at',
            ).run(key, now);
            return true;
        });
        return claim() ? message : null;
    } catch (err) {
        console.error('[astra-notice] cooldown check failed, staying silent:', String(err).slice(0, 200));
        return null;
    }
}
