# Daily Briefing Skill

> NOTE: The **proactive** 08:00 morning and 20:00 evening briefings are sent automatically by
> the background scheduler service (`dist-services/scheduler.js`), built deterministically from
> SQLite — NOT by you. This skill is for **on-demand** briefings when the user asks for one in
> chat. The format below mirrors what the scheduler sends, so on-demand answers feel consistent.

## When to Activate
- User asks: "daily summary", "briefing", "what do I have today?", "what's on for today?"

## Tools Available
- `assistant_utils(action="daily_status")` — Get pending tasks and uncompleted habits.
- `manage_calendar(action="list", max_results?)` — Get today's calendar events.
- `manage_finances(action="expense_summary", period?)` — Get recent expense totals.
- `manage_finances(action="budget_alerts")` — Check budget status.
- `manage_finances(action="financial_overview", period?)` — Get income vs expense snapshot.
- `assistant_utils(action="current_time")` — Get today's date.

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
1. Call all relevant tools to build a complete picture (`assistant_utils action="daily_status"`, `manage_calendar action="list"`, the `manage_finances` actions).
2. Keep the summary concise and scannable.
3. If there are no events or tasks, say so positively ("No events scheduled — a free day!").
4. In the evening, highlight the highest-priority task for tomorrow.
5. Only show budget alerts if there are actual warnings or overages.
6. Only show financial snapshot if there's data to show (at least one expense or income entry).
