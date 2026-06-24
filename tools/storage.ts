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

    CREATE TABLE IF NOT EXISTS budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL UNIQUE,
        monthly_limit REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recurring_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        frequency TEXT NOT NULL,
        day_of_week INTEGER,
        day_of_month INTEGER,
        last_generated_date TEXT,
        active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS income (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        source TEXT NOT NULL,
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL,
        hour INTEGER NOT NULL,
        minute INTEGER NOT NULL DEFAULT 0,
        days TEXT NOT NULL DEFAULT 'daily',
        enabled INTEGER NOT NULL DEFAULT 1,
        catch_up INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL,
        run_date TEXT NOT NULL,
        ran_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL,
        detail TEXT,
        UNIQUE(schedule_id, run_date)
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
    CREATE INDEX IF NOT EXISTS idx_income_date ON income(date);
`);

// Seed the default schedule set on first run (only if empty).
// Times are local (Asia/Jerusalem). See services/scheduler.ts for the jobs.
{
    const count = (db.prepare('SELECT COUNT(*) as c FROM schedules').get() as { c: number }).c;
    if (count === 0) {
        const seed = db.prepare(
            'INSERT INTO schedules (job, hour, minute, days, enabled, catch_up) VALUES (?, ?, ?, ?, 1, ?)'
        );
        // job, hour, minute, days, catch_up. catch_up=1 everywhere → "fire late, once"
        // if the Mac was asleep/off at the scheduled time (user's chosen policy).
        const defaults: [string, number, number, string, number][] = [
            ['recurring_gen', 7, 0, 'daily', 1],     // generate tasks from templates (silent unless created)
            ['morning_briefing', 8, 0, 'daily', 1],  // full briefing
            ['budget_check', 12, 0, 'daily', 1],     // silent unless warnings/overages
            ['email_digest', 17, 0, 'daily', 1],     // unread summary (silent if nothing)
            ['evening_review', 20, 0, 'daily', 1],   // evening summary
        ];
        const tx = db.transaction(() => {
            for (const [job, h, m, days, cu] of defaults) seed.run(job, h, m, days, cu);
        });
        tx();
        console.log('[Storage] Seeded default schedules (5 jobs).');
    }
}

// Migration: add a free-form payload column to schedules (used by music_alarm jobs
// to carry {query,type}). Guarded so it's a no-op once the column exists.
{
    const cols = db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'payload')) {
        db.exec('ALTER TABLE schedules ADD COLUMN payload TEXT');
    }
}

// Ensure the analytical jobs exist (added after the original 5-job seed, so this
// must run as an idempotent "insert if missing" rather than the empty-table seed
// above — existing DBs already have rows). LLM-phrased, deterministic fallback.
{
    const ensure = db.prepare(
        `INSERT INTO schedules (job, hour, minute, days, enabled, catch_up)
         SELECT ?, ?, ?, ?, 1, 1
         WHERE NOT EXISTS (SELECT 1 FROM schedules WHERE job = ?)`
    );
    // weekly_recap: Saturday 20:30 (after Shabbat quiet ends at 20:00), days '6' = Sat.
    // monthly_finance_review: scheduled daily 21:00; the builder self-gates to the LAST
    //   day of the month so the month-to-date overview covers the full ending month
    //   (no day_of_month column needed).
    const extras: [string, number, number, string][] = [
        ['weekly_recap', 20, 30, '6'],
        ['monthly_finance_review', 21, 0, 'daily'],
    ];
    const tx = db.transaction(() => {
        for (const [job, h, m, days] of extras) ensure.run(job, h, m, days, job);
    });
    tx();
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Storage] Closing database connection...');
    db.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('\n[Storage] Closing database connection...');
    db.close();
    process.exit(0);
});

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

// ═══════════════════════════════════════════════════════════════════
//  BUDGETS (Monthly Spending Limits)
// ═══════════════════════════════════════════════════════════════════

export function setBudget(category: string, monthlyLimit: number): void {
    const stmt = db.prepare(
        'INSERT INTO budgets (category, monthly_limit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit = ?'
    );
    stmt.run(category.toLowerCase(), monthlyLimit, monthlyLimit);
}

export function getBudgets(): { category: string; monthly_limit: number }[] {
    const stmt = db.prepare('SELECT category, monthly_limit FROM budgets ORDER BY category');
    return stmt.all() as any[];
}

export function deleteBudget(category: string): boolean {
    const stmt = db.prepare('DELETE FROM budgets WHERE LOWER(category) = ?');
    const info = stmt.run(category.toLowerCase());
    return info.changes > 0;
}

export function checkBudgetAlerts(): {
    category: string;
    spent: number;
    limit: number;
    percent: number;
    alert: 'ok' | 'warning' | 'over';
}[] {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    const budgets = getBudgets();
    return budgets.map(b => {
        const row = db.prepare(
            'SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE LOWER(category) = ? AND date >= ?'
        ).get(b.category, monthStart) as { total: number };

        const spent = row.total;
        const percent = b.monthly_limit > 0 ? Math.round((spent / b.monthly_limit) * 100) : 0;
        let alert: 'ok' | 'warning' | 'over' = 'ok';
        if (percent >= 100) alert = 'over';
        else if (percent >= 80) alert = 'warning';

        return { category: b.category, spent, limit: b.monthly_limit, percent, alert };
    });
}

// ═══════════════════════════════════════════════════════════════════
//  RECURRING TASKS
// ═══════════════════════════════════════════════════════════════════

export function addRecurringTask(
    title: string,
    priority: string = 'medium',
    frequency: string,
    dayOfWeek?: number,
    dayOfMonth?: number
): number {
    const stmt = db.prepare(
        'INSERT INTO recurring_tasks (title, priority, frequency, day_of_week, day_of_month) VALUES (?, ?, ?, ?, ?)'
    );
    const info = stmt.run(title, priority, frequency, dayOfWeek ?? null, dayOfMonth ?? null);
    return info.lastInsertRowid as number;
}

export function getActiveRecurringTasks(): {
    id: number; title: string; priority: string; frequency: string;
    day_of_week: number | null; day_of_month: number | null; last_generated_date: string | null;
}[] {
    const stmt = db.prepare('SELECT id, title, priority, frequency, day_of_week, day_of_month, last_generated_date FROM recurring_tasks WHERE active = 1');
    return stmt.all() as any[];
}

export function deactivateRecurringTask(id: number): boolean {
    const stmt = db.prepare('UPDATE recurring_tasks SET active = 0 WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
}

/**
 * Generate real tasks from recurring templates that are due today.
 * Returns the count of tasks generated.
 */
export function generateDueRecurringTasks(): number {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
    const dayOfMonth = new Date().getDate();

    const templates = getActiveRecurringTasks();
    let generated = 0;

    for (const t of templates) {
        // Skip if already generated today
        if (t.last_generated_date === today) continue;

        let shouldGenerate = false;

        if (t.frequency === 'daily') {
            shouldGenerate = true;
        } else if (t.frequency === 'weekly' && t.day_of_week !== null) {
            shouldGenerate = dayOfWeek === t.day_of_week;
        } else if (t.frequency === 'monthly' && t.day_of_month !== null) {
            shouldGenerate = dayOfMonth === t.day_of_month;
        }

        if (shouldGenerate) {
            addTask(t.title, t.priority);
            db.prepare('UPDATE recurring_tasks SET last_generated_date = ? WHERE id = ?').run(today, t.id);
            generated++;
        }
    }

    return generated;
}

// ═══════════════════════════════════════════════════════════════════
//  INCOME (Financial Tracking)
// ═══════════════════════════════════════════════════════════════════

export function addIncome(amount: number, source: string, description: string): { id: number; amount: number; source: string } {
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const stmt = db.prepare('INSERT INTO income (amount, source, description, date) VALUES (?, ?, ?, ?)');
    const info = stmt.run(amount, source, description, date);
    return { id: info.lastInsertRowid as number, amount, source };
}

export function getIncomeSummary(period: string = 'month'): {
    period: string;
    since: string;
    sources: { source: string; total: number; count: number }[];
    total: number;
} {
    const now = new Date();
    let since: string;

    if (period === 'year') {
        since = `${now.getFullYear()}-01-01`;
    } else if (period === 'week') {
        const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        since = d.toISOString().split('T')[0];
    } else {
        // month (default)
        const d = new Date(now.getFullYear(), now.getMonth(), 1);
        since = d.toISOString().split('T')[0];
    }

    const stmt = db.prepare(`
        SELECT source, SUM(amount) as total, COUNT(*) as count
        FROM income
        WHERE date >= ?
        GROUP BY source
        ORDER BY total DESC
    `);
    const rows = stmt.all(since) as { source: string; total: number; count: number }[];
    const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

    return { period, since, sources: rows, total: grandTotal };
}

export function getFinancialOverview(period: string = 'month'): {
    period: string;
    since: string;
    total_income: number;
    total_expenses: number;
    net: number;
    income_sources: { source: string; total: number }[];
    expense_categories: { category: string; total: number }[];
    summary: string;
} {
    const now = new Date();
    let since: string;

    if (period === 'year') {
        since = `${now.getFullYear()}-01-01`;
    } else if (period === 'week') {
        const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        since = d.toISOString().split('T')[0];
    } else {
        const d = new Date(now.getFullYear(), now.getMonth(), 1);
        since = d.toISOString().split('T')[0];
    }

    const incomeRows = db.prepare(
        'SELECT source, SUM(amount) as total FROM income WHERE date >= ? GROUP BY source ORDER BY total DESC'
    ).all(since) as { source: string; total: number }[];

    const expenseRows = db.prepare(
        'SELECT category, SUM(amount) as total FROM expenses WHERE date >= ? GROUP BY category ORDER BY total DESC'
    ).all(since) as { category: string; total: number }[];

    const totalIncome = incomeRows.reduce((s, r) => s + r.total, 0);
    const totalExpenses = expenseRows.reduce((s, r) => s + r.total, 0);
    const net = totalIncome - totalExpenses;

    const netSign = net >= 0 ? '+' : '';
    return {
        period, since,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net,
        income_sources: incomeRows,
        expense_categories: expenseRows,
        summary: `Financial Overview (${period}): Income ${totalIncome} NIS, Expenses ${totalExpenses} NIS, Net ${netSign}${net} NIS`,
    };
}

// ═══════════════════════════════════════════════════════════════════
//  SCHEDULES (Proactive Scheduler — consumed by services/scheduler.ts)
// ═══════════════════════════════════════════════════════════════════

export interface Schedule {
    id: number;
    job: string;
    hour: number;
    minute: number;
    days: string;       // 'daily' or CSV of 0-6 (0=Sunday)
    enabled: number;
    catch_up: number;
    payload: string | null; // JSON for parametrized jobs (e.g. music_alarm {query,type})
}

export function getEnabledSchedules(): Schedule[] {
    return db.prepare('SELECT id, job, hour, minute, days, enabled, catch_up, payload FROM schedules WHERE enabled = 1').all() as Schedule[];
}

export function getSchedules(): Schedule[] {
    return db.prepare('SELECT id, job, hour, minute, days, enabled, catch_up, payload FROM schedules ORDER BY hour, minute').all() as Schedule[];
}

// ─── Music alarms (rows in `schedules` with job='music_alarm') ────────
// catch_up=0 + the scheduler's tight grace = "skip if missed" (never plays late).

export interface MusicAlarm {
    id: number; hour: number; minute: number; days: string;
    query: string; type: string;
}

export function addMusicAlarm(query: string, type: string, hour: number, minute: number = 0, days: string = 'daily'): { id: number } {
    const payload = JSON.stringify({ query, type: type || 'track' });
    const info = db.prepare(
        "INSERT INTO schedules (job, hour, minute, days, enabled, catch_up, payload) VALUES ('music_alarm', ?, ?, ?, 1, 0, ?)"
    ).run(hour, minute, days, payload);
    return { id: Number(info.lastInsertRowid) };
}

export function getMusicAlarms(): MusicAlarm[] {
    const rows = db.prepare("SELECT id, hour, minute, days, payload FROM schedules WHERE job = 'music_alarm' ORDER BY hour, minute").all() as any[];
    return rows.map(r => {
        let p: any = {};
        try { p = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
        return { id: r.id, hour: r.hour, minute: r.minute, days: r.days, query: p.query || '', type: p.type || 'track' };
    });
}

export function cancelMusicAlarm(id: number): boolean {
    const info = db.prepare("DELETE FROM schedules WHERE id = ? AND job = 'music_alarm'").run(id);
    db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(id); // tidy any run rows
    return info.changes > 0;
}

/** True if this schedule already has a run row for the given local date. */
export function hasRunOnDate(scheduleId: number, runDate: string): boolean {
    const row = db.prepare('SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND run_date = ? LIMIT 1').get(scheduleId, runDate);
    return !!row;
}

/**
 * Record a run for (schedule, date). Returns true if THIS call claimed the slot
 * (i.e. no prior row existed). The UNIQUE(schedule_id, run_date) constraint makes
 * this the idempotency guard — only the first writer per day proceeds to send.
 */
export function claimScheduleRun(scheduleId: number, runDate: string, status: string, detail?: string): boolean {
    try {
        const info = db.prepare(
            'INSERT INTO schedule_runs (schedule_id, run_date, status, detail) VALUES (?, ?, ?, ?)'
        ).run(scheduleId, runDate, status, detail ?? null);
        return info.changes > 0;
    } catch (err: any) {
        // UNIQUE violation → another tick already claimed this day.
        if (String(err.message).includes('UNIQUE')) return false;
        throw err;
    }
}

/** Update the status/detail of an already-claimed run for the day. */
export function updateScheduleRun(scheduleId: number, runDate: string, status: string, detail?: string): void {
    db.prepare('UPDATE schedule_runs SET status = ?, detail = ?, ran_at = CURRENT_TIMESTAMP WHERE schedule_id = ? AND run_date = ?')
        .run(status, detail ?? null, scheduleId, runDate);
}

/** Enable/disable a schedule by id. Returns true if a row changed. */
export function setScheduleEnabled(id: number, enabled: boolean): boolean {
    const info = db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return info.changes > 0;
}

/** Update a schedule's time (and optionally days) by id. Returns true if changed. */
export function updateScheduleTime(id: number, hour: number, minute: number, days?: string): boolean {
    const info = days !== undefined
        ? db.prepare('UPDATE schedules SET hour = ?, minute = ?, days = ? WHERE id = ?').run(hour, minute, days, id)
        : db.prepare('UPDATE schedules SET hour = ?, minute = ? WHERE id = ?').run(hour, minute, id);
    return info.changes > 0;
}

// ─── Generic key/value settings (e.g. voice output mode) ─────────────────────
export function getSetting(key: string, fallback: string = ''): string {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
    db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
    ).run(key, value);
}
