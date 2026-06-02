import { addTask, getPendingTasks, completeTask, deleteTask } from './storage';

/**
 * Task Management Tools — Local SQLite
 *
 * Ported from the AWS WhatsApp Bot's Google Sheets-based task system.
 * Now uses a local SQLite `tasks` table with the same T-ID scheme (T1, T2, T3...).
 *
 * Schema: tasks(id TEXT PK, date TEXT, title TEXT, status TEXT, priority TEXT,
 *               created_at DATETIME, completed_at DATETIME)
 */

export const taskTools = {
    add_task: {
        name: "add_task",
        description: "Add a new task to the local task list.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "The task description" },
                priority: { type: "string", description: "Priority level: high, medium, or low", enum: ["high", "medium", "low"] }
            },
            required: ["title"]
        },
        execute: async (args: any) => {
            try {
                const result = addTask(args.title, args.priority || 'medium');
                return {
                    status: "success",
                    taskId: result.id,
                    message: `Task ${result.id} added: "${result.title}"`
                };
            } catch (err: any) {
                console.error("[Tasks] Error adding task:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_tasks: {
        name: "list_tasks",
        description: "List all pending (incomplete) tasks.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const tasks = getPendingTasks();
                return { tasks, count: tasks.length };
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
    }
};
