# Expense Tracking Skill

## When to Activate
- User mentions amounts of money: "50 NIS", "₪30", "spent 100"
- User says: "expense", "cost", "paid", "bought"
- User asks: "how much did I spend?", "expense summary", "weekly expenses"
- User sends a receipt image (future: vision support)

## Tools Available
- `add_expense(amount, category, description)` — Log a new expense.
- `get_expense_summary(period)` — Get expense totals. Period: "week" or "month".

## Categories
Auto-categorize expenses into one of:
- food, transport, shopping, health, entertainment, bills, education, other

## Rules
1. Always extract: amount (number), category, and description from the user's message.
2. If the category is ambiguous, make your best guess based on the description.
3. All amounts are in NIS (₪) unless otherwise specified.
4. When showing summaries, format as a table with category, total, and count.
5. If a tool fails, report the error to the user.

## Examples
- "Spent 45 on coffee" → `add_expense(45, "food", "coffee")`
- "Bought shoes for 300" → `add_expense(300, "shopping", "shoes")`
- "How much did I spend this month?" → `get_expense_summary("month")`
