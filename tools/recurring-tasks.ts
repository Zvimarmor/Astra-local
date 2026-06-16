import {
    addRecurringTask,
    getActiveRecurringTasks,
    deactivateRecurringTask,
    generateDueRecurringTasks
} from './storage';

/**
 * Recurring Task Tools — Automated Task Generation
 *
 * Allows creating task templates that automatically generate real tasks
 * on a daily, weekly, or monthly schedule. Generation is triggered
 * by the scheduler heartbeat at 07:00 daily.
 *
 * Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday
 * Day of month: 1-31
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const recurringTaskTools = {
    add_recurring_task: {
        name: "add_recurring_task",
        description: "Create a recurring task template that automatically generates a real task on schedule. Frequency can be 'daily', 'weekly' (specify day_of_week 0-6, where 0=Sunday), or 'monthly' (specify day_of_month 1-31).",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "The task description" },
                priority: { type: "string", description: "Priority: high, medium, or low", enum: ["high", "medium", "low"] },
                frequency: { type: "string", description: "How often: daily, weekly, or monthly", enum: ["daily", "weekly", "monthly"] },
                day_of_week: { type: "number", description: "For weekly: 0=Sunday, 1=Monday, ..., 6=Saturday" },
                day_of_month: { type: "number", description: "For monthly: day of the month (1-31)" }
            },
            required: ["title", "frequency"]
        },
        execute: async (args: any) => {
            try {
                const frequency = args.frequency;
                const priority = args.priority || 'medium';

                // Validate day fields
                if (frequency === 'weekly' && (args.day_of_week === undefined || args.day_of_week === null)) {
                    return { status: "error", error: "Weekly tasks require day_of_week (0=Sunday, 1=Monday, ..., 6=Saturday)." };
                }
                if (frequency === 'monthly' && (args.day_of_month === undefined || args.day_of_month === null)) {
                    return { status: "error", error: "Monthly tasks require day_of_month (1-31)." };
                }
                if (frequency === 'weekly' && (args.day_of_week < 0 || args.day_of_week > 6)) {
                    return { status: "error", error: "day_of_week must be 0-6 (0=Sunday)." };
                }
                if (frequency === 'monthly' && (args.day_of_month < 1 || args.day_of_month > 31)) {
                    return { status: "error", error: "day_of_month must be 1-31." };
                }

                const id = addRecurringTask(args.title, priority, frequency, args.day_of_week, args.day_of_month);

                let scheduleDesc = frequency;
                if (frequency === 'weekly') scheduleDesc = `every ${DAY_NAMES[args.day_of_week]}`;
                if (frequency === 'monthly') scheduleDesc = `on the ${args.day_of_month}${getOrdinalSuffix(args.day_of_month)} of each month`;

                return {
                    status: "success",
                    id,
                    message: `Recurring task created: "${args.title}" — ${scheduleDesc} (${priority} priority)`
                };
            } catch (err: any) {
                console.error("[RecurringTasks] Error adding:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_recurring_tasks: {
        name: "list_recurring_tasks",
        description: "List all active recurring task templates.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const tasks = getActiveRecurringTasks();
                return {
                    tasks: tasks.map(t => ({
                        id: t.id,
                        title: t.title,
                        priority: t.priority,
                        frequency: t.frequency,
                        schedule: formatSchedule(t),
                        last_generated: t.last_generated_date || 'never'
                    })),
                    count: tasks.length
                };
            } catch (err: any) {
                console.error("[RecurringTasks] Error listing:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    remove_recurring_task: {
        name: "remove_recurring_task",
        description: "Deactivate a recurring task template by its ID. The template will no longer generate new tasks.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "number", description: "The recurring task ID (from list_recurring_tasks)" }
            },
            required: ["id"]
        },
        execute: async (args: any) => {
            try {
                const success = deactivateRecurringTask(args.id);
                if (success) {
                    return { status: "success", message: `Recurring task #${args.id} deactivated.` };
                } else {
                    return { status: "error", error: `Recurring task #${args.id} not found or already deactivated.` };
                }
            } catch (err: any) {
                console.error("[RecurringTasks] Error removing:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};

// ─── Internal Helpers ────────────────────────────────────────────

function getOrdinalSuffix(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

function formatSchedule(t: { frequency: string; day_of_week: number | null; day_of_month: number | null }): string {
    if (t.frequency === 'daily') return 'Every day';
    if (t.frequency === 'weekly' && t.day_of_week !== null) return `Every ${DAY_NAMES[t.day_of_week]}`;
    if (t.frequency === 'monthly' && t.day_of_month !== null) return `${t.day_of_month}${getOrdinalSuffix(t.day_of_month)} of each month`;
    return t.frequency;
}
