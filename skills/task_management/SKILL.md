# Task Management Skill

## When to Activate
- User mentions: "add task", "new task", "remind me", "to do", "todo"
- User asks: "what are my tasks?", "pending tasks", "show tasks", "task list"
- User says: "done", "completed", "finished", "mark as done", "complete"
- User says: "delete task", "remove task", "cancel task"
- User mentions recurring: "every day", "every week", "every Monday", "recurring task"
- Scheduler triggers recurring_tasks heartbeat (7:00 AM daily)

## Tools Available

### One-Off Tasks
- `add_task(title, priority)` — Add a new task. Priority: high, medium (default), or low.
- `list_tasks()` — Show all pending tasks.
- `complete_task(taskId)` — Mark a task as completed. Accepts T-ID (e.g., T1) or partial title.
- `delete_task(taskId)` — Permanently delete a task. Accepts T-ID or partial title.

### Recurring Tasks
- `add_recurring_task(title, frequency, priority?, day_of_week?, day_of_month?)` — Create a recurring task template.
  - frequency: "daily", "weekly", or "monthly"
  - day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday (required for weekly)
  - day_of_month: 1-31 (required for monthly)
- `list_recurring_tasks()` — Show all active recurring task templates.
- `remove_recurring_task(id)` — Deactivate a recurring task template.

## Recurring Task Behavior
- Recurring templates generate real tasks automatically via the 7 AM scheduler.
- Each template generates at most one task per day (idempotent).
- The generated task appears in `list_tasks()` like any other pending task.
- Removing a recurring template does NOT delete already-generated tasks.

## Rules
1. Default priority is "medium" unless the user specifies otherwise.
2. Always confirm the action after executing a tool.
3. Use emoji for visual clarity:
   - 📝 Pending task
   - ✅ Completed
   - 🔴 High priority
   - 🟡 Medium priority
   - 🟢 Low priority
   - 🔄 Recurring
4. When listing tasks, format them as a numbered list with priority indicators.
5. If the user mentions multiple tasks in one message, add ALL of them in one turn.
6. If a tool returns an error, report it honestly — never claim success on failure.
7. When the scheduler triggers recurring_tasks, silently generate tasks — only notify if tasks were actually created.

## Examples
- "Add task: buy groceries" → `add_task("buy groceries", "medium")`
- "What are my tasks?" → `list_tasks()`
- "Done with T3" → `complete_task("T3")`
- "Remove the groceries task" → `delete_task("groceries")`
- "Add a daily task: drink 2L water" → `add_recurring_task("drink 2L water", "daily")`
- "Remind me every Monday to do laundry" → `add_recurring_task("do laundry", "weekly", "medium", 1)`
- "Pay rent on the 1st of every month" → `add_recurring_task("pay rent", "monthly", "high", undefined, 1)`
- "Show recurring tasks" → `list_recurring_tasks()`
- "Stop the laundry reminder" → `remove_recurring_task(id)`
