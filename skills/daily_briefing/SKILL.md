# Daily Briefing Skill

## When to Activate
- **Automatically** via scheduler at 08:00 (morning) and 20:00 (evening)
- User asks: "daily summary", "briefing", "what do I have today?"

## Tools Available
- `get_daily_status()` — Get pending tasks and uncompleted habits.
- `list_calendar_events(maxResults)` — Get today's calendar events.
- `get_expense_summary(period)` — Get recent expense totals.
- `get_current_time()` — Get today's date.

## Morning Briefing Format (08:00)
```
☀️ Good morning! Daily Summary — [date]

📅 Today's Events:
  1. [Event name] ([time])
  2. ...

✅ Pending Tasks:
  1. [Task title] ([priority])
  2. ...
  (and X more)

Have a productive day! 💪
```

## Evening Summary Format (20:00)
```
🌙 Good evening! Evening Summary — [date]

💰 Expenses recorded (week): [total] NIS

✅ Top priority for tomorrow: [task title]

Good night! 😴
```

## Rules
1. Always call all relevant tools to build a complete picture.
2. Keep the summary concise and scannable.
3. If there are no events or tasks, say so positively ("No events scheduled — a free day!").
4. In the evening, highlight the highest-priority task for tomorrow.
