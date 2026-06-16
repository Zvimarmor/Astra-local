# Expense Tracking & Financial Management Skill

## When to Activate
- User mentions amounts of money: "50 NIS", "₪30", "spent 100"
- User says: "expense", "cost", "paid", "bought"
- User asks: "how much did I spend?", "expense summary", "weekly expenses"
- User mentions income: "received", "salary", "got paid", "refund"
- User asks about finances: "financial overview", "how much did I earn?", "net cashflow"
- User mentions budgets: "set budget", "budget limit", "am I over budget?"
- Scheduler triggers budget_check heartbeat (noon daily)
- User sends a receipt image (future: vision support)

## Tools Available

### Expenses
- `add_expense(amount, category, description)` — Log a new expense.
- `get_expense_summary(period)` — Get expense totals. Period: "week" or "month".

### Income
- `add_income(amount, source, description)` — Log income (salary, freelance, refund, gift, scholarship, etc.).

### Financial Overview
- `get_financial_overview(period)` — Combined income vs expenses report with net cashflow. Period: "week", "month", or "year".

### Budget Alerts
- `set_budget(category, monthly_limit)` — Set a monthly spending limit for a category.
- `list_budgets()` — Show all budgets with current spending, remaining balance, and status.
- `check_budget_alerts()` — Check which categories are near (80%+) or over their monthly limit.

## Categories
Auto-categorize expenses into one of:
- food, transport, shopping, health, entertainment, bills, education, other

## Income Sources
Common sources:
- salary, freelance, refund, gift, scholarship, side_project, other

## Rules
1. Always extract: amount (number), category/source, and description from the user's message.
2. If the category is ambiguous, make your best guess based on the description.
3. All amounts are in NIS (₪) unless otherwise specified.
4. When showing summaries, format as a table with category, total, and count.
5. If a tool fails, report the error to the user.
6. When the scheduler triggers budget_check, only notify the user if there are warnings or overages. Don't send "all clear" messages.

## Budget Alert Format
```
⚠️ Budget Alert:
🔴 food: 2,150/2,000 NIS (107%) — OVER by 150 NIS
🟡 entertainment: 420/500 NIS (84%) — 80 NIS remaining
🟢 transport: 180/500 NIS (36%) — on track
```

## Financial Overview Format
```
💰 Financial Overview (month):
📈 Income: 8,500 NIS (salary: 7,000, freelance: 1,500)
📉 Expenses: 4,200 NIS (food: 1,800, transport: 600, ...)
💵 Net: +4,300 NIS
```

## Examples
- "Spent 45 on coffee" → `add_expense(45, "food", "coffee")`
- "Got paid 7000 salary" → `add_income(7000, "salary", "monthly salary")`
- "Set budget for food 2000" → `set_budget("food", 2000)`
- "Am I over budget?" → `check_budget_alerts()`
- "Financial summary for this month" → `get_financial_overview("month")`
