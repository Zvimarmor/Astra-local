import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');

// ─── Schema Initialization ──────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS habits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        frequency TEXT NOT NULL,
        last_logged_date TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposed_fact TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
    );

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

// ═══════════════════════════════════════════════════════════════════
//  MESSAGES (Conversation Memory)
// ═══════════════════════════════════════════════════════════════════

export function addMessage(role: 'user' | 'model', content: string): void {
    try {
        const stmt = db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)');
        stmt.run(role, content);
    } catch (err: any) {
        console.error('[DB] Failed to save message:', err.message);
    }
}

export function getRecentHistory(limit: number = 20): { role: 'user' | 'model'; content: string }[] {
    try {
        const stmt = db.prepare('SELECT role, content FROM messages ORDER BY id DESC LIMIT ?');
        const rows = stmt.all(limit) as { role: 'user' | 'model'; content: string }[];
        return rows.reverse();
    } catch (err: any) {
        console.error('[DB] Failed to read history:', err.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════
//  TASKS (Fully Local — replaces Google Sheets)
// ═══════════════════════════════════════════════════════════════════

function getNextTaskId(): string {
    const stmt = db.prepare("SELECT id FROM tasks ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) DESC LIMIT 1");
    const row = stmt.get() as { id: string } | undefined;
    if (!row) return 'T1';
    const num = parseInt(row.id.substring(1), 10);
    return `T${num + 1}`;
}

export function addTask(title: string, priority: string = 'medium'): { id: string; title: string } {
    const id = getNextTaskId();
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const stmt = db.prepare('INSERT INTO tasks (id, date, title, status, priority) VALUES (?, ?, ?, ?, ?)');
    stmt.run(id, date, title, 'Pending', priority);
    return { id, title };
}

export function getPendingTasks(): { id: string; date: string; title: string; status: string; priority: string }[] {
    const stmt = db.prepare("SELECT id, date, title, status, priority FROM tasks WHERE status = 'Pending' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)");
    return stmt.all() as any[];
}

export function completeTask(taskId: string): boolean {
    const search = taskId.toLowerCase();
    const now = new Date().toISOString();

    // Try exact ID match first
    let stmt = db.prepare("UPDATE tasks SET status = 'Completed', completed_at = ? WHERE LOWER(id) = ? AND status = 'Pending'");
    let info = stmt.run(now, search);
    if (info.changes > 0) return true;

    // Fallback: partial title match
    stmt = db.prepare("UPDATE tasks SET status = 'Completed', completed_at = ? WHERE LOWER(title) LIKE ? AND status = 'Pending'");
    info = stmt.run(now, `%${search}%`);
    return info.changes > 0;
}

export function deleteTask(taskId: string): boolean {
    const search = taskId.toLowerCase();

    // Try exact ID match first
    let stmt = db.prepare("DELETE FROM tasks WHERE LOWER(id) = ?");
    let info = stmt.run(search);
    if (info.changes > 0) return true;

    // Fallback: partial title match
    stmt = db.prepare("DELETE FROM tasks WHERE LOWER(title) LIKE ?");
    info = stmt.run(`%${search}%`);
    return info.changes > 0;
}

// ═══════════════════════════════════════════════════════════════════
//  HABITS
// ═══════════════════════════════════════════════════════════════════

export function addHabit(name: string, frequency: string): void {
    const stmt = db.prepare('INSERT OR REPLACE INTO habits (name, frequency) VALUES (?, ?)');
    stmt.run(name, frequency);
}

export function logHabit(name: string): boolean {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const stmt = db.prepare('UPDATE habits SET last_logged_date = ? WHERE name = ?');
    const info = stmt.run(today, name);
    return info.changes > 0;
}

export function getHabits(): { name: string; frequency: string; last_logged_date: string | null }[] {
    const stmt = db.prepare('SELECT name, frequency, last_logged_date FROM habits');
    return stmt.all() as any[];
}

// ═══════════════════════════════════════════════════════════════════
//  EXPENSES (Local SQLite only — no Google Sheets)
// ═══════════════════════════════════════════════════════════════════

export function addExpense(amount: number, category: string, description: string): { id: number; amount: number; category: string } {
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const stmt = db.prepare('INSERT INTO expenses (amount, category, description, date) VALUES (?, ?, ?, ?)');
    const info = stmt.run(amount, category, description, date);
    return { id: info.lastInsertRowid as number, amount, category };
}

export function getExpenseSummary(period: string = 'week'): {
    period: string;
    since: string;
    categories: { category: string; total: number; count: number }[];
    total: number;
    summary: string;
} {
    const now = new Date();
    let since: string;

    if (period === 'month') {
        const d = new Date(now.getFullYear(), now.getMonth(), 1);
        since = d.toISOString().split('T')[0];
    } else {
        const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        since = d.toISOString().split('T')[0];
    }

    const stmt = db.prepare(`
        SELECT category, SUM(amount) as total, COUNT(*) as count
        FROM expenses
        WHERE date >= ?
        GROUP BY category
        ORDER BY total DESC
    `);
    const rows = stmt.all(since) as { category: string; total: number; count: number }[];
    const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

    return {
        period,
        since,
        categories: rows,
        total: grandTotal,
        summary: `Total expenses (${period}): ${grandTotal} NIS`
    };
}

// ═══════════════════════════════════════════════════════════════════
//  PENDING FACTS (Approval-based Memory)
// ═══════════════════════════════════════════════════════════════════

const STALE_TIMEOUT_MINUTES = 10;

/**
 * Insert a new pending fact. Auto-declines any stale pending facts
 * older than STALE_TIMEOUT_MINUTES before inserting.
 */
export function addPendingFact(fact: string): number {
    try {
        // Auto-decline stale pending facts
        const cutoff = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000).toISOString();
        db.prepare(
            "UPDATE pending_facts SET status = 'declined', resolved_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND created_at < ?"
        ).run(cutoff);

        // Also decline any remaining pending facts (one-at-a-time policy)
        db.prepare(
            "UPDATE pending_facts SET status = 'declined', resolved_at = CURRENT_TIMESTAMP WHERE status = 'pending'"
        ).run();

        const stmt = db.prepare('INSERT INTO pending_facts (proposed_fact) VALUES (?)');
        const info = stmt.run(fact);
        return info.lastInsertRowid as number;
    } catch (err: any) {
        console.error('[DB] Failed to add pending fact:', err.message);
        throw err;
    }
}

/**
 * Get the most recent pending fact awaiting approval, or null.
 */
export function getActivePendingFact(): { id: number; proposed_fact: string } | null {
    try {
        const stmt = db.prepare(
            "SELECT id, proposed_fact FROM pending_facts WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
        );
        const row = stmt.get() as { id: number; proposed_fact: string } | undefined;
        return row || null;
    } catch (err: any) {
        console.error('[DB] Failed to get pending fact:', err.message);
        return null;
    }
}

/**
 * Resolve a pending fact as approved or declined.
 */
export function resolvePendingFact(id: number, approved: boolean): boolean {
    try {
        const status = approved ? 'approved' : 'declined';
        const stmt = db.prepare(
            'UPDATE pending_facts SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?'
        );
        const info = stmt.run(status, id, 'pending');
        return info.changes > 0;
    } catch (err: any) {
        console.error('[DB] Failed to resolve pending fact:', err.message);
        return false;
    }
}

/**
 * Append a fact to knowledge/learned_facts.md.
 * Uses fs.appendFileSync with the 'a' flag — strictly append-only.
 * Never reads, truncates, or modifies existing content.
 */
export function appendToLearnedFacts(fact: string): void {
    try {
        const filePath = path.join(process.cwd(), 'knowledge', 'learned_facts.md');
        const date = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
        const entry = `- ${fact} _(learned ${date})_\n`;
        fs.appendFileSync(filePath, entry, { encoding: 'utf-8', flag: 'a' });
        console.log(`[Memory] Appended fact to learned_facts.md: "${fact}"`);
    } catch (err: any) {
        console.error('[Memory] Failed to append fact:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  WHATSAPP MEDIA (Read-Only Query)
// ═══════════════════════════════════════════════════════════════════

export function getRecentWhatsAppMedia(
    count: number = 10,
    mediaType?: string
): { id: number; sender: string; media_type: string; mime_type: string | null; caption: string | null; file_path: string; file_size: number | null; received_at: string }[] {
    try {
        let query = 'SELECT id, sender, media_type, mime_type, caption, file_path, file_size, received_at FROM whatsapp_media';
        const params: any[] = [];

        if (mediaType) {
            query += ' WHERE media_type = ?';
            params.push(mediaType);
        }

        query += ' ORDER BY id DESC LIMIT ?';
        params.push(count);

        const stmt = db.prepare(query);
        return stmt.all(...params) as any[];
    } catch (err: any) {
        console.error('[DB] Failed to query WhatsApp media:', err.message);
        return [];
    }
}
