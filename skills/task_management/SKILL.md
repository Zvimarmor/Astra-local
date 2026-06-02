# Task Management Skill

## When to Activate
- User mentions: "add task", "new task", "remind me", "to do", "todo"
- User asks: "what are my tasks?", "pending tasks", "show tasks", "task list"
- User says: "done", "completed", "finished", "mark as done", "complete"
- User says: "delete task", "remove task", "cancel task"

## Tools Available
- `add_task(title, priority)` — Add a new task. Priority: high, medium (default), or low.
- `list_tasks()` — Show all pending tasks.
- `complete_task(taskId)` — Mark a task as completed. Accepts T-ID (e.g., T1) or partial title.
- `delete_task(taskId)` — Permanently delete a task. Accepts T-ID or partial title.

## Rules
1. Default priority is "medium" unless the user specifies otherwise.
2. Always confirm the action after executing a tool.
3. Use emoji for visual clarity:
   - 📝 Pending task
   - ✅ Completed
   - 🔴 High priority
   - 🟡 Medium priority
   - 🟢 Low priority
4. When listing tasks, format them as a numbered list with priority indicators.
5. If the user mentions multiple tasks in one message, add ALL of them in one turn.
6. If a tool returns an error, report it honestly — never claim success on failure.

## Examples
- "Add task: buy groceries" → `add_task("buy groceries", "medium")`
- "What are my tasks?" → `list_tasks()`
- "Done with T3" → `complete_task("T3")`
- "Remove the groceries task" → `delete_task("groceries")`
