import {
    addTask, getPendingTasks, completeTask, deleteTask, updateTask, resolveTaskId, getTask,
    getStaleTasks, resolveProjectId, todayStr, dateOffsetStr, ensureDailyRollover, rollOverTasks,
    CHRONIC_ROLLOVER_THRESHOLD,
    type TaskFilter, type TaskRow, type TaskState,
} from './storage';
import { inferDuration, KIND_LABEL, normalizeMinutes } from './duration-heuristics';
import { fillSlot, rankTasks, sizeOf } from './task-queue';

/**
 * Task Management Tools — the rolling queue.
 *
 * THE MODEL, IN ONE PARAGRAPH
 *   A task has two dates and they mean different things. `deadline` is a hard,
 *   external constraint — a form that closes, a flight, an exam. Missing it has
 *   consequences outside your own head, and only a missed `deadline` is ever
 *   shown as overdue. `planned_date` is when you INTEND to do it; it is a
 *   commitment to yourself, it rolls forward automatically when the day ends,
 *   and it never produces an alarm. Most tasks should have neither, or only a
 *   planned_date. Deadlines should be rare enough that seeing one means something.
 *
 * WHY: with a single `due_date` doing both jobs, every plan that slipped became
 * a red "OVERDUE" line. The red list filled with self-imposed noise, the two
 * real deadlines in it became invisible, and the user learned to ignore the
 * colour. Splitting the two dates is the whole fix; rollover, capacity planning
 * and slot-filling are what the split makes possible.
 */

/** ISO date (YYYY-MM-DD) shape check — no Date parsing, no timezone surprises. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a date argument to YYYY-MM-DD.
 *
 * The skill tells the model to send ISO dates (it knows today's date, so it can
 * resolve "Friday" itself far more reliably than a hand-rolled parser could).
 * A couple of relative words are accepted anyway because they're what actually
 * arrives when the model is being terse.
 *
 * Returns `undefined` for "no value supplied" and `null` for an explicit clear,
 * so `update` can distinguish "leave it alone" from "remove the date".
 */
function parseDate(v: any): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === 'none' || v === 'clear') return null;

    const s = String(v).trim().toLowerCase();
    if (ISO_DATE.test(s)) return s;
    if (s === 'today') return todayStr();
    if (s === 'tomorrow') return dateOffsetStr(1);
    if (s === 'yesterday') return dateOffsetStr(-1);

    const inDays = s.match(/^in (\d+) days?$/);
    if (inDays) return dateOffsetStr(parseInt(inDays[1], 10));

    // Unparseable: treat as "not supplied" rather than guessing a wrong date.
    return undefined;
}

/** Accept both the new and the legacy spelling of the estimate parameter. */
function readEstimate(args: any): number | undefined {
    const raw = args.estimated_minutes ?? args.estimate_minutes;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? normalizeMinutes(n) : undefined;
}

/** Compact one-line rendering. Keeps list output small for the chat surface. */
function fmtTask(t: TaskRow): string {
    const today = todayStr();
    const bits: string[] = [`${t.id} ${t.title}`];

    // Red is reserved for a genuinely missed external deadline.
    if (t.deadline) {
        if (t.deadline < today) bits.push(`🔴 deadline passed ${t.deadline}`);
        else if (t.deadline === today) bits.push('🔴 deadline today');
        else bits.push(`deadline ${t.deadline}`);
    }
    if (t.state === 'rolled_over') {
        const n = t.rollover_count || 0;
        bits.push(n >= CHRONIC_ROLLOVER_THRESHOLD ? `🔁 rolled ${n}× — chronic` : `🔁 rolled ${n}×`);
    } else if (t.state === 'waiting') {
        bits.push(t.waiting_on ? `⏸ waiting on ${t.waiting_on}` : '⏸ waiting');
    } else if (t.planned_date && !t.deadline) {
        bits.push(t.planned_date === today ? 'planned today' : `planned ${t.planned_date}`);
    }

    if (t.priority && t.priority !== 'medium') bits.push(t.priority);
    const { minutes, guessed } = sizeOf(t);
    bits.push(guessed ? `~${minutes}m est` : `~${minutes}m`);
    if (t.project_name) bits.push(`[${t.project_name}]`);
    return bits.join(' · ');
}

/** Group a mixed list into the sections a human actually reads. */
function fmtGrouped(tasks: TaskRow[]): string {
    const today = todayStr();
    const missed = tasks.filter(t => t.deadline && t.deadline < today);
    const seen = new Set(missed.map(t => t.id));
    const dueSoon = tasks.filter(t => !seen.has(t.id) && t.deadline && t.deadline <= dateOffsetStr(2));
    dueSoon.forEach(t => seen.add(t.id));
    const rolling = tasks.filter(t => !seen.has(t.id) && t.state === 'rolled_over');
    rolling.forEach(t => seen.add(t.id));
    const waiting = tasks.filter(t => !seen.has(t.id) && t.state === 'waiting');
    waiting.forEach(t => seen.add(t.id));
    const planned = tasks.filter(t => !seen.has(t.id) && t.planned_date);
    planned.forEach(t => seen.add(t.id));
    const inbox = tasks.filter(t => !seen.has(t.id));

    const out: string[] = [];
    const section = (title: string, rows: TaskRow[]) => {
        if (!rows.length) return;
        out.push(`${title} (${rows.length})`);
        for (const t of rows) out.push(`  ${fmtTask(t)}`);
    };
    section('🔴 Missed deadlines', missed);
    section('⏰ Deadline within 2 days', dueSoon);
    section('🔁 Rolling over', rolling);
    section('📅 Planned', planned);
    section('📥 Inbox / no date', inbox);
    section('⏸ Waiting on someone', waiting);
    return out.join('\n');
}

export const taskTools = {
    add_task: {
        name: "add_task",
        description:
            "Add a task. Use planned_date for when you INTEND to do it (it rolls forward by itself). " +
            "Use deadline ONLY for a real external constraint. Duration is inferred if you don't give one.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "The task description" },
                priority: { type: "string", description: "Priority level: high, medium, or low", enum: ["high", "medium", "low"] },
                planned_date: { type: "string", description: "When you plan to DO it, YYYY-MM-DD. Soft — rolls forward automatically." },
                deadline: { type: "string", description: "Hard external deadline, YYYY-MM-DD. Only for real constraints." },
                estimated_minutes: { type: "number", description: "How long it takes. Omit and it will be inferred from the title." },
                project: { type: "string", description: "Project/mission name or id to file this task under." },
                notes: { type: "string", description: "Extra context for the task." },
            },
            required: ["title"]
        },
        execute: async (args: any) => {
            try {
                // Legacy `due_date` maps to planned_date, never to deadline: the old
                // parameter meant both, and guessing "deadline" would resurrect the
                // false-alarm problem the split exists to fix.
                const planned = parseDate(args.planned_date ?? args.due_date);
                const deadline = parseDate(args.deadline);

                let projectId: number | null = null;
                let projectWarning: string | undefined;
                if (args.project) {
                    projectId = resolveProjectId(args.project);
                    if (projectId === null) projectWarning = `No project matched "${args.project}" — task added without one.`;
                }

                const explicit = readEstimate(args);
                const guess = inferDuration(args.title, args.notes);
                const minutes = explicit ?? guess.minutes;
                const kind = explicit ? null : guess.kind;

                const result = addTask(args.title, args.priority || 'medium', {
                    plannedDate: planned ?? null,
                    deadline: deadline ?? null,
                    estimatedMinutes: minutes,
                    taskKind: kind,
                    projectId,
                    notes: args.notes ?? null,
                });

                let message = `Task ${result.id} added: "${result.title}"`;
                if (deadline) message += ` · deadline ${deadline}`;
                if (planned) message += ` · planned ${planned}`;
                message += explicit
                    ? ` · ~${minutes}m`
                    : ` · ~${minutes}m estimated (${KIND_LABEL[guess.kind]})`;
                if (projectWarning) message += ` ${projectWarning}`;

                return {
                    status: "success",
                    taskId: result.id,
                    estimated_minutes: minutes,
                    estimate_source: explicit ? 'explicit' : guess.source,
                    task_kind: kind ?? undefined,
                    message,
                };
            } catch (err: any) {
                console.error("[Tasks] Error adding task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_tasks: {
        name: "list_tasks",
        description: "List pending tasks. Missed deadlines, rolling tasks and the inbox are shown separately.",
        parameters: {
            type: "object",
            properties: {
                filter: {
                    type: "string",
                    enum: ["all", "active", "today", "week", "overdue", "inbox", "planned", "rolling", "waiting", "chronic", "someday"],
                    description:
                        "all (default) · today = planned or due today/earlier · week = next 7 days · " +
                        "overdue = MISSED HARD DEADLINES ONLY · rolling = carried over from an earlier day · " +
                        "inbox/someday = captured, no date · chronic = rolled over 3+ times · waiting = blocked on someone else",
                },
            }
        },
        execute: async (args: any = {}) => {
            try {
                ensureDailyRollover();
                const filter = (args.filter || 'all') as TaskFilter;
                const tasks = getPendingTasks(filter);
                if (!tasks.length) {
                    const empty: Record<string, string> = {
                        overdue: 'No missed deadlines. 👍',
                        today: 'Nothing planned or due today.',
                        week: 'Nothing planned or due in the next 7 days.',
                        someday: 'Inbox is empty.',
                        inbox: 'Inbox is empty.',
                        rolling: 'Nothing rolled over — you kept up with your plan. 👌',
                        chronic: `Nothing has rolled over ${CHRONIC_ROLLOVER_THRESHOLD}+ times.`,
                        waiting: 'Not waiting on anyone.',
                        all: 'No pending tasks.',
                    };
                    return { status: "success", count: 0, message: empty[filter] || empty.all };
                }

                const grouped = filter === 'all' || filter === 'active' || filter === 'today' || filter === 'week';
                return {
                    status: "success",
                    count: tasks.length,
                    filter,
                    message: grouped ? fmtGrouped(tasks) : tasks.map(fmtTask).join('\n'),
                };
            } catch (err: any) {
                console.error("[Tasks] Error listing tasks:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    complete_task: {
        name: "complete_task",
        description: "Mark a task as completed by its T-ID (e.g., T1) or partial title match.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" }
            },
            required: ["taskId"]
        },
        execute: async (args: any) => {
            try {
                // Read the row BEFORE completing it — a task that took five
                // rollovers to finish is worth naming, both as a small win and as
                // evidence the original estimate was wrong.
                const before = getTask(args.taskId);
                const success = completeTask(args.taskId);
                if (!success) return { status: "error", error: "Task not found or already completed." };

                let message = "Task marked as completed.";
                if (before && (before.rollover_count || 0) >= CHRONIC_ROLLOVER_THRESHOLD) {
                    message += ` (finally — it had rolled over ${before.rollover_count} times.)`;
                }
                return { status: "success", message };
            } catch (err: any) {
                console.error("[Tasks] Error completing task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    delete_task: {
        name: "delete_task",
        description: "Permanently delete a task by its T-ID (e.g., T1) or partial title match.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" }
            },
            required: ["taskId"]
        },
        execute: async (args: any) => {
            try {
                const success = deleteTask(args.taskId);
                if (success) {
                    return { status: "success", message: "Task deleted." };
                } else {
                    return { status: "error", error: "Task not found." };
                }
            } catch (err: any) {
                console.error("[Tasks] Error deleting task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    update_task: {
        name: "update_task",
        description: "Edit an existing task: title, priority, planned date, deadline, estimate, project or notes.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" },
                title: { type: "string", description: "New title" },
                priority: { type: "string", enum: ["high", "medium", "low"], description: "New priority" },
                planned_date: { type: "string", description: "New planned execution date YYYY-MM-DD, or 'clear'" },
                deadline: { type: "string", description: "New hard deadline YYYY-MM-DD, or 'clear' to remove it" },
                estimated_minutes: { type: "number", description: "New time estimate in minutes" },
                project: { type: "string", description: "Project/mission to move it to, or 'clear' to unfile it" },
                notes: { type: "string", description: "Replace the notes" },
            },
            required: ["taskId"]
        },
        execute: async (args: any) => {
            try {
                const patch: any = {};
                if (args.title !== undefined) patch.title = args.title;
                if (args.priority !== undefined) patch.priority = args.priority;
                if (args.notes !== undefined) patch.notes = args.notes;

                const est = readEstimate(args);
                if (est !== undefined) { patch.estimatedMinutes = est; patch.taskKind = null; }
                else if (args.estimated_minutes === null || args.estimate_minutes === null) patch.estimatedMinutes = null;

                const planned = parseDate(args.planned_date ?? args.due_date);
                if (planned !== undefined) patch.plannedDate = planned;
                const deadline = parseDate(args.deadline);
                if (deadline !== undefined) patch.deadline = deadline;

                if (args.project !== undefined) {
                    const p = String(args.project).trim().toLowerCase();
                    if (p === '' || p === 'clear' || p === 'none') patch.projectId = null;
                    else {
                        const pid = resolveProjectId(args.project);
                        if (pid === null) return { status: "error", error: `No project matched "${args.project}".` };
                        patch.projectId = pid;
                    }
                }

                if (!Object.keys(patch).length) {
                    return { status: "error", error: "Nothing to update — pass at least one field to change." };
                }

                const id = updateTask(args.taskId, patch);
                if (!id) return { status: "error", error: "Task not found." };
                return { status: "success", taskId: id, message: `Task ${id} updated.` };
            } catch (err: any) {
                console.error("[Tasks] Error updating task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    snooze_task: {
        name: "snooze_task",
        description:
            "Move a task's PLANNED date (e.g. 'tomorrow', or YYYY-MM-DD). This is the soft date — " +
            "it does not touch a hard deadline, and it resets the rolled-over flag.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" },
                until: { type: "string", description: "New planned date: YYYY-MM-DD, 'tomorrow', or 'in 3 days'" },
            },
            required: ["taskId", "until"]
        },
        execute: async (args: any) => {
            try {
                const when = parseDate(args.until);
                if (!when) {
                    return { status: "error", error: `Could not read "${args.until}" as a date. Use YYYY-MM-DD.` };
                }
                const before = getTask(args.taskId);
                const id = updateTask(args.taskId, { plannedDate: when, state: 'planned' });
                if (!id) return { status: "error", error: "Task not found." };

                let message = `Task ${id} planned for ${when}.`;
                // A deliberate re-plan is a fresh commitment, so the rollover flag
                // clears — but the COUNT is kept, because that history is the only
                // evidence that a task is being chronically avoided.
                if (before?.deadline && when > before.deadline) {
                    message += ` ⚠️ That is after its hard deadline (${before.deadline}).`;
                }
                if (before && (before.rollover_count || 0) >= CHRONIC_ROLLOVER_THRESHOLD) {
                    message += ` This one has rolled over ${before.rollover_count} times — worth shrinking or dropping it.`;
                }
                return { status: "success", taskId: id, message };
            } catch (err: any) {
                console.error("[Tasks] Error snoozing task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    wait_task: {
        name: "wait_task",
        description: "Park a task as blocked on someone else, or un-park it back into the active queue.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" },
                waiting_on: { type: "string", description: "Who or what it's blocked on. Omit (or pass 'clear') to un-block it." },
            },
            required: ["taskId"]
        },
        execute: async (args: any) => {
            try {
                const raw = args.waiting_on === undefined ? undefined : String(args.waiting_on).trim();
                const unblock = raw !== undefined && ['', 'clear', 'none', 'no'].includes(raw.toLowerCase());

                const state: TaskState = unblock ? 'planned' : 'waiting';
                const id = updateTask(args.taskId, { state, waitingOn: unblock ? null : (raw ?? null) });
                if (!id) return { status: "error", error: "Task not found." };
                return {
                    status: "success",
                    taskId: id,
                    message: unblock
                        ? `Task ${id} is back in the active queue.`
                        : `Task ${id} parked as waiting${raw ? ` on ${raw}` : ''}. It won't be planned or suggested until you un-park it.`,
                };
            } catch (err: any) {
                console.error("[Tasks] Error parking task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    suggest_tasks: {
        name: "suggest_tasks",
        description:
            "\"I have 30 free minutes — what should I do?\" Picks tasks from the active queue that fit " +
            "the time available, ranked by deadline, priority, project relevance and how long they've been rolling.",
        parameters: {
            type: "object",
            properties: {
                available_minutes: { type: "number", description: "How much free time there is, in minutes" },
                project: { type: "string", description: "Only suggest tasks from this project/mission" },
                min_minutes: { type: "number", description: "Ignore tasks shorter than this (for a long window you want to use properly)" },
                limit: { type: "number", description: "How many suggestions to return (default 5)" },
            },
            required: ["available_minutes"]
        },
        execute: async (args: any) => {
            try {
                const available = Number(args.available_minutes);
                if (!Number.isFinite(available) || available < 5) {
                    return { status: "error", error: "Tell me how many minutes are free (at least 5)." };
                }
                ensureDailyRollover();

                let projectId: number | null = null;
                if (args.project) {
                    projectId = resolveProjectId(args.project);
                    if (projectId === null) return { status: "error", error: `No project matched "${args.project}".` };
                }

                const today = todayStr();
                const pool = getPendingTasks('active');
                const res = fillSlot(pool, available, today, {
                    projectId,
                    limit: args.limit ?? 5,
                    minMinutes: args.min_minutes ?? 0,
                });

                if (!res.picks.length) {
                    const hint = res.tooLong.length
                        ? ` The nearest fits need more room: ${res.tooLong.map(r => `${r.task.id} ${r.task.title} (~${r.minutes}m)`).join(', ')}.`
                        : '';
                    return {
                        status: "success",
                        count: 0,
                        message: `Nothing in the queue fits ${available} minutes.${hint}`,
                    };
                }

                const lines = [`⏱ ${available} free minutes — best fits:`];
                for (const r of res.picks) {
                    const est = r.guessed ? `~${r.minutes}m est` : `~${r.minutes}m`;
                    lines.push(`  ${r.task.id} ${r.task.title} · ${est} · ${r.reason}`);
                }
                if (res.combo.length) {
                    lines.push('', `Or fill the whole window (${res.comboMinutes}m of ${available}m):`);
                    lines.push(`  ${res.combo.map(r => `${r.task.id} ${r.task.title} (${r.minutes}m)`).join(' → ')}`);
                }

                return {
                    status: "success",
                    count: res.picks.length,
                    available_minutes: available,
                    top: res.picks[0].task.id,
                    message: lines.join('\n'),
                };
            } catch (err: any) {
                console.error("[Tasks] Error suggesting tasks:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    roll_over_tasks: {
        name: "roll_over_tasks",
        description: "Carry every unfinished task from previous days into today's queue. Runs automatically once a day; this forces it.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const { rolled, ids } = rollOverTasks();
                if (!rolled) return { status: "success", rolled: 0, message: "Nothing to roll over — the queue is current." };
                const chronic = getPendingTasks('chronic');
                let message = `Rolled ${rolled} task(s) into today: ${ids.join(', ')}.`;
                if (chronic.length) {
                    message += `\n⚠️ ${chronic.length} task(s) have now rolled ${CHRONIC_ROLLOVER_THRESHOLD}+ times:\n` +
                        chronic.map(t => `  ${fmtTask(t)}`).join('\n');
                }
                return { status: "success", rolled, message };
            } catch (err: any) {
                console.error("[Tasks] Error rolling over tasks:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    stale_tasks: {
        name: "stale_tasks",
        description: "List undated tasks that have been pending a long time — candidates to drop or schedule.",
        parameters: {
            type: "object",
            properties: {
                days: { type: "number", description: "How old counts as stale (default 21)" },
            }
        },
        execute: async (args: any = {}) => {
            try {
                const tasks = getStaleTasks(args.days ?? 21);
                if (!tasks.length) return { status: "success", count: 0, message: "No stale tasks." };
                return {
                    status: "success",
                    count: tasks.length,
                    message: tasks.map(t => `${t.id} ${t.title} (added ${t.date})`).join('\n'),
                };
            } catch (err: any) {
                console.error("[Tasks] Error listing stale tasks:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    triage_tasks: {
        name: "triage_tasks",
        description: "Queue health: what's chronically rolling, what's stuck in the inbox, and how much work is actually queued.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                ensureDailyRollover();
                const today = todayStr();
                const active = getPendingTasks('active');
                const ranked = rankTasks(active, today);
                const totalMinutes = ranked.reduce((n, r) => n + r.minutes, 0);
                const missed = active.filter(t => t.deadline && t.deadline < today);
                const rolling = active.filter(t => t.state === 'rolled_over');
                const chronic = active.filter(t => (t.rollover_count || 0) >= CHRONIC_ROLLOVER_THRESHOLD);
                const inbox = active.filter(t => !t.planned_date && !t.deadline);
                const waiting = getPendingTasks('waiting');

                const L: string[] = ['🧭 Queue health'];
                L.push(`  ${active.length} active · ${Math.round(totalMinutes / 60 * 10) / 10}h of work queued · ${waiting.length} waiting on others`);
                L.push(`  🔴 missed deadlines: ${missed.length} · 🔁 rolling: ${rolling.length} · 📥 inbox: ${inbox.length}`);
                if (chronic.length) {
                    L.push('', `⚠️ Chronically avoided (${CHRONIC_ROLLOVER_THRESHOLD}+ rollovers) — shrink, delegate or drop these:`);
                    for (const t of chronic) L.push(`  ${fmtTask(t)}`);
                }
                if (ranked.length) {
                    L.push('', 'Next up:');
                    for (const r of ranked.slice(0, 5)) L.push(`  ${r.task.id} ${r.task.title} · ~${r.minutes}m · ${r.reason}`);
                }
                return {
                    status: "success",
                    active: active.length,
                    queued_minutes: totalMinutes,
                    chronic: chronic.length,
                    message: L.join('\n'),
                };
            } catch (err: any) {
                console.error("[Tasks] Error triaging:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },
};
