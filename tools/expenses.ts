import { addExpense, getExpenseSummary, addIncome, getFinancialOverview } from './storage';

/**
 * Expense & Financial Tools — Local SQLite
 *
 * Ported from the AWS WhatsApp Bot. Previously wrote to both Google Sheets
 * and local SQLite. Now uses local SQLite exclusively.
 *
 * Includes:
 *   - Expense logging and summaries
 *   - Income logging (salary, freelance, refunds, etc.)
 *   - Combined financial overview (income vs expenses, net cashflow)
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
    },

    add_income: {
        name: "add_income",
        description: "Log income received (salary, freelance payment, refund, gift, etc.).",
        parameters: {
            type: "object",
            properties: {
                amount: { type: "number", description: "Amount received in NIS" },
                source: { type: "string", description: "Source of income (salary, freelance, refund, gift, scholarship, etc.)" },
                description: { type: "string", description: "Short description of the income" }
            },
            required: ["amount", "source", "description"]
        },
        execute: async (args: any) => {
            try {
                if (args.amount <= 0) {
                    return { status: "error", error: "Income amount must be positive." };
                }
                const result = addIncome(args.amount, args.source, args.description);
                return {
                    status: "success",
                    message: `Income logged: ${result.amount} NIS from ${result.source}`
                };
            } catch (err: any) {
                console.error("[Income] Error adding income:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    get_financial_overview: {
        name: "get_financial_overview",
        description: "Get a combined financial overview showing income vs expenses and net cashflow. Supports 'week', 'month', or 'year' periods.",
        parameters: {
            type: "object",
            properties: {
                period: { type: "string", description: "'week', 'month', or 'year'", enum: ["week", "month", "year"] }
            }
        },
        execute: async (args: any) => {
            try {
                return getFinancialOverview(args.period || 'month');
            } catch (err: any) {
                console.error("[Financial] Error getting overview:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
