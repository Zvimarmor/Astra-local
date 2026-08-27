/**
 * Hebrew report formatting — shared by every proactive report the scheduler sends.
 *
 * WHY A SEPARATE MODULE:
 *   The briefing builders used to each roll their own English layout, so the
 *   morning briefing, the evening review and the weekly recap drifted apart and
 *   mixed English headers with Hebrew task titles. Everything user-facing now
 *   goes through these helpers, so a wording/emoji change lands in every report
 *   at once and the language stays 100% Hebrew.
 *
 * PURE ON PURPOSE: no SQLite, no network. It takes plain rows and returns
 * strings, so the deterministic "no LLM in the loop" property of the scheduler
 * is preserved — nothing here can fail at runtime in a way that loses a report.
 *
 * BIDI NOTE: task ids ("T7") and dates are LTR runs inside RTL text. They are
 * always placed inside parentheses at the END of a line, never at the start —
 * a line that *begins* with an LTR token renders with the bullet flipped to the
 * wrong side in WhatsApp. Keep it that way when editing.
 */

// ─── Small primitives ─────────────────────────────────────────────────

/** WhatsApp bold (single asterisks — NOT markdown's double). */
export const b = (s: string) => `*${s}*`;

export const NIS = (n: number) => `${Math.round(n)} ₪`;

/** Signed shekel amount, e.g. "+1,200 ₪" / "-340 ₪". */
export function signedNIS(n: number): string {
    return `${n >= 0 ? '+' : '-'}${NIS(Math.abs(n))}`;
}

/** Hebrew priority label. Used for GROUP HEADERS, not per-task tags. */
export const PRIORITY_HE: Record<string, string> = {
    high: 'דחוף',
    medium: 'בינוני',
    low: 'רגיל',
};

export const PRIORITY_EMOJI: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '⚪',
};

export function priorityRank(priority: string): number {
    return ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[priority] ?? 1;
}

/** "לפני 3 ימים" style suffix for an overdue date. */
export function daysBetween(fromDateStr: string, toDateStr: string): number {
    const a = new Date(`${fromDateStr}T12:00:00`).getTime();
    const z = new Date(`${toDateStr}T12:00:00`).getTime();
    return Math.round((z - a) / 86400000);
}

export function hebrewDays(n: number): string {
    if (n <= 0) return 'היום';
    if (n === 1) return 'יום אחד';
    if (n === 2) return 'יומיים';
    return `${n} ימים`;
}

/** Hebrew month + year, e.g. "אוגוסט 2026". */
export function hebrewMonth(dateStr: string, tz: string): string {
    return new Date(`${dateStr}T12:00:00`).toLocaleDateString('he-IL', {
        month: 'long', year: 'numeric', timeZone: tz,
    });
}

/** Hebrew weekday + date, e.g. "יום שלישי, 18/08/2026". */
export function hebrewDate(dateStr: string, tz: string): string {
    return new Date(`${dateStr}T12:00:00`).toLocaleDateString('he-IL', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz,
    });
}

// ─── Tasks ────────────────────────────────────────────────────────────

export interface TaskLike {
    id: string;
    title: string;
    priority: string;
    /** Hard external deadline. The ONLY thing that may be rendered red. */
    deadline?: string | null;
    /** Soft, self-assigned execution date. Rolls forward; never renders as late. */
    planned_date?: string | null;
    state?: string | null;
    rollover_count?: number | null;
    estimated_minutes?: number | null;
    project_name?: string | null;
    date?: string;
    /** @deprecated legacy mirror of COALESCE(deadline, planned_date). */
    due_date?: string | null;
    /** @deprecated legacy spelling. */
    estimate_minutes?: number | null;
}

/** A task that has rolled this many times is chronically avoided, not merely late. */
export const CHRONIC_ROLLOVER_THRESHOLD = 3;

/** "~30 דק׳" — only when an estimate exists. */
function estimateSuffix(t: TaskLike): string {
    const m = t.estimated_minutes ?? t.estimate_minutes;
    return m ? ` ~${m} דק׳` : '';
}

/** "🔁 נדחתה 4 פעמים" — the rollover tail, only when it carries information. */
function rolloverSuffix(t: TaskLike): string {
    const n = t.rollover_count || 0;
    if (n <= 0) return '';
    if (n >= CHRONIC_ROLLOVER_THRESHOLD) return ` 🔁 נדחתה ${n} פעמים`;
    return n === 1 ? ' 🔁 נדחתה מאתמול' : ` 🔁 נדחתה ${n} פעמים`;
}

/**
 * Split the pending queue into the sections a report should show.
 *
 * THE WHOLE POINT: `missed` (red) contains ONLY tasks that blew a real external
 * deadline, and it is meant to be almost always empty. Everything the user simply
 * hasn't got to yet lands in `rolling` (amber) — carried forward, not failed.
 * Before the deadline/planned split these were one pile, the pile was always red,
 * and a red list that is always long teaches you to stop reading it.
 */
export interface QueueSplit {
    missed: TaskLike[];
    dueToday: TaskLike[];
    rolling: TaskLike[];
    chronic: TaskLike[];
    rest: TaskLike[];
}

export function splitQueue(tasks: TaskLike[], todayStr: string): QueueSplit {
    const taken = new Set<string>();
    const claim = (rows: TaskLike[]) => { rows.forEach(t => taken.add(t.id)); return rows; };

    const missed = claim(tasks.filter(t => t.deadline && t.deadline < todayStr));
    const dueToday = claim(tasks.filter(t => !taken.has(t.id) && t.deadline === todayStr));
    const rolling = claim(tasks.filter(t => !taken.has(t.id) && t.state === 'rolled_over'));
    const chronic = rolling.filter(t => (t.rollover_count || 0) >= CHRONIC_ROLLOVER_THRESHOLD);
    const rest = tasks.filter(t => !taken.has(t.id) && t.state !== 'waiting');
    return { missed, dueToday, rolling, chronic, rest };
}

/**
 * The amber block: work that came along from earlier days. Framed as "still with
 * us", never as failure — that framing is the behavioural half of the fix.
 */
export function rollingBlock(rolling: TaskLike[], chronic: TaskLike[]): string[] {
    if (!rolling.length) return [];
    const out = [`🔁 ${b(`ממשיכות איתנו להיום (${rolling.length}):`)}`];
    for (const t of rolling) out.push(taskLine(t));
    if (chronic.length) {
        out.push('', `⚠️ ${b(`נדחו ${CHRONIC_ROLLOVER_THRESHOLD} פעמים ומעלה (${chronic.length}) — שווה לפצל, להקטין או לוותר:`)}`);
        for (const t of chronic) out.push(`• ${t.title} (${t.id})`);
    }
    return out;
}

/** The red block: missed HARD deadlines only. Should usually be empty. */
export function missedDeadlineBlock(missed: TaskLike[], todayStr: string): string[] {
    if (!missed.length) return [];
    const out = [`🔴 ${b(`דד-ליינים שעברו (${missed.length}):`)}`];
    for (const t of missed) {
        const late = t.deadline ? daysBetween(t.deadline, todayStr) : 0;
        out.push(taskLine(t, t.deadline ? ` (הדד-ליין היה ${t.deadline}, לפני ${hebrewDays(late)})` : ''));
    }
    return out;
}

/**
 * One task line. The id goes last, in parentheses (see BIDI NOTE above).
 * No priority tag here — priority is carried by the group header instead, which
 * keeps the lines short and stops every bullet repeating "בינוני".
 */
export function taskLine(t: TaskLike, extra: string = ''): string {
    const project = t.project_name ? ` · ${t.project_name}` : '';
    return `• ${t.title}${estimateSuffix(t)}${rolloverSuffix(t)}${project}${extra} (${t.id})`;
}

/**
 * Every task, grouped under a Hebrew priority header. Deliberately has NO cap:
 * truncating with "…ועוד 4" was the single biggest complaint about the old
 * briefing — data silently vanished and the list stopped being trustworthy.
 * Compactness comes from grouping and short lines, not from dropping rows.
 */
export function tasksByPriority(tasks: TaskLike[], indent = ''): string[] {
    const out: string[] = [];
    for (const p of ['high', 'medium', 'low']) {
        const group = tasks.filter(t => (t.priority || 'medium') === p);
        if (!group.length) continue;
        out.push(`${indent}${PRIORITY_EMOJI[p]} ${b(PRIORITY_HE[p])} (${group.length}):`);
        for (const t of group) out.push(`${indent}${taskLine(t)}`);
    }
    // Anything with an unexpected priority value still gets listed — never dropped.
    const known = new Set(['high', 'medium', 'low']);
    const rest = tasks.filter(t => !known.has(t.priority || 'medium'));
    if (rest.length) {
        out.push(`${indent}⚪ ${b('שונות')} (${rest.length}):`);
        for (const t of rest) out.push(`${indent}${taskLine(t)}`);
    }
    return out;
}

// ─── Calendar ─────────────────────────────────────────────────────────

export interface EventLike { title: string; start: string; all_day: boolean }

export function eventTime(iso: string, tz: string): string {
    return new Date(iso).toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
    });
}

/**
 * An event is "all day" when Google gave us a date-only start, and ALSO when it
 * lands exactly on midnight — some clients (and every imported/birthday-style
 * entry) produce a 00:00 dateTime. Both used to render as "00:00 — …", which
 * read like a 3am meeting.
 */
export function isAllDay(e: EventLike, tz: string): boolean {
    if (e.all_day) return true;
    if (!e.start) return false;
    return eventTime(e.start, tz) === '00:00';
}

/**
 * Agenda block: all-day events first under their own header, then the timed
 * ones. `emptyText` is what to say when the day is clear.
 */
export function agendaBlock(events: EventLike[], tz: string, header: string, emptyText: string): string[] {
    const allDay = events.filter(e => isAllDay(e, tz));
    const timed = events.filter(e => !isAllDay(e, tz))
        .sort((a, z) => a.start.localeCompare(z.start));

    const out: string[] = [];
    if (allDay.length) {
        out.push(`📌 ${b('לאורך כל היום:')}`);
        for (const e of allDay) out.push(`• ${e.title}`);
        out.push('');
    }
    out.push(`📅 ${b(header)}`);
    if (!timed.length) out.push(allDay.length ? '• אין אירועים בשעות מוגדרות.' : `• ${emptyText}`);
    else for (const e of timed) out.push(`• ${eventTime(e.start, tz)} — ${e.title}`);
    return out;
}

// ─── Money ────────────────────────────────────────────────────────────

export interface AlertLike { category: string; alert: string; spent: number; limit: number; percent: number }

export function budgetAlertLines(alerts: AlertLike[]): string[] {
    return alerts.map(a => {
        const tag = a.alert === 'over' ? '🔴' : '🟡';
        const note = a.alert === 'over'
            ? `חריגה של ${NIS(a.spent - a.limit)}`
            : `${a.percent}% מנוצל · נותרו ${NIS(a.limit - a.spent)}`;
        return `${tag} ${a.category}: ${NIS(a.spent)} מתוך ${NIS(a.limit)} — ${note}`;
    });
}

/** Drops blank lines that collected at the seams between optional sections. */
export function compose(lines: string[]): string {
    const out: string[] = [];
    for (const l of lines) {
        if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
        out.push(l);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
}
