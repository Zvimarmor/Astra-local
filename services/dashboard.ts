/**
 * Astra Health Check Dashboard — Standalone HTTP Server
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  SECURITY:                                                       │
 * │  - Binds to 127.0.0.1 ONLY (localhost) — no external access     │
 * │  - Token-based auth via ?token= query parameter                  │
 * │  - Read-only: only reads from SQLite, never writes               │
 * │  - No dependencies beyond Node.js built-ins + better-sqlite3     │
 * │                                                                   │
 * │  REMOTE ACCESS via SSH tunnel:                                    │
 * │  ssh -L 3001:localhost:3001 username@mac-mini-ip                 │
 * │  Then open: http://localhost:3001?token=YOUR_TOKEN               │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Run: node dist-services/dashboard.js
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import os from 'os';

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────

const PORT = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
const TOKEN = process.env.DASHBOARD_TOKEN || '';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'memory.db');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Jerusalem';
// Gemini replaced the local Ollama endpoint (2026-08-06).
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();

// Dashboard HTML file path (relative to project root)
const HTML_PATH = path.join(__dirname, '..', 'services', 'dashboard.html');
// Fallback: try from the services directory directly
const HTML_PATH_ALT = path.join(__dirname, 'dashboard.html');

let db: Database.Database | null = null;
try {
    if (fs.existsSync(DB_PATH)) {
        db = new Database(DB_PATH, { readonly: true });
        console.log(`[Dashboard] Connected to DB: ${DB_PATH}`);
    }
} catch (err: any) {
    console.error(`[Dashboard] Failed to open DB: ${err.message}`);
}

// ─── Auth Middleware ─────────────────────────────────────────────────

function authenticate(url: string): boolean {
    if (!TOKEN) {
        console.warn('[Dashboard] ⚠ No DASHBOARD_TOKEN set — dashboard is unprotected!');
        return true; // Allow if no token configured (dev mode)
    }
    const params = new URL(url, 'http://localhost').searchParams;
    return params.get('token') === TOKEN;
}

// ─── Data Collection ─────────────────────────────────────────────────

function getSystemInfo() {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version.replace('v', ''),
        uptime: Math.floor(os.uptime()),
        memoryTotalMB: Math.round(os.totalmem() / 1024 / 1024),
        memoryUsedMB: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        memoryFreePercent: Math.round((os.freemem() / os.totalmem()) * 100),
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg().map(l => Math.round(l * 100) / 100),
    };
}

async function getGeminiInfo() {
    if (!GEMINI_API_KEY) {
        return { connected: false, model: GEMINI_MODEL, error: 'GEMINI_API_KEY not set' };
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        // ListModels is free and consumes no generation quota.
        const res = await fetch(`${GEMINI_BASE}/models`, {
            headers: { 'x-goog-api-key': GEMINI_API_KEY },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) return { connected: false, model: GEMINI_MODEL, error: `HTTP ${res.status}` };

        const data = await res.json() as any;
        const ids: string[] = (data.models || []).map((m: any) => String(m.name).replace('models/', ''));

        return {
            connected: true,
            model: GEMINI_MODEL,
            modelAvailable: ids.includes(GEMINI_MODEL),
            modelCount: ids.length,
        };
    } catch (err: any) {
        return { connected: false, model: GEMINI_MODEL, error: err.message };
    }
}

function getDatabaseInfo() {
    try {
        if (!db) {
            return { connected: false, error: 'Database not connected' };
        }

        const today = new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });

        // Tasks
        const pendingTasks = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'Pending'").get() as any)?.c || 0;
        const completedTasks = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'Completed'").get() as any)?.c || 0;
        const highPriTasks = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'Pending' AND priority = 'high'").get() as any)?.c || 0;

        // Recurring tasks
        let recurringCount = 0;
        try {
            recurringCount = (db.prepare("SELECT COUNT(*) as c FROM recurring_tasks WHERE active = 1").get() as any)?.c || 0;
        } catch { /* table may not exist */ }

        // Habits
        const totalHabits = (db.prepare("SELECT COUNT(*) as c FROM habits").get() as any)?.c || 0;
        const completedToday = (db.prepare("SELECT COUNT(*) as c FROM habits WHERE last_logged_date = ?").get(today) as any)?.c || 0;

        // Expenses (this month)
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
        const monthExpenses = (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?").get(monthStart) as any)?.total || 0;
        const expenseCount = (db.prepare("SELECT COUNT(*) as c FROM expenses WHERE date >= ?").get(monthStart) as any)?.c || 0;

        // Media
        const totalMedia = (db.prepare("SELECT COUNT(*) as c FROM whatsapp_media").get() as any)?.c || 0;
        const imageCount = (db.prepare("SELECT COUNT(*) as c FROM whatsapp_media WHERE media_type = 'image'").get() as any)?.c || 0;

        // Messages
        const totalMessages = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any)?.c || 0;

        return {
            connected: true,
            tasks: { pending: pendingTasks, completed: completedTasks, highPriority: highPriTasks, recurring: recurringCount },
            habits: { total: totalHabits, completedToday },
            expenses: { monthTotal: Math.round(monthExpenses), monthCount: expenseCount },
            media: { total: totalMedia, images: imageCount },
            messages: { total: totalMessages },
        };
    } catch (err: any) {
        return { connected: false, error: err.message };
    }
}

function getFinancialInfo() {
    try {
        if (!db) return {};

        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

        const totalExpenses = (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?").get(monthStart) as any)?.total || 0;

        let totalIncome = 0;
        try {
            totalIncome = (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM income WHERE date >= ?").get(monthStart) as any)?.total || 0;
        } catch { /* table may not exist */ }

        return {
            totalIncome: Math.round(totalIncome),
            totalExpenses: Math.round(totalExpenses),
        };
    } catch {
        return {};
    }
}

function getBudgetInfo() {
    try {
        if (!db) return [];

        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

        let budgets: any[] = [];
        try {
            budgets = db.prepare('SELECT category, monthly_limit FROM budgets ORDER BY category').all() as any[];
        } catch {
            return []; // table doesn't exist
        }

        const result = budgets.map((b: any) => {
            const spent = (db!.prepare(
                'SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE LOWER(category) = ? AND date >= ?'
            ).get(b.category, monthStart) as any)?.total || 0;

            const percent = b.monthly_limit > 0 ? Math.round((spent / b.monthly_limit) * 100) : 0;
            let alert: string = 'ok';
            if (percent >= 100) alert = 'over';
            else if (percent >= 80) alert = 'warning';

            return { category: b.category, spent: Math.round(spent), limit: Math.round(b.monthly_limit), percent, alert };
        });

        return result;
    } catch {
        return [];
    }
}

// ─── HTTP Server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // ─── API: Status Data ────────────────────────────────
    if (url.startsWith('/api/status')) {
        if (!authenticate(url)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        const [system, gemini, database, financial, budgets] = await Promise.all([
            getSystemInfo(),
            getGeminiInfo(),
            getDatabaseInfo(),
            getFinancialInfo(),
            getBudgetInfo(),
        ]);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ system, gemini, database, financial, budgets, timestamp: new Date().toISOString() }));
        return;
    }

    // ─── Dashboard HTML ──────────────────────────────────
    if (url === '/' || url.startsWith('/?')) {
        if (!authenticate(url)) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized - Missing or invalid ?token= parameter');
            return;
        }

        let htmlFile = HTML_PATH;
        if (!fs.existsSync(htmlFile)) {
            htmlFile = HTML_PATH_ALT;
        }
        if (!fs.existsSync(htmlFile)) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Dashboard HTML file not found. Run from the project root directory.');
            return;
        }

        const html = fs.readFileSync(htmlFile, 'utf-8');
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
    }

    // ─── 404 ─────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

// ─── Start ───────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Astra Health Check Dashboard                   ║');
    console.log(`║  http://127.0.0.1:${PORT}                          ║`);
    console.log('║  🔒 Localhost only — use SSH tunnel for remote  ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`[Dashboard] DB: ${DB_PATH}`);
    console.log(`[Dashboard] Token: ${TOKEN ? '✓ configured' : '⚠ NOT SET (unprotected!)'}`);
    console.log(`[Dashboard] Remote access: ssh -L ${PORT}:localhost:${PORT} user@mac-mini-ip`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Dashboard] Port ${PORT} is already in use. Change DASHBOARD_PORT in .env.`);
    } else {
        console.error('[Dashboard] Server error:', err.message);
    }
    if (db) db.close();
    process.exit(1);
});

// Graceful shutdown
function shutdown() {
    console.log('\n[Dashboard] Shutting down...');
    if (db) db.close();
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
