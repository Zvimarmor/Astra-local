import { getCalendarClient } from './google-auth';
import { config } from './config';
import { getPendingTasks, todayStr, type TaskRow } from './storage';

/**
 * Day planner — fit today's tasks into the gaps between calendar events.
 *
 * This is the payoff for `estimate_minutes` on tasks: without a duration there is
 * nothing to pack, so tasks lacking an estimate get a default and are flagged as
 * guesses rather than silently treated as accurate.
 *
 * Times are handled as local wall-clock minutes-from-midnight in the configured
 * timezone, and written back as naive ISO strings paired with `timeZone` — the
 * same approach `add_calendar_event` already uses. Doing arithmetic on UTC
 * instants would make DST days subtly wrong.
 */

const TIMEZONE = config.timezone;

/** Default block length for a task with no estimate. */
const DEFAULT_ESTIMATE_MIN = 45;
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
 * Greedy first-fit packing, tasks in the order getPendingTasks already returns
 * them (overdue and due-soon first, then priority). Deliberately not an
 * optimiser: a plan the user can predict beats a marginally tighter one, and
 * "most urgent thing first" is the ordering they'd expect.
 */
function packTasks(slots: Slot[], tasks: TaskRow[]): { blocks: Block[]; unplaced: TaskRow[] } {
    const cursors = slots.map(s => s.start);
    const blocks: Block[] = [];
    const unplaced: TaskRow[] = [];

    for (const task of tasks) {
        const estimated = !task.estimate_minutes;
        const need = task.estimate_minutes || DEFAULT_ESTIMATE_MIN;

        let placed = false;
        for (let i = 0; i < slots.length; i++) {
            if (cursors[i] + need <= slots[i].end) {
                blocks.push({ start: cursors[i], end: cursors[i] + need, task, estimated });
                cursors[i] += need + BREAK_MIN;
                placed = true;
                break;
            }
        }
        if (!placed) unplaced.push(task);
    }

    blocks.sort((a, b) => a.start - b.start);
    return { blocks, unplaced };
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
            "Build a time-blocked plan for a day: reads the pending tasks and the Google Calendar, " +
            "then fits tasks into the gaps between existing events. " +
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
                    description: "'due' (default) = only tasks due by this date; 'all' = also pull in undated tasks to fill the day",
                },
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

                // Candidate tasks: due by this date, optionally topped up with undated ones.
                const due = getPendingTasks('all').filter(t => t.due_date !== null && t.due_date <= date);
                const candidates = (args.include === 'all')
                    ? [...due, ...getPendingTasks('someday')]
                    : due;

                if (!candidates.length) {
                    return {
                        status: 'success',
                        message: args.include === 'all'
                            ? `Nothing pending to schedule for ${date}.`
                            : `No tasks due by ${date}. Try include="all" to fill the day with undated tasks.`,
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

                const { blocks, unplaced } = packTasks(slots, candidates);

                const lines: string[] = [`🗓 Plan for ${date}`];
                if (allDay.length) lines.push(`   (all day: ${allDay.join(', ')})`);
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
                        lines.push(`   ${hhmm(b.start)}–${hhmm(b.end)}  ${b.task.id} ${b.task.title}${flag}`);
                    }
                }

                if (unplaced.length) {
                    lines.push('', `⏭ Didn't fit (${unplaced.length}):`);
                    for (const t of unplaced.slice(0, 8)) lines.push(`   ${t.id} ${t.title}`);
                    if (unplaced.length > 8) lines.push(`   …and ${unplaced.length - 8} more`);
                }

                if (blocks.some(b => b.estimated)) {
                    lines.push('', `~est = no time estimate, assumed ${DEFAULT_ESTIMATE_MIN} min.`);
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
                                },
                            });
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
                    unplaced: unplaced.length,
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
