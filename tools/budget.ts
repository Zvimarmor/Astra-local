import { setBudget, getBudgets, deleteBudget, checkBudgetAlerts } from './storage';

/**
 * Budget Tools — Monthly Spending Limits
 *
 * Allows setting monthly budget limits per expense category.
 * Budget alerts are checked automatically via scheduler heartbeat
 * and can also be queried on demand.
 */

export const budgetTools = {
    set_budget: {
        name: "set_budget",
        description: "Set a monthly spending limit for an expense category. If a budget already exists for that category, it will be updated.",
        parameters: {
            type: "object",
            properties: {
                category: {
                    type: "string",
                    description: "Expense category (e.g., food, transport, shopping, entertainment)"
                },
                monthly_limit: {
                    type: "number",
                    description: "Monthly spending limit in NIS"
                }
            },
            required: ["category", "monthly_limit"]
        },
        execute: async (args: any) => {
            try {
                if (args.monthly_limit <= 0) {
                    return { status: "error", error: "Budget limit must be a positive number." };
                }
                setBudget(args.category, args.monthly_limit);
                return {
                    status: "success",
                    message: `Budget set: ${args.category} — ${args.monthly_limit} NIS/month`
                };
            } catch (err: any) {
                console.error("[Budget] Error setting budget:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    list_budgets: {
        name: "list_budgets",
        description: "List all budget limits with current spending and remaining balance for this month.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const alerts = checkBudgetAlerts();
                if (alerts.length === 0) {
                    return { budgets: [], count: 0, message: "No budgets set. Use set_budget to create one." };
                }
                return {
                    budgets: alerts.map(a => ({
                        category: a.category,
                        spent: a.spent,
                        limit: a.limit,
                        remaining: Math.max(0, a.limit - a.spent),
                        percent: a.percent,
                        status: a.alert === 'over' ? '🔴 OVER BUDGET' : a.alert === 'warning' ? '🟡 Warning (80%+)' : '🟢 OK'
                    })),
                    count: alerts.length
                };
            } catch (err: any) {
                console.error("[Budget] Error listing budgets:", err.message);
                return { status: "error", error: err.message };
            }
        }
    },

    check_budget_alerts: {
        name: "check_budget_alerts",
        description: "Check which expense categories are near or over their monthly budget limit. Returns only categories with warnings or overages.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const alerts = checkBudgetAlerts();
                const flagged = alerts.filter(a => a.alert !== 'ok');

                if (flagged.length === 0) {
                    return {
                        status: "all_clear",
                        message: "All budgets are within limits. 🟢",
                        total_budgets: alerts.length
                    };
                }

                return {
                    alerts: flagged.map(a => ({
                        category: a.category,
                        spent: a.spent,
                        limit: a.limit,
                        percent: a.percent,
                        status: a.alert === 'over'
                            ? `🔴 OVER BUDGET by ${a.spent - a.limit} NIS`
                            : `🟡 ${a.percent}% used (${a.limit - a.spent} NIS remaining)`
                    })),
                    count: flagged.length
                };
            } catch (err: any) {
                console.error("[Budget] Error checking alerts:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
