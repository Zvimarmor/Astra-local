# Task Management Skill

## When to Activate
- User mentions: "add task", "new task", "remind me", "to do", "todo"
- User asks: "what are my tasks?", "pending tasks", "show tasks", "task list"
- User says: "done", "completed", "finished", "mark as done", "complete"
- User says: "delete task", "remove task", "cancel task"
- User mentions recurring: "every day", "every week", "every Monday", "recurring task"
- Scheduler triggers recurring_tasks heartbeat (7:00 AM daily)

## Tools Available

All task operations go through ONE tool: **`manage_tasks`**. Always pass an `action`, plus the fields that action needs. Do NOT invent other tool names.

### One-Off Tasks
- `manage_tasks(action="add", title, priority?)` — Add a task. priority: high | medium (default) | low.
- `manage_tasks(action="list")` — Show all pending tasks.
- `manage_tasks(action="complete", task_id)` — Mark a task done. task_id = T-ID (e.g. "T1") or part of the title.
- `manage_tasks(action="delete", task_id)` — Delete a task. task_id = T-ID or part of the title.

### Recurring Tasks
- `manage_tasks(action="add_recurring", title, frequency, priority?, day_of_week?, day_of_month?)` — Create a recurring template.
  - frequency: "daily", "weekly", or "monthly"
  - day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday (required for weekly)
  - day_of_month: 1-31 (required for monthly)
- `manage_tasks(action="list_recurring")` — Show all active recurring templates.
- `manage_tasks(action="remove_recurring", recurring_id)` — Deactivate a recurring template.

## Recurring Task Behavior
- Recurring templates generate real tasks automatically via the 7 AM scheduler.
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
8. When the scheduler triggers recurring_tasks, silently generate tasks — only notify if tasks were actually created.

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
