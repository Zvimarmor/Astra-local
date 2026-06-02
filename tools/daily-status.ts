import { getPendingTasks, getHabits } from './storage';
import { config } from './config';

/**
 * Daily Status Tool — Aggregation
 *
 * Ported from the AWS WhatsApp Bot. Combines task and habit data
 * into a unified daily summary.
 */

export const dailyStatusTools = {
    get_daily_status: {
        name: "get_daily_status",
        description: "Get a unified daily status summary of pending tasks and unlogged habits.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const tasks = getPendingTasks();
                const habits = getHabits();
                const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
                const incompleteHabits = habits.filter(h => h.last_logged_date !== today);

                return {
                    summary: `You have ${tasks.length} pending tasks and ${incompleteHabits.length} habits to complete today.`,
                    pending_tasks: tasks,
                    uncompleted_habits: incompleteHabits
                };
            } catch (err: any) {
                console.error("[DailyStatus] Error:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
