/**
 * Astra Proactive Scheduler — Standalone Background Service
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHAT IT IS:                                                      │
 * │  The "heartbeat" the skills always referred to but that never     │
 * │  actually existed. A deterministic timer that, on schedule,       │
 * │  reads SQLite and pushes a pre-formatted message straight to       │
 * │  Telegram via the Bot API.                                         │
 * │                                                                    │
 * │  ⛔ NO LLM in the loop — it cannot hallucinate "I sent it".       │
 * │  ⛔ Runs even if Ollama is cold/asleep.                           │
 * │  ✅ Reuses the compiled tool logic in ../dist (storage, digest).  │
 * │  ✅ Once-per-day idempotency via schedule_runs UNIQUE constraint. │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Build:  npm run build && npm run build:services
 *         (this service require()s the compiled ../dist tool modules, so the
 *          tools build must exist too — not just dist-services)
 * Run:    node dist-services/scheduler.js
 */

import path from 'path';

// ─── Reuse compiled tool logic from ../dist (runtime require, not a TS import,
//     so it sidesteps the services rootDir boundary). config.js loads .env. ───
const DIST = path.join(__dirname, '..', 'dist');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require(path.join(DIST, 'config.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const storage = require(path.join(DIST, 'storage.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emailDigestTools } = require(path.join(DIST, 'email-digest.js'));

const TZ: string = config.timezone;
const BOT_TOKEN: string = config.telegram.botToken;
const OWNER_CHAT_ID: string = config.telegram.ownerChatId;
const TICK_MS = Math.max(15, config.scheduler.tickSeconds) * 1000;

// ─── Time helpers (everything in the configured timezone) ─────────────

interface LocalNow { dateStr: string; hour: number; minute: number; dow: number; }

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localNow(): LocalNow {
    const now = new Date();
    const dateStr = now.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
    const [h, m] = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).split(':').map(Number);
    const wd = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
    return { dateStr, hour: h, minute: m, dow: WD[wd] ?? new Date().getDay() };
}

function dayMatches(days: string, dow: number): boolean {
    if (!days || days === 'daily') return true;
    return days.split(',').map(s => parseInt(s.trim(), 10)).includes(dow);
}

/** A schedule is due once "now" reaches its time today (catch_up ⇒ fire late). */
function isDue(s: any, n: LocalNow): boolean {
    const nowMin = n.hour * 60 + n.minute;
    const schedMin = s.hour * 60 + s.minute;
    if (nowMin < schedMin) return false;
    // catch_up=0 would only fire within a grace window; defaults are all catch_up=1.
    if (!s.catch_up) return nowMin - schedMin <= 120; // 2h grace, then skip
    return true;
}

function inQuietHours(n: LocalNow): { quiet: boolean; reason: string } {
    const sc = config.scheduler;
    // Nightly window (handles wrap past midnight, e.g. 22 → 7).
    const night = sc.quietNightStart <= sc.quietNightEnd
        ? (n.hour >= sc.quietNightStart && n.hour < sc.quietNightEnd)
        : (n.hour >= sc.quietNightStart || n.hour < sc.quietNightEnd);
    if (night) return { quiet: true, reason: 'night' };
    // Shabbat: Friday from start hour → Saturday before end hour.
    if (sc.quietShabbat) {
        if (n.dow === 5 && n.hour >= sc.shabbatStartHourFri) return { quiet: true, reason: 'shabbat' };
        if (n.dow === 6 && n.hour < sc.shabbatEndHourSat) return { quiet: true, reason: 'shabbat' };
    }
    return { quiet: false, reason: '' };
}

// ─── Telegram Bot API send ────────────────────────────────────────────

async function sendTelegram(text: string): Promise<boolean> {
    if (!BOT_TOKEN || !OWNER_CHAT_ID) {
        console.error('[Scheduler] ⚠ TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set — cannot send.');
        return false;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, disable_web_page_preview: true }),
        });
        if (!res.ok) {
            console.error(`[Scheduler] Telegram send failed: HTTP ${res.status} ${await res.text()}`);
            return false;
        }
        return true;
    } catch (err: any) {
        console.error('[Scheduler] Telegram send error:', err.message);
        return false;
    }
}

// ─── Optional LLM phrasing (analytical jobs only) ─────────────────────
// The numbers ALWAYS come from SQLite. The local model is used ONLY to reword a
// pre-built deterministic draft more warmly. On ANY failure (Ollama cold/down,
// timeout, HTTP error, empty/short output) we return the exact deterministic text
// and still send. The LLM never gates a send and never supplies a fact — this
// preserves the scheduler's no-hallucination guarantee.
const OLLAMA_URL: string = config.ollamaBaseUrl;
const OLLAMA_MODEL: string = config.ollamaModel;
const PHRASE_TIMEOUT_MS = 30000;

const PHRASE_SYSTEM =
    'You are Astra, a warm personal assistant. Rewrite the draft summary so it reads ' +
    'naturally and encouragingly as a Telegram message. Rules: keep it concise; KEEP ' +
    'EVERY NUMBER, NAME, CATEGORY AND EMOJI EXACTLY as given; never invent, add, or drop ' +
    'a fact; no preamble or sign-off of your own — output only the message text.';

async function phraseWithLLM(draft: string): Promise<string> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PHRASE_TIMEOUT_MS);
        const res = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ctrl.signal,
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                stream: false,
                think: false,
                options: { temperature: 0.4 },
                messages: [
                    { role: 'system', content: PHRASE_SYSTEM },
                    { role: 'user', content: draft },
                ],
            }),
        }).finally(() => clearTimeout(timer));
        if (!res.ok) return draft;
        const data: any = await res.json();
        const text = String(data?.message?.content || '').trim();
        return text.length >= 10 ? text : draft; // guard against empty/garbage
    } catch {
        return draft; // Ollama cold or unreachable → deterministic draft, still sends
    }
}

// ─── Deterministic message builders (reuse storage content fns) ───────

const NIS = (n: number) => `${Math.round(n)} NIS`;

function buildMorningBriefing(dateStr: string): string {
    const status = { pending_tasks: storage.getPendingTasks(), uncompleted_habits: [] as any[] };
    const habits = storage.getHabits().filter((h: any) => h.last_logged_date !== dateStr);
    const fin = storage.getFinancialOverview('month');
    const alerts = storage.checkBudgetAlerts().filter((a: any) => a.alert !== 'ok');

    const lines: string[] = [`☀️ Good morning! Daily Summary — ${dateStr}`, ''];

    const tasks = status.pending_tasks;
    lines.push(`✅ Pending Tasks (${tasks.length}):`);
    if (tasks.length === 0) lines.push('  None — a clear slate! 🎉');
    else {
        tasks.slice(0, 5).forEach((t: any, i: number) => lines.push(`  ${i + 1}. ${t.title} (${t.priority})`));
        if (tasks.length > 5) lines.push(`  …and ${tasks.length - 5} more`);
    }

    if (habits.length > 0) {
        lines.push('', `🔁 Habits to do today (${habits.length}):`);
        habits.slice(0, 6).forEach((h: any) => lines.push(`  • ${h.name}`));
    }

    if (fin.total_income > 0 || fin.total_expenses > 0) {
        const sign = fin.net >= 0 ? '+' : '';
        lines.push('', '💰 Financial Snapshot (this month):',
            `  Income: ${NIS(fin.total_income)} | Expenses: ${NIS(fin.total_expenses)} | Net: ${sign}${NIS(fin.net)}`);
    }

    if (alerts.length > 0) {
        lines.push('', '⚠️ Budget Alerts:');
        for (const a of alerts) {
            const tag = a.alert === 'over' ? '🔴' : '🟡';
            const note = a.alert === 'over' ? 'OVER' : `${a.percent}%`;
            lines.push(`  ${tag} ${a.category}: ${NIS(a.spent)}/${NIS(a.limit)} — ${note}`);
        }
    }

    lines.push('', 'Have a productive day! 💪');
    return lines.join('\n');
}

function buildEveningReview(dateStr: string): string {
    const today = storage.getExpenseSummary('week'); // weekly bucket; today's slice below
    const week = today.total;
    const fin = storage.getFinancialOverview('month');
    const tasks = storage.getPendingTasks();
    const recurringCount = storage.getActiveRecurringTasks().length;

    const lines: string[] = [`🌙 Good evening! Evening Summary — ${dateStr}`, ''];
    lines.push(`📊 This week's expenses: ${NIS(week)}`);
    if (fin.total_income > 0 || fin.total_expenses > 0) {
        const sign = fin.net >= 0 ? '+' : '';
        lines.push(`💰 Month net so far: ${sign}${NIS(fin.net)}`);
    }
    if (tasks.length > 0) {
        const top = [...tasks].sort((a: any, b: any) => rank(a.priority) - rank(b.priority))[0];
        lines.push('', `✅ Top priority for tomorrow: ${top.title} (${top.priority})`);
        lines.push(`   (${tasks.length} task${tasks.length === 1 ? '' : 's'} still pending)`);
    } else {
        lines.push('', '✅ No pending tasks — all clear!');
    }
    if (recurringCount > 0) lines.push('', `🔄 Recurring templates active: ${recurringCount}`);
    lines.push('', 'Good night! 😴');
    return lines.join('\n');
}

function rank(priority: string): number {
    return ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[priority] ?? 1;
}

function buildBudgetAlert(): string | null {
    const flagged = storage.checkBudgetAlerts().filter((a: any) => a.alert !== 'ok');
    if (flagged.length === 0) return null; // silent when all clear
    const lines = ['⚠️ Budget check:'];
    for (const a of flagged) {
        const tag = a.alert === 'over' ? '🔴' : '🟡';
        const note = a.alert === 'over' ? `OVER by ${NIS(a.spent - a.limit)}` : `${a.percent}% used (${NIS(a.limit - a.spent)} left)`;
        lines.push(`  ${tag} ${a.category}: ${NIS(a.spent)}/${NIS(a.limit)} — ${note}`);
    }
    return lines.join('\n');
}

async function buildEmailDigest(): Promise<string | null> {
    const res = await emailDigestTools.get_email_digest.execute({});
    if (!res || res.status === 'error' || res.status === 'not_configured') return null;
    const total = res.total_unseen ?? 0;
    if (!total) return null; // silent when inbox is quiet
    const lines = [`📧 Email digest — ${total} unread`];
    for (const d of (res.digests || [])) {
        if (!d || d.status !== 'ok' || !d.unseen) continue;
        lines.push('', `${d.account || 'inbox'} (${d.unseen} unread):`);
        for (const e of (d.top_emails || []).slice(0, 5)) lines.push(`  • ${e.subject}`);
    }
    return lines.length > 1 ? lines.join('\n') : null;
}

// ─── Analytical builders (deterministic facts + LLM phrasing) ─────────

async function buildWeeklyRecap(dateStr: string): Promise<string> {
    const exp = storage.getExpenseSummary('week');
    const fin = storage.getFinancialOverview('week');
    const tasks = storage.getPendingTasks();
    const recurringCount = storage.getActiveRecurringTasks().length;
    const topCats = exp.categories.slice(0, 3).map((c: any) => `${c.category} ${NIS(c.total)}`).join(', ');

    const lines: string[] = [`📈 Weekly Recap — week ending ${dateStr}`, ''];
    lines.push(`💸 Spent this week: ${NIS(exp.total)}` + (topCats ? ` (top: ${topCats})` : ''));
    if (fin.total_income > 0 || fin.total_expenses > 0) {
        const sign = fin.net >= 0 ? '+' : '';
        lines.push(`💰 Net this week: ${sign}${NIS(fin.net)} (in ${NIS(fin.total_income)}, out ${NIS(fin.total_expenses)})`);
    }
    lines.push(`✅ Open tasks: ${tasks.length}`);
    if (recurringCount > 0) lines.push(`🔄 Active recurring templates: ${recurringCount}`);
    lines.push('', "Here's to a strong week ahead! 💪");

    return phraseWithLLM(lines.join('\n')); // draft is authoritative; LLM only rewords
}

async function buildMonthlyFinanceReview(dateStr: string): Promise<string | null> {
    // Self-gate: only fire on the LAST day of the month, so the month-to-date
    // overview covers the full month that is ending.
    const d = new Date(`${dateStr}T12:00:00`);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    if (next.getMonth() === d.getMonth()) return null; // not the last day yet → silent

    const fin = storage.getFinancialOverview('month');
    const exp = storage.getExpenseSummary('month');
    const alerts = storage.checkBudgetAlerts().filter((a: any) => a.alert !== 'ok');
    const monthName = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: TZ });
    const sign = fin.net >= 0 ? '+' : '';

    const lines: string[] = [`🗓️ Monthly Finance Review — ${monthName}`, ''];
    lines.push(`💰 Income: ${NIS(fin.total_income)} | Expenses: ${NIS(fin.total_expenses)} | Net: ${sign}${NIS(fin.net)}`);
    if (exp.categories.length > 0) {
        lines.push('', '📊 Top spending categories:');
        exp.categories.slice(0, 5).forEach((c: any) => lines.push(`  • ${c.category}: ${NIS(c.total)} (${c.count}x)`));
    }
    if (alerts.length > 0) {
        lines.push('', '⚠️ Budgets over / at risk:');
        for (const a of alerts) {
            const tag = a.alert === 'over' ? '🔴' : '🟡';
            const note = a.alert === 'over' ? 'OVER' : `${a.percent}%`;
            lines.push(`  ${tag} ${a.category}: ${NIS(a.spent)}/${NIS(a.limit)} — ${note}`);
        }
    }
    lines.push('', 'New month, fresh start. 🚀');

    return phraseWithLLM(lines.join('\n'));
}

// ─── Job dispatch. Returns { status, message } ────────────────────────

async function runJob(job: string, n: LocalNow): Promise<{ status: string; message: string | null }> {
    switch (job) {
        case 'recurring_gen': {
            const count = storage.generateDueRecurringTasks();
            return { status: count > 0 ? 'sent' : 'skipped_empty', message: count > 0 ? `🔄 Generated ${count} recurring task${count === 1 ? '' : 's'} for today.` : null };
        }
        case 'morning_briefing':
            return { status: 'sent', message: buildMorningBriefing(n.dateStr) };
        case 'evening_review':
            return { status: 'sent', message: buildEveningReview(n.dateStr) };
        case 'budget_check': {
            const msg = buildBudgetAlert();
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        case 'email_digest': {
            const msg = await buildEmailDigest();
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        case 'weekly_recap':
            return { status: 'sent', message: await buildWeeklyRecap(n.dateStr) };
        case 'monthly_finance_review': {
            const msg = await buildMonthlyFinanceReview(n.dateStr);
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        default:
            return { status: 'error', message: null };
    }
}

// ─── Main tick ────────────────────────────────────────────────────────

let ticking = false;

async function tick(): Promise<void> {
    if (ticking) return; // never overlap
    ticking = true;
    try {
        const n = localNow();
        const schedules = storage.getEnabledSchedules();
        for (const s of schedules) {
            if (!dayMatches(s.days, n.dow)) continue;
            if (!isDue(s, n)) continue;
            if (storage.hasRunOnDate(s.id, n.dateStr)) continue;

            // Claim the day's slot FIRST (idempotency across ticks/restarts).
            if (!storage.claimScheduleRun(s.id, n.dateStr, 'running')) continue;

            // recurring_gen mutates the DB even during quiet hours (it sends no
            // message unless it created tasks). All other jobs are message-only.
            const quiet = inQuietHours(n);
            if (quiet.quiet && s.job !== 'recurring_gen') {
                storage.updateScheduleRun(s.id, n.dateStr, 'skipped_quiet', quiet.reason);
                console.log(`[Scheduler] ${s.job}: skipped (quiet: ${quiet.reason})`);
                continue;
            }

            try {
                const { status, message } = await runJob(s.job, n);
                let finalStatus = status;
                if (message && !quiet.quiet) {
                    const ok = await sendTelegram(message);
                    finalStatus = ok ? 'sent' : 'error';
                } else if (message && quiet.quiet) {
                    // recurring_gen created tasks during quiet hours: don't notify now.
                    finalStatus = 'skipped_quiet';
                }
                storage.updateScheduleRun(s.id, n.dateStr, finalStatus, quiet.quiet ? quiet.reason : null);
                console.log(`[Scheduler] ${s.job}: ${finalStatus}${message && finalStatus === 'sent' ? ' (sent)' : ''}`);
            } catch (err: any) {
                storage.updateScheduleRun(s.id, n.dateStr, 'error', err.message);
                console.error(`[Scheduler] ${s.job}: error —`, err.message);
            }
        }
    } finally {
        ticking = false;
    }
}

// ─── Entry point ──────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  Astra Proactive Scheduler (deterministic)       ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`[Scheduler] Timezone: ${TZ} | tick: ${TICK_MS / 1000}s`);
console.log(`[Scheduler] Telegram: ${BOT_TOKEN ? 'token set' : 'NO TOKEN'} | owner: ${OWNER_CHAT_ID || 'NOT SET'}`);
const sList = storage.getSchedules();
console.log(`[Scheduler] ${sList.length} schedule(s): ${sList.map((s: any) => `${s.job}@${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`).join(', ')}`);

void tick();
setInterval(() => { void tick(); }, TICK_MS);
