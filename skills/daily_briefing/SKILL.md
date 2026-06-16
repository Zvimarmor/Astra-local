# Daily Briefing Skill

## When to Activate
- **Automatically** via scheduler at 08:00 (morning) and 20:00 (evening)
- User asks: "daily summary", "briefing", "what do I have today?"

## Tools Available
- `get_daily_status()` — Get pending tasks and uncompleted habits.
- `list_calendar_events(maxResults)` — Get today's calendar events.
- `get_expense_summary(period)` — Get recent expense totals.
- `check_budget_alerts()` — Check budget status.
- `get_financial_overview(period)` — Get income vs expense snapshot.
- `get_current_time()` — Get today's date.

## Morning Briefing Format (08:00)
```
☀️ Good morning! Daily Summary — [date]

📅 Today's Events:
  1. [Event name] ([time])
  2. ...

✅ Pending Tasks ([count]):
  1. [Task title] ([priority])
  2. ...
  (and X more)

💰 Financial Snapshot (this month):
  Income: [total] NIS | Expenses: [total] NIS | Net: [±net] NIS

⚠️ Budget Alerts: (only if warnings/overages exist)
  🔴 [category]: [spent]/[limit] NIS — OVER
  🟡 [category]: [spent]/[limit] NIS — [percent]%

Have a productive day! 💪
```

## Evening Summary Format (20:00)
```
🌙 Good evening! Evening Summary — [date]

💰 Today's expenses: [total] NIS
📊 Weekly total: [total] NIS

✅ Top priority for tomorrow: [task title]

🔄 Recurring tasks active: [count] templates

Good night! 😴
```

## Rules
1. Always call all relevant tools to build a complete picture.
2. Keep the summary concise and scannable.
3. If there are no events or tasks, say so positively ("No events scheduled — a free day!").
4. In the evening, highlight the highest-priority task for tomorrow.
5. Only show budget alerts if there are actual warnings or overages.
6. Only show financial snapshot if there's data to show (at least one expense or income entry).
