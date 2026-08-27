/**
 * The rolling queue's decision layer: how long is a task, how badly does it want
 * to be done next, and what fits in the time you actually have.
 *
 * PURE ON PURPOSE — no SQLite, no network. It takes rows in and returns rankings
 * out, which is what lets `plan_day`, the free-slot suggester and the scheduler's
 * reports all agree with each other instead of each inventing its own idea of
 * "important". If two surfaces disagree about what to do next, the user stops
 * trusting both.
 */

import { inferDuration, normalizeMinutes, type TaskKind } from './duration-heuristics';
import { CHRONIC_ROLLOVER_THRESHOLD, type TaskRow } from './storage';

/**
 * Plan to only 70% of the free time in a day.
 *
 * Not a fudge factor — it is the difference between a plan that survives contact
 * with a normal day and one that is already broken by 10am. Context switching,
 * overrunning tasks and the interruptions that never make it into a calendar all
 * come out of the same budget. A 100%-packed day generates its own rollover
 * backlog, which is precisely the failure this whole system exists to stop.
 */
export const CAPACITY_FACTOR = 0.7;

export interface SizedTask {
    task: TaskRow;
    /** Minutes to budget for it. */
    minutes: number;
    /** True when `minutes` is inferred rather than user-supplied. */
    guessed: boolean;
    kind: TaskKind | string;
    score: number;
    /** Short human explanation of the score, for tool output. */
    reason: string;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). Negative = `to` is earlier. */
export function daysUntil(from: string, to: string): number {
    const a = new Date(`${from}T12:00:00Z`).getTime();
    const z = new Date(`${to}T12:00:00Z`).getTime();
    return Math.round((z - a) / 86400000);
}

/**
 * How long to budget for a task: the stored estimate if there is one, otherwise
 * the heuristic reading of its title. Never returns 0 — a zero-length block
 * would let an unbounded number of tasks "fit" any slot.
 */
export function sizeOf(t: TaskRow): { minutes: number; guessed: boolean; kind: TaskKind | string } {
    if (t.estimated_minutes && t.estimated_minutes > 0) {
        return { minutes: normalizeMinutes(t.estimated_minutes), guessed: false, kind: t.task_kind || 'custom' };
    }
    const g = inferDuration(t.title, t.notes);
    return { minutes: g.minutes, guessed: true, kind: t.task_kind || g.kind };
}

/**
 * Rank one task. Higher = do it sooner.
 *
 * The weights encode a specific opinion: a real deadline beats everything, but
 * a task that has been rolled over repeatedly climbs steadily so the queue can't
 * quietly starve it forever behind a stream of newer, shinier work. That aging
 * term is what stops "rolling" from becoming "never".
 */
export function scoreTask(t: TaskRow, today: string): { score: number; reason: string } {
    let score = 0;
    const why: string[] = [];

    if (t.deadline) {
        const d = daysUntil(today, t.deadline);
        if (d < 0) { score += 100 + Math.min(30, -d * 2); why.push(`deadline missed ${-d}d ago`); }
        else if (d === 0) { score += 90; why.push('deadline today'); }
        else if (d === 1) { score += 70; why.push('deadline tomorrow'); }
        else if (d <= 3) { score += 55; why.push(`deadline in ${d}d`); }
        else if (d <= 7) { score += 40; why.push(`deadline in ${d}d`); }
        else { score += 20; why.push(`deadline ${t.deadline}`); }
    }

    score += ({ high: 25, medium: 10, low: 0 } as Record<string, number>)[t.priority] ?? 10;
    if (t.priority === 'high') why.push('high priority');

    // Aging: the anti-starvation term.
    const rolls = t.rollover_count || 0;
    if (rolls > 0) {
        score += Math.min(rolls * 5, 25);
        why.push(rolls >= CHRONIC_ROLLOVER_THRESHOLD ? `rolled ${rolls}× — chronic` : `rolled ${rolls}×`);
    }

    if (t.planned_date && t.planned_date <= today) { score += 15; why.push('planned for today'); }

    // Project relevance — work that moves a live mission beats orphan to-dos,
    // and a mission with a near target date pulls its tasks up with it.
    if (t.project_id) {
        score += 6;
        if (t.project_target_date) {
            const pd = daysUntil(today, t.project_target_date);
            if (pd <= 7) { score += 14; why.push(`${t.project_name || 'project'} due in ${Math.max(pd, 0)}d`); }
            else why.push(String(t.project_name || 'project'));
        } else if (t.project_name) {
            why.push(t.project_name);
        }
    }

    return { score, reason: why.join(', ') || 'backlog' };
}

/** Size + score a list, highest first. `waiting` tasks are dropped — they aren't ours to do. */
export function rankTasks(tasks: TaskRow[], today: string): SizedTask[] {
    return tasks
        .filter(t => t.state !== 'waiting' && t.status !== 'Completed')
        .map(t => {
            const { minutes, guessed, kind } = sizeOf(t);
            const { score, reason } = scoreTask(t, today);
            return { task: t, minutes, guessed, kind, score, reason };
        })
        .sort((a, z) => z.score - a.score || a.minutes - z.minutes);
}

export interface SlotFillOptions {
    /** Only consider tasks belonging to this project (name already resolved to id). */
    projectId?: number | null;
    /** Cap the number of suggestions returned. */
    limit?: number;
    /** Exclude tasks shorter than this — "I have 2 free hours" shouldn't return a 5-min call. */
    minMinutes?: number;
}

export interface SlotFillResult {
    /** Best single-task answers, best first. */
    picks: SizedTask[];
    /** A combination that fills the window more completely, when one beats the top pick alone. */
    combo: SizedTask[];
    comboMinutes: number;
    /** Tasks that were skipped purely because they don't fit the window. */
    tooLong: SizedTask[];
}

/**
 * "I have 30 free minutes — what should I do?"
 *
 * Two answers are returned because they're genuinely different questions. `picks`
 * answers "what's the most valuable thing I can finish right now" (single tasks,
 * ranked). `combo` answers "how do I use the whole window" — a greedy fill that
 * only gets offered when it beats the best single pick, so a 90-minute window
 * doesn't come back with one 15-minute phone call and 75 idle minutes.
 */
export function fillSlot(tasks: TaskRow[], availableMinutes: number, today: string, opts: SlotFillOptions = {}): SlotFillResult {
    const limit = opts.limit ?? 5;
    const minMinutes = opts.minMinutes ?? 0;

    let ranked = rankTasks(tasks, today);
    if (opts.projectId) ranked = ranked.filter(r => r.task.project_id === opts.projectId);

    const fits = ranked.filter(r => r.minutes <= availableMinutes && r.minutes >= minMinutes);
    const tooLong = ranked.filter(r => r.minutes > availableMinutes);

    // Greedy fill in score order — deliberately not a knapsack optimiser. The
    // user has to agree with the answer in three seconds; "your most important
    // things, in order, until time runs out" is explainable, an optimal subset
    // that skips the top-scoring task to save four minutes is not.
    const combo: SizedTask[] = [];
    let used = 0;
    for (const r of fits) {
        if (used + r.minutes > availableMinutes) continue;
        combo.push(r);
        used += r.minutes;
    }

    return {
        picks: fits.slice(0, limit),
        combo: combo.length > 1 ? combo : [],
        comboMinutes: combo.length > 1 ? used : 0,
        tooLong: tooLong.slice(0, 3),
    };
}

/** Usable minutes in a day, after the realism buffer. */
export function usableCapacity(totalFreeMinutes: number, factor: number = CAPACITY_FACTOR): number {
    return Math.floor(totalFreeMinutes * factor);
}
