import { addHabit, logHabit, getHabits } from './storage';

/**
 * Habit Tracking Tools — Local SQLite
 *
 * Ported from the AWS WhatsApp Bot — identical functionality.
 * Already used local SQLite in the original; no changes needed.
 */

export const habitTools = {
    track_habit: {
        name: "track_habit",
        description: "Start tracking a new habit or update an existing one.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the habit to track (e.g., 'drink water')" },
                frequency: { type: "string", description: "How often to do it (e.g., 'daily', 'weekly')" }
            },
            required: ["name", "frequency"]
        },
        execute: async (args: any) => {
            try {
                addHabit(args.name, args.frequency);
                return { status: "success", message: `Started tracking habit: ${args.name} (${args.frequency})` };
            } catch (err: any) {
                console.error("[Habits] Error adding habit:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    log_habit: {
        name: "log_habit",
        description: "Log that a habit was completed today.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the habit completed" }
            },
            required: ["name"]
        },
        execute: async (args: any) => {
            try {
                const success = logHabit(args.name);
                if (success) {
                    return { status: "success", message: `Logged habit: ${args.name} as done for today.` };
                } else {
                    return { status: "error", error: `Habit '${args.name}' not found. Add it first with track_habit.` };
                }
            } catch (err: any) {
                console.error("[Habits] Error logging habit:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_habits: {
        name: "list_habits",
        description: "List all tracked habits and their statuses.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const habits = getHabits();
                return { habits, count: habits.length };
            } catch (err: any) {
                console.error("[Habits] Error listing habits:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
