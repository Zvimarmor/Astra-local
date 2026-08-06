import {
    addTask, getPendingTasks, completeTask, deleteTask, updateTask, resolveTaskId,
    getStaleTasks, resolveProjectId, todayStr, dateOffsetStr,
    type TaskFilter, type TaskRow,
} from './storage';

/**
 * Task Management Tools — Local SQLite
 *
 * Schema: tasks(id TEXT PK, date TEXT, title TEXT, status TEXT, priority TEXT,
 *               due_date TEXT, estimate_minutes INTEGER, project_id INTEGER,
 *               notes TEXT, created_at DATETIME, completed_at DATETIME)
 *
 * Note on dates: `date` is the CREATION date (it always was). `due_date` is the
 * deadline and is nullable — a task with no due date is a "someday" item, which
 * is the common case. Keeping those distinct is what makes "overdue" mean
 * something; before due_date existed, deadline questions were unanswerable.
 */

/** ISO date (YYYY-MM-DD) shape check — no Date parsing, no timezone surprises. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a due-date argument to YYYY-MM-DD.
 *
 * The skill tells the model to send ISO dates (it knows today's date, so it can
 * resolve "Friday" itself far more reliably than a hand-rolled parser could).
 * A couple of relative words are accepted anyway because they're what actually
 * arrives when the model is being terse.
 *
 * Returns `undefined` for "no value supplied" and `null` for an explicit clear,
 * so `update` can distinguish "leave it alone" from "remove the deadline".
 */
function parseDueDate(v: any): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === 'none' || v === 'clear') return null;

    const s = String(v).trim().toLowerCase();
    if (ISO_DATE.test(s)) return s;
    if (s === 'today') return todayStr();
    if (s === 'tomorrow') return dateOffsetStr(1);
    if (s === 'yesterday') return dateOffsetStr(-1);

    const inDays = s.match(/^in (\d+) days?$/);
    if (inDays) return dateOffsetStr(parseInt(inDays[1], 10));

    // Unparseable: treat as "not supplied" rather than guessing a wrong deadline.
    return undefined;
}

/** Compact one-line rendering. Keeps list output small for the chat surface. */
function fmtTask(t: TaskRow): string {
    const bits: string[] = [`${t.id} ${t.title}`];
    if (t.due_date) {
        const today = todayStr();
        const overdue = t.due_date < today;
        const due = t.due_date === today ? 'today' : t.due_date;
        bits.push(overdue ? `⚠️ overdue ${t.due_date}` : `due ${due}`);
    }
    if (t.priority && t.priority !== 'medium') bits.push(t.priority);
    if (t.estimate_minutes) bits.push(`~${t.estimate_minutes}m`);
    if (t.project_name) bits.push(`[${t.project_name}]`);
    return bits.join(' · ');
}

export const taskTools = {
    add_task: {
        name: "add_task",
        description: "Add a new task to the local task list.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "The task description" },
                priority: { type: "string", description: "Priority level: high, medium, or low", enum: ["high", "medium", "low"] },
                due_date: { type: "string", description: "Deadline as YYYY-MM-DD (resolve words like 'Friday' to a real date yourself). Omit if there is no deadline." },
                estimate_minutes: { type: "number", description: "Rough time needed, in minutes. Enables day planning." },
                project: { type: "string", description: "Project/mission name or id to file this task under." },
                notes: { type: "string", description: "Extra context for the task." },
            },
            required: ["title"]
        },
        execute: async (args: any) => {
            try {
                const due = parseDueDate(args.due_date);
                let projectId: number | null = null;
                let projectWarning: string | undefined;
                if (args.project) {
                    projectId = resolveProjectId(args.project);
                    if (projectId === null) projectWarning = `No project matched "${args.project}" — task added without one.`;
                }

                const result = addTask(args.title, args.priority || 'medium', {
                    dueDate: due ?? null,
                    estimateMinutes: args.estimate_minutes ?? null,
                    projectId,
                    notes: args.notes ?? null,
                });

                let message = `Task ${result.id} added: "${result.title}"`;
                if (due) message += ` (due ${due})`;
                if (projectWarning) message += ` ${projectWarning}`;
                return { status: "success", taskId: result.id, message };
            } catch (err: any) {
                console.error("[Tasks] Error adding task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_tasks: {
        name: "list_tasks",
        description: "List pending tasks, optionally filtered by deadline window.",
        parameters: {
            type: "object",
            properties: {
                filter: {
                    type: "string",
                    enum: ["all", "today", "week", "overdue", "someday"],
                    description: "all (default); today = due today or earlier; week = due within 7 days; overdue = past due; someday = no deadline",
                },
            }
        },
        execute: async (args: any = {}) => {
            try {
                const filter = (args.filter || 'all') as TaskFilter;
                const tasks = getPendingTasks(filter);
                if (!tasks.length) {
                    const empty: Record<string, string> = {
                        overdue: 'Nothing overdue. 👍',
                        today: 'Nothing due today.',
                        week: 'Nothing due in the next 7 days.',
                        someday: 'No undated tasks.',
                        all: 'No pending tasks.',
                    };
                    return { status: "success", count: 0, message: empty[filter] || empty.all };
                }
                return {
                    status: "success",
                    count: tasks.length,
                    filter,
                    message: tasks.map(fmtTask).join('\n'),
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
                const success = completeTask(args.taskId);
                if (success) {
                    return { status: "success", message: "Task marked as completed." };
                } else {
                    return { status: "error", error: "Task not found or already completed." };
                }
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
        description: "Edit an existing task: title, priority, deadline, estimate, project or notes.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" },
                title: { type: "string", description: "New title" },
                priority: { type: "string", enum: ["high", "medium", "low"], description: "New priority" },
                due_date: { type: "string", description: "New deadline YYYY-MM-DD, or 'clear' to remove it" },
                estimate_minutes: { type: "number", description: "New time estimate in minutes" },
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
                if (args.estimate_minutes !== undefined) patch.estimateMinutes = args.estimate_minutes;
                if (args.notes !== undefined) patch.notes = args.notes;

                const due = parseDueDate(args.due_date);
                if (due !== undefined) patch.dueDate = due;

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
        description: "Push a task's deadline to a new date (e.g. 'tomorrow', or YYYY-MM-DD).",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "The task ID (e.g., T1) or part of the task title" },
                until: { type: "string", description: "New deadline: YYYY-MM-DD, 'tomorrow', or 'in 3 days'" },
            },
            required: ["taskId", "until"]
        },
        execute: async (args: any) => {
            try {
                const due = parseDueDate(args.until);
                if (!due) {
                    return { status: "error", error: `Could not read "${args.until}" as a date. Use YYYY-MM-DD.` };
                }
                const id = updateTask(args.taskId, { dueDate: due });
                if (!id) return { status: "error", error: "Task not found." };
                return { status: "success", taskId: id, message: `Task ${id} moved to ${due}.` };
            } catch (err: any) {
                console.error("[Tasks] Error snoozing task:", err.message);
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
    }
};
