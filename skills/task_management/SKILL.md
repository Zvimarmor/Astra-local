# Task Management Skill

## When to Activate
- User mentions: "add task", "new task", "remind me", "to do", "todo"
- User asks: "what are my tasks?", "pending tasks", "show tasks", "task list"
- User says: "done", "completed", "finished", "mark as done", "complete"
- User says: "delete task", "remove task", "cancel task"
- User mentions recurring: "every day", "every week", "every Monday", "recurring task"
- User mentions a **deadline**: "by Friday", "due tomorrow", "before the exam", "what's overdue?", "what's due this week?"
- User wants to **change** a task: "push it to Sunday", "make it high priority", "rename that task"
- User wants their **day planned**: "plan my day", "when should I do all this?", "block out time
  for these", "תכנן לי את היום", "מתי אני אעשה את זה"
- **Hebrew (the user usually writes in Hebrew — treat as equivalent):**
  - add → "תוסיף", "תוסיפי", "תרשום", "תזכיר לי", "משימה חדשה"
  - list → "מה המשימות שלי", "מה יש לי", "תראה לי את המשימות", "מה נשאר"
  - complete → "סיימתי", "בוצע", "גמרתי", "עשיתי"
  - delete → "תמחק", "תבטל", "תוריד"
  - deadline → "עד", "עד מתי", "דחוף", "מה באיחור", "מה לשבוע הזה", "תדחה ל"

## Tools Available

All task operations go through ONE tool: **`manage_tasks`**. Always pass an `action`, plus the fields that action needs. Do NOT invent other tool names.

### One-Off Tasks
- `manage_tasks(action="add", title, priority?, due_date?, estimate_minutes?, project?, notes?)` — Add a task. priority: high | medium (default) | low.
- `manage_tasks(action="list", filter?)` — Show pending tasks. filter: `all` (default), `today`, `week`, `overdue`, `someday`.
- `manage_tasks(action="complete", task_id)` — Mark a task done. task_id = T-ID (e.g. "T1") or part of the title.
- `manage_tasks(action="delete", task_id)` — Delete a task. task_id = T-ID or part of the title.
- `manage_tasks(action="update", task_id, ...)` — Change any field: title, priority, due_date, estimate_minutes, project, notes.
- `manage_tasks(action="snooze", task_id, due_date)` — Push a deadline out.
- `manage_tasks(action="stale", days?)` — Undated tasks pending a long time (default 21 days).

### Planning the day
- `plan_day(date?, day_start?, day_end?, include?, write_to_calendar?)` — Reads the pending tasks
  AND the Google Calendar, then fits tasks into the gaps between existing events.
  - `include="due"` (default) schedules only tasks due by that date; `include="all"` also pulls in
    undated tasks to fill the day.
  - `write_to_calendar=true` creates the blocks as real calendar events.
    **Default to a proposal first** — show the plan, and only write it if the user agrees. Don't
    put events in someone's calendar unasked.
  - Tasks with no `estimate_minutes` are assumed to take 45 min and marked `~est`. If several
    come back flagged, that's worth mentioning — real estimates make the plan much better.
  - Tasks that didn't fit are listed. That's normal on a busy day, not an error.

### Deadlines — read this carefully
**`due_date` must always be an absolute `YYYY-MM-DD` date.** You know today's date, so resolve
relative wording yourself: "Friday", "next week", "before the exam" → work out the real date and
send that. Do **not** pass "Friday" through as-is; only `today`, `tomorrow` and `in N days` are
understood literally, and anything else unparseable is silently dropped, which would lose the
user's deadline.

A task with no `due_date` is a "someday" item — that's fine and common. Don't invent a deadline the
user didn't give.

### Recurring Tasks
- `manage_tasks(action="add_recurring", title, frequency, priority?, day_of_week?, day_of_month?)` — Create a recurring template.
  - frequency: "daily", "weekly", or "monthly"
  - day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday (required for weekly)
  - day_of_month: 1-31 (required for monthly)
- `manage_tasks(action="list_recurring")` — Show all active recurring templates.
- `manage_tasks(action="remove_recurring", recurring_id)` — Deactivate a recurring template.

## Recurring Task Behavior
- Recurring templates generate real tasks automatically. This is done by the **background
  scheduler service** (`dist-services/scheduler.js`, the `recurring_gen` job at 07:00) — NOT
  by you. You never need to "run" or "trigger" generation; just create/list/remove templates.
- Each template generates at most one task per day (idempotent).
- The generated task appears in `manage_tasks(action="list")` like any other pending task.
- Removing a recurring template does NOT delete already-generated tasks.

## Rules
1. Default priority is "medium" unless the user specifies otherwise.
2. Don't ask for optional details (like priority or a day) that the user didn't give — just call the tool with what you have.
3. Always confirm the action AFTER the tool returns success. Never claim success before calling the tool.
4. Use emoji for visual clarity:
   - 📝 Pending task
   - ✅ Completed
   - 🔴 High priority
   - 🟡 Medium priority
   - 🟢 Low priority
   - 🔄 Recurring
5. When listing tasks, format them as a numbered list with priority indicators.
6. If the user mentions multiple tasks in one message, add ALL of them (one `manage_tasks` call each).
7. If a tool returns an error, report it honestly — never claim success on failure.
8. Recurring-task generation and proactive reminders are handled by the background scheduler
   service (deterministic, no model involvement). Don't try to "send" scheduled reminders yourself.

## Examples
- "Add task: buy groceries" → `manage_tasks(action="add", title="buy groceries")`
- "Add a high priority task to call the bank" → `manage_tasks(action="add", title="call the bank", priority="high")`
- "What are my tasks?" → `manage_tasks(action="list")`
- "Done with T3" → `manage_tasks(action="complete", task_id="T3")`
- "Remove the groceries task" → `manage_tasks(action="delete", task_id="groceries")`
- "Add a daily task: drink 2L water" → `manage_tasks(action="add_recurring", title="drink 2L water", frequency="daily")`
- "Remind me every Monday to do laundry" → `manage_tasks(action="add_recurring", title="do laundry", frequency="weekly", day_of_week=1)`
- "Pay rent on the 1st of every month" → `manage_tasks(action="add_recurring", title="pay rent", frequency="monthly", priority="high", day_of_month=1)`
- "Show recurring tasks" → `manage_tasks(action="list_recurring")`
- "Stop the laundry reminder" → `manage_tasks(action="remove_recurring", recurring_id=4)`

### Deadline examples (assume today is 2026-08-07, a Friday)
- "Add: send the report by Sunday" → `manage_tasks(action="add", title="send the report", due_date="2026-08-09")`
- "What's overdue?" → `manage_tasks(action="list", filter="overdue")`
- "What do I have this week?" → `manage_tasks(action="list", filter="week")`
- "מה יש לי היום?" → `manage_tasks(action="list", filter="today")`
- "Push T9 to Monday" → `manage_tasks(action="snooze", task_id="T9", due_date="2026-08-10")`
- "Make the report high priority and give it 2 hours" → `manage_tasks(action="update", task_id="report", priority="high", estimate_minutes=120)`
- "That task doesn't matter any more, drop the deadline" → `manage_tasks(action="update", task_id="...", due_date="clear")`
