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

// Migration (2026-08-07): day-planning columns on tasks.
//
// `tasks.date` is the CREATION date and always has been — it is written from
// `new Date()` at insert and never means "when is this due". Adding a real
// `due_date` is what makes deadline questions ("what's due this week?", "am I
// behind?") answerable at all; before this they were impossible, not just
// unimplemented. `date` is left alone so existing rows/readers keep working.
//
// NULL due_date = "someday", deliberately: most tasks don't have a deadline and
// forcing one would make the overdue list meaningless.
{
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    const have = new Set(cols.map(c => c.name));
    if (!have.has('due_date')) db.exec('ALTER TABLE tasks ADD COLUMN due_date TEXT');
    if (!have.has('estimate_minutes')) db.exec('ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER');
    if (!have.has('project_id')) db.exec('ALTER TABLE tasks ADD COLUMN project_id INTEGER');
    if (!have.has('notes')) db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
}

// Migration (2026-08-23): the ROLLING TASK QUEUE.
//
// THE PROBLEM THIS FIXES: a single `due_date` column was carrying two completely
// different meanings — "the world will punish me if this slips" (a real external
// deadline) and "I meant to do this on Tuesday" (a plan I made for myself). Since
// only one column existed, every plan that slipped a day became an "OVERDUE 🔴"
// alarm. After a few weeks the red list was mostly self-imposed noise and the two
// genuinely immovable deadlines in it were invisible. Alarm fatigue by design.
//
// THE SPLIT:
//   deadline      — HARD, external, rare. Only this can make a task overdue.
//   planned_date  — SOFT, self-assigned, rolls forward freely. Never overdue.
//
// Existing `due_date` values migrate to `planned_date`, NOT to `deadline`. That
// direction is deliberate: we cannot tell retroactively which of the old dates
// were real deadlines, and demoting a real deadline to a plan is recoverable
// (the user re-states it) while promoting a soft plan to a hard deadline would
// recreate exactly the false-alarm problem this migration exists to end.
//
// `due_date` itself is KEPT and mirrored to COALESCE(deadline, planned_date) on
// every write. It is a legacy read mirror only — nothing should branch on it —
// but it keeps any not-yet-rebuilt `dist/` consumer and the existing index honest.
{
    let cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    let have = new Set(cols.map(c => c.name));

    // `estimate_minutes` → `estimated_minutes`. One canonical name; the tool layer
    // still ACCEPTS the old parameter spelling so existing skills keep working.
    if (have.has('estimate_minutes') && !have.has('estimated_minutes')) {
        db.exec('ALTER TABLE tasks RENAME COLUMN estimate_minutes TO estimated_minutes');
        cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
        have = new Set(cols.map(c => c.name));
    }

    const addCol = (name: string, decl: string) => {
        if (!have.has(name)) { db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`); have.add(name); }
    };
    addCol('estimated_minutes', 'INTEGER');
    addCol('planned_date', 'TEXT');
    addCol('deadline', 'TEXT');
    addCol('state', 'TEXT');
    addCol('task_kind', 'TEXT');
    addCol('waiting_on', 'TEXT');
    addCol('rollover_count', 'INTEGER NOT NULL DEFAULT 0');
    addCol('last_rescheduled_at', 'TEXT');

    // Backfill, idempotent — each UPDATE only touches rows not yet migrated.
    db.exec(`
        UPDATE tasks SET planned_date = due_date
         WHERE planned_date IS NULL AND due_date IS NOT NULL;

        UPDATE tasks SET state = CASE
                WHEN status = 'Completed' THEN 'done'
                WHEN planned_date IS NOT NULL OR deadline IS NOT NULL THEN 'planned'
                ELSE 'inbox' END
         WHERE state IS NULL;

        UPDATE tasks SET rollover_count = 0 WHERE rollover_count IS NULL;
    `);
}

// Projects ("missions") — a named objective that owns tasks. Progress is always
// derived from the linked tasks rather than stored, so it can't drift out of sync
// with reality.
db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        target_date TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date) WHERE due_date IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id) WHERE project_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline) WHERE deadline IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_planned ON tasks(planned_date) WHERE planned_date IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
`);

// Habit log history. The `habits` table only ever stored `last_logged_date`, which
// is enough to answer "did I do it today?" but makes streaks impossible — there is
// no history to count back through. One row per habit per day; UNIQUE makes a
// double-log the same day a no-op rather than a corrupt streak.
db.exec(`
    CREATE TABLE IF NOT EXISTS habit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        habit_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(habit_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON habit_logs(habit_id, date DESC);
`);

// Backfill habit_logs from the single last_logged_date each habit carries, so an
// existing habit shows a streak of 1 today instead of 0 (which would read as
// "you broke your streak" the first time this ships).
{
    const rows = db.prepare('SELECT id, last_logged_date FROM habits WHERE last_logged_date IS NOT NULL').all() as { id: number; last_logged_date: string }[];
    const ins = db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, date) VALUES (?, ?)');
    const tx = db.transaction(() => { for (const r of rows) ins.run(r.id, r.last_logged_date); });
    if (rows.length) tx();
}

// Ensure the analytical jobs exist (added after the original 5-job seed, so this
// must run as an idempotent "insert if missing" rather than the empty-table seed
// above — existing DBs already have rows). LLM-phrased, deterministic fallback.
{
    const ensure = db.prepare(
        `INSERT INTO schedules (job, hour, minute, days, enabled, catch_up)
         SELECT ?, ?, ?, ?, ?, 1
         WHERE NOT EXISTS (SELECT 1 FROM schedules WHERE job = ?)`
    );
    // weekly_recap: Saturday 20:30 (after Shabbat quiet ends at 20:00), days '6' = Sat.
    // monthly_finance_review: scheduled daily 21:00; the builder self-gates to the LAST
    //   day of the month so the month-to-date overview covers the full ending month
    //   (no day_of_month column needed).
    // deadline_watch: seeded DISABLED (2026-08-18). Its content — overdue,
    //   due-today and closing projects — is now a section inside the 08:00
    //   morning briefing, which is the single source of truth for the day. Two
    //   pings 30 minutes apart, each holding half the picture, was clutter. The
    //   job itself still works; enable this row if you want it back standalone.
    // stale_task_nudge: Sunday 19:00 — start of the Israeli work week, and a
    //   sane moment to prune. Also self-silences.
    // guest_nutrition_checkin: 18:00 daily — silent unless she still has a large
    //   unused calorie allowance (threshold in config.guest.eveningNudgeThreshold).
    // guest_nutrition_report: 21:00 daily — her Hebrew end-of-day summary. Both
    //   deliver to the GUEST number, not the owner's (see GUEST_JOBS in the
    //   scheduler), and are skipped entirely when GUEST_WHATSAPP_TARGET is unset.
    const extras: [string, number, number, string, number][] = [
        ['weekly_recap', 20, 30, '6', 1],
        ['monthly_finance_review', 21, 0, 'daily', 1],
        ['deadline_watch', 7, 30, 'daily', 0],
        ['stale_task_nudge', 19, 0, '0', 1],
        ['guest_nutrition_checkin', 18, 0, 'daily', 1],
        ['guest_nutrition_report', 21, 0, 'daily', 1],
    ];
    const tx = db.transaction(() => {
        for (const [job, h, m, days, enabled] of extras) ensure.run(job, h, m, days, enabled, job);
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

/** Today's date in the configured timezone, as YYYY-MM-DD. */
export function todayStr(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
}

/** YYYY-MM-DD `days` from today (negative for the past), in the configured tz. */
export function dateOffsetStr(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('sv-SE', { timeZone: config.timezone });
}

/**
 * The lifecycle of a task. `status` ('Pending'/'Completed') stays the coarse
 * authority — every legacy query and the dashboard read it — and `state` refines
 * what "Pending" means:
 *
 *   inbox        captured, not yet scheduled. The backlog. Not overdue, ever.
 *   planned      has a planned_date (and/or a deadline) in the future.
 *   rolled_over  was planned for an earlier day and didn't get done. STILL ACTIVE,
 *                not a failure — the queue rolls it forward instead of alarming.
 *   waiting      blocked on someone else. Excluded from planning and slot-filling.
 *   done         mirrors status='Completed'.
 */
export type TaskState = 'inbox' | 'planned' | 'rolled_over' | 'waiting' | 'done';

/** A task that has rolled this many times is chronically avoided, not merely late. */
export const CHRONIC_ROLLOVER_THRESHOLD = 3;

export interface TaskFields {
    /** Soft, self-assigned execution date. Rolls forward. Never causes "overdue". */
    plannedDate?: string | null;
    /** Hard external deadline. The ONLY thing that can make a task overdue. */
    deadline?: string | null;
    estimatedMinutes?: number | null;
    taskKind?: string | null;
    state?: TaskState;
    waitingOn?: string | null;
    projectId?: number | null;
    notes?: string | null;
    /** @deprecated legacy alias for `plannedDate`, kept so old callers compile. */
    dueDate?: string | null;
}

export interface TaskRow {
    id: string;
    date: string;
    title: string;
    status: string;
    priority: string;
    planned_date: string | null;
    deadline: string | null;
    state: TaskState;
    task_kind: string | null;
    waiting_on: string | null;
    rollover_count: number;
    last_rescheduled_at: string | null;
    estimated_minutes: number | null;
    project_id: number | null;
    notes: string | null;
    project_name?: string | null;
    project_target_date?: string | null;
    /** Legacy mirror of COALESCE(deadline, planned_date). Do not branch on it. */
    due_date: string | null;
}

/** The columns every task read projects. One place to edit. */
const TASK_COLUMNS = `
    t.id, t.date, t.title, t.status, t.priority,
    t.planned_date, t.deadline, t.state, t.task_kind, t.waiting_on,
    COALESCE(t.rollover_count, 0) AS rollover_count, t.last_rescheduled_at,
    t.estimated_minutes, t.project_id, t.notes, t.due_date`;

/** Resolve `dueDate` (legacy) onto `plannedDate` without clobbering an explicit one. */
function normalizeFields(fields: TaskFields): TaskFields {
    if (fields.dueDate !== undefined && fields.plannedDate === undefined) {
        return { ...fields, plannedDate: fields.dueDate };
    }
    return fields;
}

export function addTask(title: string, priority: string = 'medium', fieldsIn: TaskFields = {}): { id: string; title: string } {
    const fields = normalizeFields(fieldsIn);
    const id = getNextTaskId();
    const plannedDate = fields.plannedDate ?? null;
    const deadline = fields.deadline ?? null;
    // A task is 'planned' the moment it has any date attached; otherwise it lands
    // in the inbox, which is a legitimate resting place, not a backlog of shame.
    const state: TaskState = fields.state ?? ((plannedDate || deadline) ? 'planned' : 'inbox');

    db.prepare(
        `INSERT INTO tasks (id, date, title, status, priority, planned_date, deadline, due_date,
                            state, task_kind, waiting_on, rollover_count,
                            estimated_minutes, project_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
        id, todayStr(), title, 'Pending', priority,
        plannedDate, deadline, deadline ?? plannedDate,
        state, fields.taskKind ?? null, fields.waitingOn ?? null,
        fields.estimatedMinutes ?? null, fields.projectId ?? null, fields.notes ?? null
    );
    return { id, title };
}

/**
 * Filters, and what each one MEANS now that plan and deadline are separate:
 *
 *   overdue  — ONLY missed hard deadlines. This is the red list, and it is short.
 *   rolling  — carried over from an earlier day. Amber, not red. Not a failure.
 *   today    — planned for today or earlier, or a deadline landing today or earlier.
 *   inbox    — captured, undated. Also reachable as `someday`/`backlog` (aliases).
 *   chronic  — rolled over more than CHRONIC_ROLLOVER_THRESHOLD times: the queue
 *              flagging "you keep not doing this — cut it, shrink it, or commit".
 *   active   — everything the planner may schedule (i.e. all but `waiting`).
 */
export type TaskFilter =
    | 'all' | 'active' | 'today' | 'week' | 'overdue' | 'someday' | 'backlog'
    | 'inbox' | 'planned' | 'rolling' | 'waiting' | 'chronic';

export function getPendingTasks(filter: TaskFilter = 'all'): TaskRow[] {
    const today = todayStr();
    let where = "t.status = 'Pending'";
    const params: any[] = [];

    switch (filter) {
        case 'today':
            where += ' AND (t.planned_date <= ? OR t.deadline <= ?)';
            params.push(today, today);
            break;
        case 'week': {
            const horizon = dateOffsetStr(7);
            where += ' AND (t.planned_date <= ? OR t.deadline <= ?)';
            params.push(horizon, horizon);
            break;
        }
        case 'overdue':
            // Hard deadlines only. A rolled-over plan is NOT overdue.
            where += ' AND t.deadline IS NOT NULL AND t.deadline < ?';
            params.push(today);
            break;
        case 'someday':
        case 'backlog':
        case 'inbox':
            where += ' AND t.planned_date IS NULL AND t.deadline IS NULL';
            break;
        case 'planned':
            where += " AND t.state = 'planned'";
            break;
        case 'rolling':
            where += " AND t.state = 'rolled_over'";
            break;
        case 'waiting':
            where += " AND t.state = 'waiting'";
            break;
        case 'chronic':
            where += ' AND COALESCE(t.rollover_count, 0) >= ?';
            params.push(CHRONIC_ROLLOVER_THRESHOLD);
            break;
        case 'active':
            where += " AND COALESCE(t.state, 'inbox') <> 'waiting'";
            break;
        case 'all':
        default:
            break;
    }

    // Ordering: real deadlines first (soonest), then planned dates, then priority.
    // NULLs sort last in both date groups — an undated task is never more urgent
    // than a dated one.
    return db.prepare(
        `SELECT ${TASK_COLUMNS}, p.name AS project_name, p.target_date AS project_target_date
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE ${where}
         ORDER BY (t.deadline IS NULL), t.deadline ASC,
                  (t.planned_date IS NULL), t.planned_date ASC,
                  CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                  CAST(SUBSTR(t.id, 2) AS INTEGER)`
    ).all(...params) as TaskRow[];
}

/** One task by resolved id, with its project joined. */
export function getTask(taskId: string): TaskRow | null {
    const id = resolveTaskId(taskId);
    if (!id) return null;
    return db.prepare(
        `SELECT ${TASK_COLUMNS}, p.name AS project_name, p.target_date AS project_target_date
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`
    ).get(id) as TaskRow;
}

/**
 * Resolve a user-supplied "T3" / partial-title string to a real task id.
 * complete/delete each rolled their own version of this; update and snooze made
 * it four, so it's shared now. Pending-only, matching the previous behaviour.
 */
export function resolveTaskId(taskId: string): string | null {
    const search = String(taskId || '').toLowerCase();
    if (!search) return null;

    const byId = db.prepare("SELECT id FROM tasks WHERE LOWER(id) = ? AND status = 'Pending'").get(search) as { id: string } | undefined;
    if (byId) return byId.id;

    const byTitle = db.prepare("SELECT id FROM tasks WHERE LOWER(title) LIKE ? AND status = 'Pending' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) LIMIT 1").get(`%${search}%`) as { id: string } | undefined;
    return byTitle ? byTitle.id : null;
}

/** Patch any subset of a task's editable fields. Returns the resolved id. */
export function updateTask(
    taskId: string,
    patchIn: { title?: string; priority?: string; rolloverCount?: number } & TaskFields
): string | null {
    const id = resolveTaskId(taskId);
    if (!id) return null;
    const patch = normalizeFields(patchIn) as typeof patchIn;

    const sets: string[] = [];
    const params: any[] = [];
    const push = (col: string, val: any) => { sets.push(`${col} = ?`); params.push(val); };

    if (patch.title !== undefined) push('title', patch.title);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.estimatedMinutes !== undefined) push('estimated_minutes', patch.estimatedMinutes);
    if (patch.projectId !== undefined) push('project_id', patch.projectId);
    if (patch.notes !== undefined) push('notes', patch.notes);
    if (patch.taskKind !== undefined) push('task_kind', patch.taskKind);
    if (patch.waitingOn !== undefined) push('waiting_on', patch.waitingOn);
    if (patch.rolloverCount !== undefined) push('rollover_count', patch.rolloverCount);

    const datesTouched = patch.plannedDate !== undefined || patch.deadline !== undefined;
    if (patch.plannedDate !== undefined) push('planned_date', patch.plannedDate);
    if (patch.deadline !== undefined) push('deadline', patch.deadline);

    // Explicit state wins; otherwise moving a date re-plans the task, which also
    // clears the "rolled over" flag — the user just made a fresh commitment, and
    // carrying the amber flag forward would keep punishing them for it.
    if (patch.state !== undefined) {
        push('state', patch.state);
    } else if (datesTouched) {
        const cur = db.prepare('SELECT planned_date, deadline, state FROM tasks WHERE id = ?')
            .get(id) as { planned_date: string | null; deadline: string | null; state: string | null };
        const nextPlanned = patch.plannedDate !== undefined ? patch.plannedDate : cur.planned_date;
        const nextDeadline = patch.deadline !== undefined ? patch.deadline : cur.deadline;
        if (cur.state !== 'waiting') push('state', (nextPlanned || nextDeadline) ? 'planned' : 'inbox');
    }

    if (datesTouched) {
        push('last_rescheduled_at', new Date().toISOString());
        // Keep the legacy mirror in step with whatever the row now holds.
        sets.push('due_date = COALESCE(?, ?)');
        const cur = db.prepare('SELECT planned_date, deadline FROM tasks WHERE id = ?')
            .get(id) as { planned_date: string | null; deadline: string | null };
        params.push(
            patch.deadline !== undefined ? patch.deadline : cur.deadline,
            patch.plannedDate !== undefined ? patch.plannedDate : cur.planned_date
        );
    }

    if (!sets.length) return id;   // nothing to change, but the task exists
    params.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return id;
}

/**
 * Count of pending tasks that have MISSED A REAL DEADLINE. Deliberately no longer
 * counts self-assigned plans that slipped — that number was ~everything, so it
 * stopped carrying information.
 */
export function getOverdueCount(): number {
    const row = db.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status = 'Pending' AND deadline IS NOT NULL AND deadline < ?"
    ).get(todayStr()) as { n: number };
    return row.n;
}

/** Pending tasks untouched for `days` and with no date at all — candidates to drop. */
export function getStaleTasks(days: number = 21): TaskRow[] {
    return db.prepare(
        `SELECT ${TASK_COLUMNS}, p.name AS project_name, p.target_date AS project_target_date
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'Pending' AND t.planned_date IS NULL AND t.deadline IS NULL AND t.date <= ?
         ORDER BY t.date ASC`
    ).all(dateOffsetStr(-days)) as TaskRow[];
}

/**
 * THE ROLLOVER. Every pending task whose planned day has passed moves to today,
 * gains a rollover, and is marked `rolled_over`.
 *
 * This is what turns a calendar-bound list into a queue: nothing is ever "late"
 * for a date the user chose themselves, it is simply still in line. Hard
 * deadlines are untouched — `deadline` is never rewritten here, so a genuinely
 * missed deadline still shows up red tomorrow.
 *
 * `waiting` tasks are skipped: they aren't waiting on the user, so rolling them
 * would inflate rollover_count and mislabel them as chronically avoided.
 *
 * Idempotent by construction — after it runs, no pending task has a
 * planned_date < today, so a second call the same day is a no-op.
 */
export function rollOverTasks(today: string = todayStr()): { rolled: number; ids: string[] } {
    const due = db.prepare(
        `SELECT id FROM tasks
         WHERE status = 'Pending' AND planned_date IS NOT NULL AND planned_date < ?
           AND COALESCE(state, 'inbox') <> 'waiting'`
    ).all(today) as { id: string }[];
    if (!due.length) return { rolled: 0, ids: [] };

    const now = new Date().toISOString();
    const stmt = db.prepare(
        `UPDATE tasks
            SET planned_date = ?,
                due_date = COALESCE(deadline, ?),
                state = 'rolled_over',
                rollover_count = COALESCE(rollover_count, 0) + 1,
                last_rescheduled_at = ?
          WHERE id = ?`
    );
    db.transaction(() => { for (const r of due) stmt.run(today, today, now, r.id); })();
    return { rolled: due.length, ids: due.map(r => r.id) };
}

/**
 * Run the rollover at most once per day, cheaply.
 *
 * Called from every entry point that reads the queue (list / plan_day /
 * suggest) as well as the 07:00 scheduler tick, so the queue is correct no
 * matter which one the user hits first — including on a Mac that was asleep and
 * missed the scheduler entirely. The settings guard keeps the repeated calls
 * free; correctness doesn't depend on it, only cost does.
 */
export function ensureDailyRollover(): { rolled: number; ran: boolean } {
    const today = todayStr();
    if (getSetting('last_rollover_date') === today) return { rolled: 0, ran: false };
    const { rolled } = rollOverTasks(today);
    setSetting('last_rollover_date', today);
    return { rolled, ran: true };
}

export function completeTask(taskId: string): boolean {
    const search = taskId.toLowerCase();
    const now = new Date().toISOString();

    // `state` is kept in step with `status` so the lifecycle view never disagrees
    // with the coarse Pending/Completed flag every legacy reader still uses.
    // Try exact ID match first
    let stmt = db.prepare("UPDATE tasks SET status = 'Completed', state = 'done', completed_at = ? WHERE LOWER(id) = ? AND status = 'Pending'");
    let info = stmt.run(now, search);
    if (info.changes > 0) return true;

    // Fallback: partial title match
    stmt = db.prepare("UPDATE tasks SET status = 'Completed', state = 'done', completed_at = ? WHERE LOWER(title) LIKE ? AND status = 'Pending'");
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
    const today = todayStr();
    const habit = db.prepare('SELECT id FROM habits WHERE name = ?').get(name) as { id: number } | undefined;
    if (!habit) return false;

    // Write both: `last_logged_date` keeps every existing reader working, and the
    // habit_logs row is what makes streaks computable.
    const tx = db.transaction(() => {
        db.prepare('UPDATE habits SET last_logged_date = ? WHERE id = ?').run(today, habit.id);
        db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, date) VALUES (?, ?)').run(habit.id, today);
    });
    tx();
    return true;
}

export function getHabits(): { name: string; frequency: string; last_logged_date: string | null }[] {
    const stmt = db.prepare('SELECT name, frequency, last_logged_date FROM habits');
    return stmt.all() as any[];
}

/**
 * Current consecutive-day streak for a habit.
 *
 * Counts back from today, and tolerates "not logged yet today" by starting at
 * yesterday — otherwise every streak would read as 0 for most of the day and the
 * evening review would look like it had just been broken.
 * Daily habits only; weekly/monthly ones return the raw log count instead, since
 * "consecutive days" isn't meaningful for them.
 */
export function getHabitStreak(habitId: number, frequency: string = 'daily'): number {
    const dates = (db.prepare(
        'SELECT date FROM habit_logs WHERE habit_id = ? ORDER BY date DESC LIMIT 400'
    ).all(habitId) as { date: string }[]).map(r => r.date);

    if (!dates.length) return 0;
    if (frequency !== 'daily') return dates.length;

    const have = new Set(dates);
    // Anchor on today if logged, else yesterday (today may simply not have happened yet).
    let cursor = have.has(todayStr()) ? 0 : (have.has(dateOffsetStr(-1)) ? -1 : null);
    if (cursor === null) return 0;

    let streak = 0;
    while (have.has(dateOffsetStr(cursor))) { streak++; cursor--; }
    return streak;
}

/** Habits with today's completion state and current streak — for reviews/briefings. */
export function getHabitsWithStreaks(): {
    id: number; name: string; frequency: string; last_logged_date: string | null;
    done_today: boolean; streak: number;
}[] {
    const rows = db.prepare('SELECT id, name, frequency, last_logged_date FROM habits').all() as
        { id: number; name: string; frequency: string; last_logged_date: string | null }[];
    const today = todayStr();
    return rows.map(h => ({
        ...h,
        done_today: h.last_logged_date === today,
        streak: getHabitStreak(h.id, h.frequency),
    }));
}

// ═══════════════════════════════════════════════════════════════════
//  PROJECTS ("missions") — a named objective that owns tasks
// ═══════════════════════════════════════════════════════════════════

export interface ProjectRow {
    id: number;
    name: string;
    description: string | null;
    target_date: string | null;
    status: string;
    total: number;
    done: number;
    days_left: number | null;
}

export function addProject(name: string, targetDate?: string | null, description?: string | null): { id: number; name: string } {
    const info = db.prepare(
        'INSERT INTO projects (name, target_date, description) VALUES (?, ?, ?)'
    ).run(name, targetDate ?? null, description ?? null);
    return { id: Number(info.lastInsertRowid), name };
}

/** Resolve "3" / partial-name to a project id. Mirrors resolveTaskId's behaviour. */
export function resolveProjectId(ref: string | number): number | null {
    if (typeof ref === 'number' && Number.isFinite(ref)) {
        const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(ref) as { id: number } | undefined;
        return row ? row.id : null;
    }
    const s = String(ref || '').trim().toLowerCase();
    if (!s) return null;

    if (/^\d+$/.test(s)) {
        const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(s)) as { id: number } | undefined;
        if (row) return row.id;
    }
    const row = db.prepare("SELECT id FROM projects WHERE LOWER(name) LIKE ? ORDER BY (status = 'active') DESC, id DESC LIMIT 1")
        .get(`%${s}%`) as { id: number } | undefined;
    return row ? row.id : null;
}

/**
 * Projects with task-derived progress. `total`/`done` are computed from the
 * linked tasks on every read rather than stored, so progress can't drift out of
 * sync when a task is completed or deleted by another code path.
 */
export function getProjects(includeCompleted: boolean = false): ProjectRow[] {
    const rows = db.prepare(
        `SELECT p.id, p.name, p.description, p.target_date, p.status,
                COUNT(t.id) AS total,
                SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS done
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         ${includeCompleted ? '' : "WHERE p.status = 'active'"}
         GROUP BY p.id
         ORDER BY (p.target_date IS NULL), p.target_date ASC, p.id ASC`
    ).all() as any[];

    const today = todayStr();
    return rows.map(r => ({
        ...r,
        done: Number(r.done || 0),
        total: Number(r.total || 0),
        days_left: r.target_date
            ? Math.round((new Date(r.target_date + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000)
            : null,
    }));
}

export function completeProject(ref: string | number): boolean {
    const id = resolveProjectId(ref);
    if (id === null) return false;
    db.prepare("UPDATE projects SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return true;
}

/** Delete a project. Its tasks survive, orphaned back to "no project". */
export function deleteProject(ref: string | number): boolean {
    const id = resolveProjectId(ref);
    if (id === null) return false;
    const tx = db.transaction(() => {
        db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    tx();
    return true;
}

/** Projects with a target date inside `days`, still having unfinished tasks. */
export function getUpcomingProjectDeadlines(days: number = 7): ProjectRow[] {
    const horizon = dateOffsetStr(days);
    const today = todayStr();
    return getProjects(false).filter(p =>
        p.target_date !== null && p.target_date <= horizon && p.done < p.total ||
        (p.target_date !== null && p.target_date < today && p.total === 0)
    );
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

// The whatsapp_media TABLE is intentionally kept (services/dashboard.ts still
// counts rows, and services/whatsapp-listener.ts writes it if ever re-enabled),
// but the read helper is gone with the list_whatsapp_media tool it served.

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
