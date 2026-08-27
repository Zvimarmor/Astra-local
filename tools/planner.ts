import { getCalendarClient } from './google-auth';
import { config } from './config';
import { getPendingTasks, updateTask, todayStr, ensureDailyRollover, type TaskRow } from './storage';
import { rankTasks, usableCapacity, CAPACITY_FACTOR, type SizedTask } from './task-queue';

/**
 * Day planner — fit the rolling queue into the gaps between calendar events,
 * up to a realistic fraction of the free time available.
 *
 * TWO THINGS MAKE THIS DIFFERENT FROM "PACK THE DAY FULL"
 *
 * 1. CAPACITY. Only ~70% of free time is offered to tasks (CAPACITY_FACTOR).
 *    Packing to 100% produces a plan that is already wrong by mid-morning, and
 *    every task it displaces rolls over — the planner would be manufacturing the
 *    backlog it exists to drain. The buffer is the plan's shock absorber.
 *
 * 2. RANKING, not arrival order. Candidates are scored by task-queue.ts (deadline
 *    urgency, priority, project relevance, and how many times they've already
 *    rolled), so the same "what matters next" answer comes out of plan_day, the
 *    free-slot suggester and the briefings.
 *
 * Durations come from the task's estimate, or from the title heuristics when it
 * has none — flagged `~est` so a bad guess is visible and correctable.
 *
 * Times are handled as local wall-clock minutes-from-midnight in the configured
 * timezone, and written back as naive ISO strings paired with `timeZone` — the
 * same approach `add_calendar_event` already uses. Doing arithmetic on UTC
 * instants would make DST days subtly wrong.
 */

const TIMEZONE = config.timezone;

/** Gap left between consecutive blocks. */
const BREAK_MIN = 10;
/** Ignore slivers of free time this short. */
const MIN_USEFUL_SLOT_MIN = 20;

interface Busy { start: number; end: number; title: string }
interface Slot { start: number; end: number }
interface Block { start: number; end: number; task: TaskRow; estimated: boolean }

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** "HH:MM" from minutes-from-midnight. */
function hhmm(mins: number): string {
    return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

/** Parse "HH:MM" (or "H") to minutes-from-midnight; null if unparseable. */
function parseHHMM(v: any, fallback: number): number {
    if (v === undefined || v === null || v === '') return fallback;
    const m = String(v).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return fallback;
    const h = Math.min(23, parseInt(m[1], 10));
    const mi = Math.min(59, parseInt(m[2] || '0', 10));
    return h * 60 + mi;
}

/** Minutes-from-midnight of an instant, as seen in the configured timezone. */
function localMinutesOf(iso: string): number {
    const t = new Date(iso).toLocaleTimeString('en-GB', {
        timeZone: TIMEZONE, hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

/** Local date (YYYY-MM-DD) of an instant, in the configured timezone. */
function localDateOf(iso: string): string {
    return new Date(iso).toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

/** Merge overlapping busy intervals so slot maths stays simple. */
function mergeBusy(busy: Busy[]): Busy[] {
    const sorted = [...busy].sort((a, b) => a.start - b.start);
    const out: Busy[] = [];
    for (const b of sorted) {
        const last = out[out.length - 1];
        if (last && b.start <= last.end) {
            last.end = Math.max(last.end, b.end);
            if (!last.title.includes(b.title)) last.title += ` + ${b.title}`;
        } else {
            out.push({ ...b });
        }
    }
    return out;
}

function freeSlots(dayStart: number, dayEnd: number, busy: Busy[]): Slot[] {
    const slots: Slot[] = [];
    let cursor = dayStart;
    for (const b of busy) {
        if (b.end <= dayStart || b.start >= dayEnd) continue;
        const s = Math.max(dayStart, b.start);
        if (s - cursor >= MIN_USEFUL_SLOT_MIN) slots.push({ start: cursor, end: s });
        cursor = Math.max(cursor, Math.min(dayEnd, b.end));
    }
    if (dayEnd - cursor >= MIN_USEFUL_SLOT_MIN) slots.push({ start: cursor, end: dayEnd });
    return slots;
}

/**
 * Greedy first-fit packing over ranked, pre-sized tasks, stopping at `capacity`.
 *
 * Deliberately not an optimiser: a plan the user can predict beats a marginally
 * tighter one, and "most important thing first, in the first gap it fits" is the
 * ordering they'd expect. The capacity ceiling is checked BEFORE the geometric
 * fit, so a day with eight free hours still only gets ~5.6h of commitments even
 * though the gaps could physically hold more.
 *
 * `deferred` and `overCapacity` are reported separately because they mean
 * different things to the user: "no gap was the right shape" is a scheduling
 * problem, "you're out of realistic hours" is a workload problem.
 */
function packTasks(slots: Slot[], ranked: SizedTask[], capacity: number): {
    blocks: Block[]; deferred: SizedTask[]; overCapacity: SizedTask[]; usedMinutes: number;
} {
    const cursors = slots.map(s => s.start);
    const blocks: Block[] = [];
    const deferred: SizedTask[] = [];
    const overCapacity: SizedTask[] = [];
    let used = 0;

    for (const item of ranked) {
        if (used + item.minutes > capacity) { overCapacity.push(item); continue; }

        let placed = false;
        for (let i = 0; i < slots.length; i++) {
            if (cursors[i] + item.minutes <= slots[i].end) {
                blocks.push({ start: cursors[i], end: cursors[i] + item.minutes, task: item.task, estimated: item.guessed });
                cursors[i] += item.minutes + BREAK_MIN;
                used += item.minutes;
                placed = true;
                break;
            }
        }
        if (!placed) deferred.push(item);
    }

    blocks.sort((a, b) => a.start - b.start);
    return { blocks, deferred, overCapacity, usedMinutes: used };
}

async function fetchDayEvents(dateStr: string): Promise<{ busy: Busy[]; allDay: string[] }> {
    const calendar = getCalendarClient();
    const res = await calendar.events.list({
        calendarId: config.calendarId,
        // Widen by a day either side and filter by local date, so events near
        // midnight land on the right day regardless of UTC offset.
        timeMin: new Date(`${dateStr}T00:00:00Z`).toISOString(),
        timeMax: new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 48 * 3600 * 1000).toISOString(),
        timeZone: TIMEZONE,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
    });

    const busy: Busy[] = [];
    const allDay: string[] = [];

    for (const e of res.data.items || []) {
        const title = e.summary || '(untitled)';
        const isAllDay = Boolean(e.start?.date && !e.start?.dateTime);

        if (isAllDay) {
            if (e.start?.date === dateStr) allDay.push(title);
            continue;   // all-day items (holidays, birthdays) don't block hours
        }
        const s = e.start?.dateTime;
        const en = e.end?.dateTime;
        if (!s || !en) continue;
        if (localDateOf(s) !== dateStr) continue;

        busy.push({ start: localMinutesOf(s), end: localMinutesOf(en), title });
    }
    return { busy: mergeBusy(busy), allDay };
}

export const plannerTools = {
    plan_day: {
        name: 'plan_day',
        description:
            "Build a capacity-aware time-blocked plan for a day: reads the rolling task queue and the " +
            "Google Calendar, finds the free windows between events, and fills only ~70% of them with the " +
            "highest-ranked tasks that fit — leaving slack so the plan survives a normal day. " +
            "Set write_to_calendar=true to actually create the blocks as calendar events.",
        parameters: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Day to plan as YYYY-MM-DD (default today)' },
                day_start: { type: 'string', description: 'Earliest working time, "HH:MM" (default 09:00)' },
                day_end: { type: 'string', description: 'Latest working time, "HH:MM" (default 21:00)' },
                include: {
                    type: 'string',
                    enum: ['due', 'all'],
                    description: "'due' (default) = tasks planned for this day, rolled over, or with a deadline by then; 'all' = also pull from the inbox to fill the day",
                },
                capacity_pct: { type: 'number', description: 'Percent of free time to commit (default 70). Raise it for a clear day you intend to grind through.' },
                write_to_calendar: { type: 'boolean', description: 'Create the blocks as real calendar events (default false — propose only)' },
            },
        },
        execute: async (args: any = {}) => {
            try {
                const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? String(args.date) : todayStr();
                const dayStart = parseHHMM(args.day_start, 9 * 60);
                const dayEnd = parseHHMM(args.day_end, 21 * 60);
                if (dayEnd - dayStart < MIN_USEFUL_SLOT_MIN) {
                    return { status: 'error', error: `day_end (${hhmm(dayEnd)}) must be at least ${MIN_USEFUL_SLOT_MIN} min after day_start (${hhmm(dayStart)}).` };
                }

                // Planning today is also the moment to bring yesterday's leftovers
                // forward — otherwise the plan would be built against a stale queue.
                if (date === todayStr()) ensureDailyRollover();

                const factor = Number.isFinite(Number(args.capacity_pct))
                    ? Math.min(100, Math.max(10, Number(args.capacity_pct))) / 100
                    : CAPACITY_FACTOR;

                // Candidates: what this day is actually for — anything planned for it
                // or earlier (rollovers included), plus anything with a deadline by
                // then. `waiting` tasks are excluded upstream by rankTasks().
                const active = getPendingTasks('active');
                const committed = active.filter(t =>
                    (t.planned_date !== null && t.planned_date <= date) ||
                    (t.deadline !== null && t.deadline <= date)
                );
                const committedIds = new Set(committed.map(t => t.id));
                const candidates = (args.include === 'all')
                    ? [...committed, ...active.filter(t => !committedIds.has(t.id))]
                    : committed;

                if (!candidates.length) {
                    return {
                        status: 'success',
                        message: args.include === 'all'
                            ? `Nothing pending to schedule for ${date}.`
                            : `Nothing planned or due by ${date}. Try include="all" to pull from the backlog.`,
                    };
                }

                const { busy, allDay } = await fetchDayEvents(date);
                const slots = freeSlots(dayStart, dayEnd, busy);
                if (!slots.length) {
                    return {
                        status: 'success',
                        message: `${date} is fully booked between ${hhmm(dayStart)} and ${hhmm(dayEnd)} — no room to schedule anything.`,
                    };
                }

                const freeMinutes = slots.reduce((n, s) => n + (s.end - s.start), 0);
                const capacity = usableCapacity(freeMinutes, factor);
                const ranked = rankTasks(candidates, date);
                const { blocks, deferred, overCapacity, usedMinutes } = packTasks(slots, ranked, capacity);

                const lines: string[] = [`🗓 Plan for ${date}`];
                if (allDay.length) lines.push(`   (all day: ${allDay.join(', ')})`);
                lines.push(
                    `   ${Math.round(freeMinutes / 6) / 10}h free · planning to ${Math.round(factor * 100)}% ` +
                    `= ${Math.round(capacity / 6) / 10}h · committing ${Math.round(usedMinutes / 6) / 10}h`
                );
                lines.push('');

                if (busy.length) {
                    lines.push('📌 Already booked:');
                    for (const b of busy) lines.push(`   ${hhmm(b.start)}–${hhmm(b.end)}  ${b.title}`);
                    lines.push('');
                }

                if (!blocks.length) {
                    lines.push('No task fits the free gaps — they are all shorter than the tasks need.');
                } else {
                    lines.push('✅ Proposed blocks:');
                    for (const b of blocks) {
                        const flag = b.estimated ? ' ~est' : '';
                        const rolled = (b.task.rollover_count || 0) > 0 ? ` 🔁${b.task.rollover_count}` : '';
                        lines.push(`   ${hhmm(b.start)}–${hhmm(b.end)}  ${b.task.id} ${b.task.title}${flag}${rolled}`);
                    }
                }

                // Two different messages, because they call for two different responses.
                if (overCapacity.length) {
                    lines.push('', `🧯 Left out to keep the day realistic (${overCapacity.length}):`);
                    for (const r of overCapacity.slice(0, 8)) lines.push(`   ${r.task.id} ${r.task.title} (~${r.minutes}m)`);
                    if (overCapacity.length > 8) lines.push(`   …and ${overCapacity.length - 8} more`);
                    lines.push('   These roll forward automatically — nothing is lost.');
                }
                if (deferred.length) {
                    lines.push('', `⏭ No gap the right shape (${deferred.length}):`);
                    for (const r of deferred.slice(0, 5)) lines.push(`   ${r.task.id} ${r.task.title} (~${r.minutes}m)`);
                    if (deferred.length > 5) lines.push(`   …and ${deferred.length - 5} more`);
                }

                if (blocks.some(b => b.estimated)) {
                    lines.push('', '~est = duration inferred from the task title, not set by you. Correct any that look wrong.');
                }

                // ── optionally write the blocks to the calendar ──
                let written = 0;
                const writeErrors: string[] = [];
                if (args.write_to_calendar && blocks.length) {
                    const calendar = getCalendarClient();
                    for (const b of blocks) {
                        try {
                            await calendar.events.insert({
                                calendarId: config.calendarId,
                                requestBody: {
                                    summary: `${b.task.id} ${b.task.title}`,
                                    description: 'Scheduled by Astra plan_day',
                                    start: { dateTime: `${date}T${hhmm(b.start)}:00`, timeZone: TIMEZONE },
                                    end: { dateTime: `${date}T${hhmm(b.end)}:00`, timeZone: TIMEZONE },
                                    colorId: '3', // Grape — focused work block
                                },
                            });
                            // Committing a block to the calendar IS the commitment,
                            // so the queue is updated to match. Without this the task
                            // still looks unplanned, and tomorrow's rollover would
                            // count a day the user actually blocked out as a slip.
                            updateTask(b.task.id, { plannedDate: date, state: 'planned' });
                            written++;
                        } catch (e: any) {
                            writeErrors.push(`${b.task.id}: ${e.message}`);
                        }
                    }
                    lines.push('', `📅 Wrote ${written}/${blocks.length} block(s) to the calendar.`);
                    if (writeErrors.length) lines.push(`⚠️ Failed: ${writeErrors.join('; ')}`);
                } else if (blocks.length) {
                    lines.push('', 'Proposal only — say the word to write these to your calendar.');
                }

                return {
                    status: 'success',
                    planned: blocks.length,
                    free_minutes: freeMinutes,
                    capacity_minutes: capacity,
                    committed_minutes: usedMinutes,
                    deferred: deferred.length,
                    over_capacity: overCapacity.length,
                    written,
                    message: lines.join('\n'),
                };
            } catch (err: any) {
                console.error('[Planner] Error planning day:', err.message);
                return { status: 'error', error: err.message };
            }
        },
    },
};
