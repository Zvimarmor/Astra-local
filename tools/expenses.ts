import { addExpense, getExpenseSummary } from './storage';

/**
 * Expense Tracking Tools — Local SQLite
 *
 * Ported from the AWS WhatsApp Bot. Previously wrote to both Google Sheets
 * and local SQLite. Now uses local SQLite exclusively.
 *
 * Schema: expenses(id INTEGER PK, amount REAL, category TEXT,
 *                  description TEXT, date TEXT, timestamp DATETIME)
 */

export const expenseTools = {
    add_expense: {
        name: "add_expense",
        description: "Log a new expense with amount, category, and description.",
        parameters: {
            type: "object",
            properties: {
                amount: { type: "number", description: "Amount spent in NIS" },
                category: { type: "string", description: "Category (food, transport, shopping, health, entertainment, etc.)" },
                description: { type: "string", description: "Short description of the expense" }
            },
            required: ["amount", "category", "description"]
        },
        execute: async (args: any) => {
            try {
                const result = addExpense(args.amount, args.category, args.description);
                return {
                    status: "success",
                    message: `Expense logged: ${result.amount} NIS (${result.category})`
                };
            } catch (err: any) {
                console.error("[Expenses] Error adding expense:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    get_expense_summary: {
        name: "get_expense_summary",
        description: "Get a summary of recent expenses grouped by category. Supports 'week' or 'month' periods.",
        parameters: {
            type: "object",
            properties: {
                period: { type: "string", description: "'week' or 'month'", enum: ["week", "month"] }
            }
        },
        execute: async (args: any) => {
            try {
                return getExpenseSummary(args.period || 'week');
            } catch (err: any) {
                console.error("[Expenses] Error getting summary:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
