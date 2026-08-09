/**
 * Astra Proactive Scheduler — Standalone Background Service
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHAT IT IS:                                                      │
 * │  The "heartbeat" the skills always referred to but that never     │
 * │  actually existed. A deterministic timer that, on schedule,       │
 * │  reads SQLite and pushes a pre-formatted message straight to       │
 * │  WhatsApp via the OpenClaw gateway (`openclaw message send`).       │
 * │                                                                    │
 * │  ⛔ NO LLM in the loop — it cannot hallucinate "I sent it".       │
 * │  ⛔ Runs even if the model API is down or rate-limited.           │
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
// music_alarm re-enabled 2026-08-06 (spotifyd brought back up).
const { spotifyTools } = require(path.join(DIST, 'spotify.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendWhatsAppText } = require(path.join(DIST, 'whatsapp-send.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCalendarClient } = require(path.join(DIST, 'google-auth.js'));
// Channel watchdog: probe WhatsApp (primary) health, alert out of band if down.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkWhatsAppHealth } = require(path.join(DIST, 'channel-health.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendOutOfBandAlert } = require(path.join(DIST, 'alert.js'));
// Guest (non-owner) nutrition tracking — its own store, its own delivery target.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionStore = require(path.join(DIST, 'nutrition-store.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GUEST_USER } = require(path.join(DIST, 'nutrition.js'));

const TZ: string = config.timezone;
const WA_TARGET: string = config.whatsapp.ownerTarget;
const GUEST_TARGET: string = config.guest.whatsappTarget;

/**
 * Jobs whose message belongs to the GUEST, not the owner.
 *
 * Two things follow from being on this list, and both matter:
 *  1. delivery goes to config.guest.whatsappTarget — never to the owner. There
 *     is no out-of-band fallback: her data must not land in the owner's alert
 *     email or Telegram just because a WhatsApp send failed.
 *  2. the Shabbat quiet window is the OWNER's preference, so by default it does
 *     not gate her messages (config.guest.bypassShabbat). Night quiet still
 *     applies to everyone — nobody wants a 03:00 calorie report.
 */
const GUEST_JOBS = new Set(['guest_nutrition_report', 'guest_nutrition_checkin']);
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
    // Music alarms must NOT play late: tight 3-min window, then skip (user policy).
    if (s.job === 'music_alarm') return nowMin - schedMin <= 3;
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

// ─── WhatsApp send (via OpenClaw gateway CLI) ─────────────────────────
// WhatsApp has no bot HTTP API, so we push through `openclaw message send`
// (see dist/whatsapp-send.js), reusing the single linked WhatsApp session.

async function sendWhatsApp(text: string): Promise<boolean> {
    if (!WA_TARGET) {
        console.error('[Scheduler] ⚠ WHATSAPP_OWNER_TARGET not set — cannot send.');
        return false;
    }
    return sendWhatsAppText(text);
}

// ─── Owner notification with fallback ─────────────────────────────────
// Every proactive message used to go out over WhatsApp ONLY — if that send
// failed (or a job threw before producing a message at all), the failure was
// recorded in SQLite and nowhere else, so the owner never found out. This
// wraps every owner-facing notification (briefings, alerts, and now job
// failures too) with the same out-of-band fallback the channel watchdog uses:
// WhatsApp first, then Telegram + email if that didn't land.

/** Send `text` to the owner; fall back to Telegram+email if WhatsApp fails. */
async function notifyOwner(subject: string, text: string): Promise<{ via: string; delivered: boolean }> {
    if (await sendWhatsApp(text)) return { via: 'whatsapp', delivered: true };

    console.warn(`[Scheduler] WhatsApp send failed for "${subject}" — falling back to out-of-band alert.`);
    const res = await sendOutOfBandAlert(subject, text);
    const carriers = [res.telegram ? 'telegram' : null, res.email ? 'email' : null].filter(Boolean).join('+');
    return { via: carriers || 'none', delivered: res.delivered };
}

/**
 * Send to the guest. Deliberately NOT notifyOwner: no Telegram/email fallback,
 * because those carriers are the owner's and her calorie report must never be
 * re-routed to him. A failed send is logged and recorded, nothing more.
 */
async function notifyGuest(job: string, text: string): Promise<{ via: string; delivered: boolean }> {
    if (!GUEST_TARGET) {
        console.warn(`[Scheduler] ${job}: GUEST_WHATSAPP_TARGET not set — skipping.`);
        return { via: 'none', delivered: false };
    }
    const ok = await sendWhatsAppText(text, GUEST_TARGET);
    if (!ok) console.error(`[Scheduler] ${job}: WhatsApp send to guest failed.`);
    return { via: ok ? 'whatsapp(guest)' : 'none', delivered: ok };
}

// ─── Analytical jobs are now FULLY deterministic (2026-07-06) ─────────
// The weekly recap & monthly finance review used to pass their SQLite-built
// draft through a qwen3 "reword it warmly" call. That call shares Ollama's
// single KV slot with the interactive gateway, so it EVICTED the cached system-
// prompt prefix — making the user's next chat a ~35s cold-prefill turn. The
// phrasing was cosmetic (numbers always came from SQLite, and any LLM failure
// already fell back to the exact draft), so we dropped it entirely: the draft
// IS the message now. This removes a recurring, self-inflicted chat slowdown.
// To RE-ENABLE warmer phrasing without the cache hit, give Ollama a second slot
// (OLLAMA_NUM_PARALLEL≥2) and restore phraseWithLLM from git history.

// ─── Deterministic message builders (reuse storage content fns) ───────

const NIS = (n: number) => `${Math.round(n)} NIS`;

/** Fetch a compact list of the given day's Google Calendar events. Never throws — returns [] on any failure. */
async function getDayEvents(dateStr: string): Promise<Array<{ title: string; start: string; all_day: boolean }>> {
    try {
        const calendar = getCalendarClient();
        const timeMin = new Date(`${dateStr}T00:00:00`).toISOString();
        const timeMax = new Date(`${dateStr}T23:59:59`).toISOString();
        const res = await calendar.events.list({
            calendarId: config.calendarId,
            timeMin, timeMax, timeZone: TZ,
            maxResults: 20, singleEvents: true, orderBy: 'startTime',
        });
        return (res.data.items || []).map((e: any) => ({
            title: e.summary || '(no title)',
            start: e.start?.dateTime || e.start?.date || '',
            all_day: Boolean(e.start?.date && !e.start?.dateTime),
        }));
    } catch (err: any) {
        console.error('[Scheduler] Calendar fetch failed:', err.message);
        return [];
    }
}

function formatEventTime(iso: string, allDay: boolean): string {
    if (allDay) return 'All day';
    return new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

async function buildMorningBriefing(dateStr: string): Promise<string> {
    const status = { pending_tasks: storage.getPendingTasks(), uncompleted_habits: [] as any[] };
    const habits = storage.getHabits().filter((h: any) => h.last_logged_date !== dateStr);
    const fin = storage.getFinancialOverview('month');
    const alerts = storage.checkBudgetAlerts().filter((a: any) => a.alert !== 'ok');

    const lines: string[] = [`☀️ Good morning! Daily Summary — ${dateStr}`, ''];

    const events = await getDayEvents(dateStr);
    lines.push(`📅 Today's Agenda (${events.length}):`);
    if (events.length === 0) lines.push('  Nothing on the calendar today.');
    else events.forEach(e => lines.push(`  • ${formatEventTime(e.start, e.all_day)} — ${e.title}`));

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

async function buildEveningReview(dateStr: string): Promise<string> {
    const today = storage.getExpenseSummary('week'); // weekly bucket; today's slice below
    const week = today.total;
    const fin = storage.getFinancialOverview('month');
    const tasks = storage.getPendingTasks();
    const recurringCount = storage.getActiveRecurringTasks().length;

    const tomorrow = new Date(`${dateStr}T12:00:00`);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: TZ });
    const events = await getDayEvents(tomorrowStr);

    const lines: string[] = [`🌙 Good evening! Evening Summary — ${dateStr}`, ''];
    lines.push(`📅 Tomorrow's Agenda (${events.length}):`);
    if (events.length === 0) lines.push('  Nothing on the calendar yet.');
    else events.forEach(e => lines.push(`  • ${formatEventTime(e.start, e.all_day)} — ${e.title}`));

    lines.push('', `📊 This week's expenses: ${NIS(week)}`);
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

    // Habit streaks. Only shown when there are habits at all, so this stays silent
    // rather than printing an empty section for users who don't track any.
    const habitsWithStreaks = storage.getHabitsWithStreaks();
    if (habitsWithStreaks.length > 0) {
        lines.push('', '🔥 Habits:');
        for (const h of habitsWithStreaks) {
            const mark = h.done_today ? '✅' : '⬜';
            const streak = h.streak > 1 ? ` — ${h.streak}-day streak` : (h.streak === 1 ? ' — day 1' : '');
            lines.push(`  ${mark} ${h.name}${streak}`);
        }
    }

    lines.push('', 'Good night! 😴');
    return lines.join('\n');
}

function rank(priority: string): number {
    return ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[priority] ?? 1;
}

/**
 * Deadline watch — what's overdue or due today/soon.
 *
 * Silent when there is nothing to report (returns null), so it only ever
 * interrupts when a deadline actually needs attention. Fully deterministic:
 * built straight from SQLite with no model in the path, which also means it
 * costs no Gemini quota and can't be rate-limited.
 */
function buildDeadlineWatch(dateStr: string): string | null {
    const overdue = storage.getPendingTasks('overdue');
    const dueToday = storage.getPendingTasks('today').filter((t: any) => t.due_date === dateStr);
    const projects = storage.getUpcomingProjectDeadlines(7);

    if (!overdue.length && !dueToday.length && !projects.length) return null;

    const lines: string[] = [`⏰ Deadlines — ${dateStr}`, ''];

    if (overdue.length) {
        lines.push(`🔴 Overdue (${overdue.length}):`);
        for (const t of overdue.slice(0, 10)) lines.push(`  • ${t.id} ${t.title} (was due ${t.due_date})`);
        if (overdue.length > 10) lines.push(`  …and ${overdue.length - 10} more`);
        lines.push('');
    }
    if (dueToday.length) {
        lines.push(`📌 Due today (${dueToday.length}):`);
        for (const t of dueToday) {
            const est = t.estimate_minutes ? ` ~${t.estimate_minutes}m` : '';
            lines.push(`  • ${t.id} ${t.title}${est}`);
        }
        lines.push('');
    }
    if (projects.length) {
        lines.push('🎯 Projects closing in:');
        for (const p of projects) {
            const left = p.days_left === null ? '' :
                p.days_left < 0 ? ` — ${Math.abs(p.days_left)}d overdue` :
                p.days_left === 0 ? ' — due today' : ` — ${p.days_left}d left`;
            lines.push(`  • ${p.name} (${p.done}/${p.total} done)${left}`);
        }
    }
    return lines.join('\n').trim();
}

/**
 * Stale-task nudge — undated tasks that have been pending a long time.
 * Weekly, and silent when there's nothing stale. The point is to force a
 * decision (schedule it or drop it) rather than let the list rot.
 */
function buildStaleTaskNudge(): string | null {
    const stale = storage.getStaleTasks(21);
    if (!stale.length) return null;

    const lines: string[] = [`🧹 ${stale.length} task${stale.length === 1 ? '' : 's'} sitting with no deadline for 3+ weeks:`, ''];
    for (const t of stale.slice(0, 10)) lines.push(`  • ${t.id} ${t.title} (added ${t.date})`);
    if (stale.length > 10) lines.push(`  …and ${stale.length - 10} more`);
    lines.push('', 'Worth giving these a date or dropping them?');
    return lines.join('\n');
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

    return lines.join('\n'); // deterministic: the SQLite-built draft IS the message
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

    return lines.join('\n'); // deterministic: the SQLite-built draft IS the message
}

// ─── Job dispatch. Returns { status, message } ────────────────────────

async function runJob(s: any, n: LocalNow): Promise<{ status: string; message: string | null }> {
    switch (s.job) {
        case 'recurring_gen': {
            const count = storage.generateDueRecurringTasks();
            return { status: count > 0 ? 'sent' : 'skipped_empty', message: count > 0 ? `🔄 Generated ${count} recurring task${count === 1 ? '' : 's'} for today.` : null };
        }
        case 'morning_briefing':
            return { status: 'sent', message: await buildMorningBriefing(n.dateStr) };
        case 'evening_review':
            return { status: 'sent', message: await buildEveningReview(n.dateStr) };
        case 'deadline_watch': {
            const msg = buildDeadlineWatch(n.dateStr);
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        case 'stale_task_nudge': {
            const msg = buildStaleTaskNudge();
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        case 'budget_check': {
            const msg = buildBudgetAlert();
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        case 'email_digest': {
            const msg = await buildEmailDigest();
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        // RE-ENABLED 2026-08-06 alongside the manage_music chat tool: spotifyd is
        // back up (it had only been stopped, never uninstalled). Without this case
        // `manage_music(action="set_alarm")` would write an alarm row that never
        // fires, so the two have to be enabled together.
        case 'music_alarm': {
            // payload carries {query,type}; play it via the compiled spotify tool.
            let p: any = {};
            try { p = JSON.parse(s.payload || '{}'); } catch { }
            if (!p.query) return { status: 'error', message: '⚠️ Music alarm has no query.' };
            const res = await spotifyTools.spotify_play.execute({ query: p.query, type: p.type || 'track' });
            if (res && res.status === 'success') {
                return { status: 'sent', message: `⏰🎵 Alarm: ${res.message}` };
            }
            return { status: 'error', message: `⚠️ Music alarm failed: ${(res && res.error) || 'unknown error'}` };
        }
        // ─── Guest nutrition (delivered to the guest, see GUEST_JOBS) ────
        // Both builders read SQLite and format Hebrew directly — no LLM, so the
        // report cannot hallucinate a number she did not log, and it still goes
        // out when the Gemini free-tier quota is exhausted.
        case 'guest_nutrition_report': {
            const msg = nutritionStore.buildDailyReportHe(GUEST_USER, n.dateStr);
            // null ⇒ she has not onboarded yet; stay silent rather than nag.
            return { status: msg ? 'sent' : 'skipped_empty', message: msg };
        }
        case 'guest_nutrition_checkin': {
            // Self-silencing: returns null unless she still has a large unused
            // allowance at 18:00 (config.guest.eveningNudgeThreshold).
            const msg = nutritionStore.buildEveningNudgeHe(GUEST_USER, config.guest.eveningNudgeThreshold);
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

// ─── Channel watchdog ─────────────────────────────────────────────────
// Catches the failure mode that silently killed the primary channel for 17 days
// (2026-07-19 → 2026-08-05): WhatsApp Web unlinked itself, OpenClaw wiped its
// stored creds, and the gateway health-monitor looped "restarting (reason:
// stopped)" every 10 minutes with nobody watching. Every proactive message in
// that window was lost. WhatsApp cannot report its own death, so the alert has
// to leave by a different road: Telegram Bot API + SMTP email (tools/alert.ts).
//
// Alerting is EDGE-TRIGGERED, and the edge lives in SQLite (settings table) —
// NOT in a module variable. That matters: the scheduler restarts (launchd,
// reboots, redeploys), and in-memory state would re-fire an alert on every
// restart. Persisted, an outage of any length yields exactly one alert.

const WD_ENABLED: boolean = config.scheduler.watchdogEnabled;
const WD_PROBE_MS: number = config.scheduler.watchdogProbeMinutes * 60 * 1000;
const WD_FAILURES: number = config.scheduler.watchdogFailuresBeforeAlert;
const WD_REMINDER_MS: number = config.scheduler.watchdogReminderHours * 60 * 60 * 1000;
// If an alert reaches NO carrier we leave the state alone so it retries, but we
// don't retry on every probe — that would hammer a broken SMTP server.
const WD_RETRY_MS = 30 * 60 * 1000;

// settings keys (SQLite `settings` table via storage.getSetting/setSetting)
const K_STATE = 'watchdog.whatsapp.state';           // 'ok' | 'down'
const K_STREAK = 'watchdog.whatsapp.fail_streak';    // consecutive failed probes
const K_FIRST_FAIL = 'watchdog.whatsapp.first_fail_at';  // ms epoch, start of outage
const K_LAST_ALERT = 'watchdog.whatsapp.last_alert_at';  // ms epoch, last DELIVERED alert
const K_LAST_TRY = 'watchdog.whatsapp.last_attempt_at';  // ms epoch, last alert ATTEMPT

const num = (key: string): number => parseInt(storage.getSetting(key, '0'), 10) || 0;

let lastProbeAt = 0; // in-memory: probe cadence only — safe to lose on restart

function humanDuration(ms: number): string {
    if (ms <= 0) return 'just now';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

/** Attempt an out-of-band alert; record the attempt either way. Never throws. */
async function tryAlert(subject: string, body: string): Promise<boolean> {
    storage.setSetting(K_LAST_TRY, String(Date.now()));
    try {
        const res = await sendOutOfBandAlert(subject, body);
        const carriers = [res.telegram ? 'telegram' : null, res.email ? 'email' : null]
            .filter(Boolean).join('+') || 'none';
        console.log(`[Watchdog] alert "${subject}" → delivered via: ${carriers}`);
        if (res.delivered) storage.setSetting(K_LAST_ALERT, String(Date.now()));
        return res.delivered;
    } catch (err: any) {
        // sendOutOfBandAlert is already no-throw; this is pure belt & braces so a
        // watchdog fault can never take the scheduler's main loop down with it.
        console.error('[Watchdog] alert error —', String(err?.message || err).slice(0, 200));
        return false;
    }
}

async function runWatchdog(): Promise<void> {
    const now = Date.now();
    if (now - lastProbeAt < WD_PROBE_MS) return;
    lastProbeAt = now;

    const h = await checkWhatsAppHealth();
    const state = storage.getSetting(K_STATE, 'ok');

    // ── Healthy ────────────────────────────────────────────────────────
    if (h.ok) {
        storage.setSetting(K_STREAK, '0');
        storage.setSetting(K_FIRST_FAIL, '0');
        if (state === 'down') {
            // Recovery is the other edge — one message, and it closes the incident
            // even if delivery fails (we must not get stuck re-announcing recovery).
            const downMs = now - (num(K_LAST_ALERT) || now);
            storage.setSetting(K_STATE, 'ok');
            await tryAlert(
                '✅ Astra: WhatsApp is back',
                `Astra's WhatsApp channel is linked and running again.\n\n` +
                `Was down for roughly ${humanDuration(downMs)}.\n` +
                `Proactive briefings resume on the normal schedule.`,
            );
        }
        return;
    }

    // ── Unhealthy ──────────────────────────────────────────────────────
    const streak = num(K_STREAK) + 1;
    storage.setSetting(K_STREAK, String(streak));
    if (streak === 1) storage.setSetting(K_FIRST_FAIL, String(now));

    const detail = h.probeError
        ? `probe failed: ${h.probeError}`
        : `state=${h.statusState} linked=${h.linked} connected=${h.connected} health=${h.healthState}${h.lastError ? ` lastError=${h.lastError}` : ''}`;
    console.warn(`[Watchdog] WhatsApp unhealthy (${streak}/${WD_FAILURES}) — ${detail}`);

    if (streak < WD_FAILURES) return; // debounce: ride out gateway restarts

    const downSince = num(K_FIRST_FAIL) || now;
    const downFor = humanDuration(now - downSince);

    // Already alerted for this outage → stay quiet unless reminders are enabled.
    if (state === 'down') {
        if (WD_REMINDER_MS <= 0) return;
        if (now - num(K_LAST_ALERT) < WD_REMINDER_MS) return;
        await tryAlert(
            '⚠️ Astra: WhatsApp still down',
            `Astra's WhatsApp channel is STILL down (${downFor}).\n\n${detail}\n\n` +
            `Re-link on the Mac Mini:\n  openclaw channels login --channel whatsapp --account default`,
        );
        return;
    }

    // First confirmed outage. If nothing delivered, leave state 'ok' so we retry
    // — but not before WD_RETRY_MS, so a broken carrier isn't hammered.
    if (now - num(K_LAST_TRY) < WD_RETRY_MS && num(K_LAST_TRY) > 0) return;

    const delivered = await tryAlert(
        '⚠️ Astra: WhatsApp channel is DOWN',
        `Astra can't reach you on WhatsApp — proactive briefings are NOT being delivered.\n\n` +
        `Down for: ${downFor} (first failed probe ${new Date(downSince).toLocaleString('en-GB', { timeZone: TZ })})\n` +
        `Details: ${detail}\n\n` +
        `Fix — on the Mac Mini, run and scan the QR:\n` +
        `  openclaw channels login --channel whatsapp --account default\n\n` +
        `Verify with:\n  openclaw channels status --json\n\n` +
        `You will NOT get another email about this outage; the next one comes only ` +
        `when WhatsApp recovers.`,
    );
    if (delivered) {
        storage.setSetting(K_STATE, 'down');
        console.error(`[Watchdog] 🔴 WhatsApp DOWN for ${downFor} — alert sent, going quiet until recovery.`);
    } else {
        console.error('[Watchdog] 🔴 WhatsApp DOWN but NO alert carrier worked — will retry in 30m.');
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

            // Quiet-hours policy by job:
            //  - recurring_gen: runs (mutates DB) but stays silent.
            //  - music_alarm: ALWAYS fires + notifies, even at night/Shabbat (user policy).
            //  - everything else: skipped during quiet.
            //  - guest_*: night quiet applies, but Shabbat quiet is the OWNER's
            //    preference and does not gate her messages (config.guest.bypassShabbat).
            const quiet = inQuietHours(n);
            const isGuestJob = GUEST_JOBS.has(s.job);
            const bypassesQuiet = s.job === 'recurring_gen' || s.job === 'music_alarm'
                || (isGuestJob && quiet.reason === 'shabbat' && config.guest.bypassShabbat);
            if (quiet.quiet && !bypassesQuiet) {
                storage.updateScheduleRun(s.id, n.dateStr, 'skipped_quiet', quiet.reason);
                console.log(`[Scheduler] ${s.job}: skipped (quiet: ${quiet.reason})`);
                continue;
            }

            try {
                const { status, message } = await runJob(s, n);
                let finalStatus = status;
                let via = '';
                // recurring_gen is the only job that suppresses its notification during quiet.
                const suppressNotify = quiet.quiet && s.job === 'recurring_gen';
                if (message && !suppressNotify) {
                    const result = isGuestJob
                        ? await notifyGuest(s.job, message)
                        : await notifyOwner(`Astra: ${s.job}`, message);
                    finalStatus = result.delivered ? 'sent' : 'error';
                    via = result.via;
                } else if (message && suppressNotify) {
                    finalStatus = 'skipped_quiet';
                }
                storage.updateScheduleRun(s.id, n.dateStr, finalStatus, quiet.quiet ? quiet.reason : null);
                console.log(`[Scheduler] ${s.job}: ${finalStatus}${via ? ` (via ${via})` : ''}`);
            } catch (err: any) {
                storage.updateScheduleRun(s.id, n.dateStr, 'error', err.message);
                console.error(`[Scheduler] ${s.job}: error —`, err.message);
                // A crashed job used to be silent — recorded in SQLite only, never
                // surfaced to the owner. Notify (with the same WhatsApp→OOB
                // fallback) so a broken job is never discovered by its absence.
                await notifyOwner(
                    `⚠️ Astra: ${s.job} failed`,
                    `Scheduled job "${s.job}" failed to run.\n\nError: ${err.message}`,
                );
            }
        }

        // Watchdog last: a diagnostic probe must never delay a due briefing, and
        // its own failure must never abort the tick that carries them.
        if (WD_ENABLED) {
            try {
                await runWatchdog();
            } catch (err: any) {
                console.error('[Watchdog] unexpected error —', String(err?.message || err).slice(0, 200));
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
console.log(`[Scheduler] WhatsApp: ${WA_TARGET ? 'target set' : 'NO TARGET'} → ${WA_TARGET || 'NOT SET'}`);
const sList = storage.getSchedules();
console.log(`[Scheduler] ${sList.length} schedule(s): ${sList.map((s: any) => `${s.job}@${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`).join(', ')}`);
console.log(
    WD_ENABLED
        ? `[Watchdog] enabled | probe ${config.scheduler.watchdogProbeMinutes}m | alert after ${WD_FAILURES} failures | ` +
          `reminders ${WD_REMINDER_MS > 0 ? `every ${config.scheduler.watchdogReminderHours}h` : 'off (one alert per outage)'} | ` +
          `carriers: telegram=${config.telegram.botToken && config.telegram.ownerChatId ? 'ready' : 'NOT SET'}, ` +
          `email=${config.alertEmail && (config.smtp.password || config.imapAccounts.personal.password) ? 'ready' : 'NOT SET'}`
        : '[Watchdog] disabled (SCHEDULER_WATCHDOG=false)',
);

void tick();
setInterval(() => { void tick(); }, TICK_MS);
