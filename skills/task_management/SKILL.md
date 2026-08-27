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
- User has **time to fill**: "I have 30 minutes free", "what should I do now?", "I'm ahead of
  schedule", "התפנו לי 30 דקות", "מה מומלץ לעשות עכשיו", "יש לי שעה פנויה"
- **Hebrew (the user usually writes in Hebrew — treat as equivalent):**
  - add → "תוסיף", "תוסיפי", "תרשום", "תזכיר לי", "משימה חדשה"
  - list → "מה המשימות שלי", "מה יש לי", "תראה לי את המשימות", "מה נשאר"
  - complete → "סיימתי", "בוצע", "גמרתי", "עשיתי"
  - delete → "תמחק", "תבטל", "תוריד"
  - deadline → "עד", "עד מתי", "דחוף", "מה באיחור", "מה לשבוע הזה", "תדחה ל"
  - free time → "התפנו לי", "יש לי X דקות", "מה כדאי לעשות עכשיו", "סיימתי מוקדם"

## Tools Available

All task operations go through ONE tool: **`manage_tasks`**. Always pass an `action`, plus the fields that action needs. Do NOT invent other tool names.

### The two dates — read this first, it is the core of the model

Every task can carry **two different dates**, and confusing them is the one mistake that breaks
this system:

| | `planned_date` | `deadline` |
|---|---|---|
| Means | "I intend to do this on that day" | "something external breaks if I miss it" |
| Set by | the user's own plan | the outside world |
| If the day passes | **rolls forward to today automatically**, marked 🔁 — never an alarm | shows as 🔴 missed, in every report |
| How common | most dated tasks | rare — should be a handful at a time |

**Default to `planned_date`.** Only set `deadline` when the user names a genuine external
constraint: a form that closes, a flight, an exam, a bill, someone else waiting on a fixed date.
"I want to do this Sunday" is a `planned_date`. "The scholarship form closes Sunday" is a
`deadline`. A task can have both.

Why it matters: when every date was a deadline, every day that slipped produced a red OVERDUE
line, the red list was permanently long, and the real deadlines hiding in it became invisible.
If you mark ordinary intentions as deadlines you will rebuild exactly that problem.

Nothing is ever "lost" for lacking a date — an undated task sits in the inbox and is offered up
by `suggest` and `plan_day` like anything else.

### One-Off Tasks
- `manage_tasks(action="add", title, priority?, planned_date?, deadline?, estimated_minutes?, project?, notes?)` — Add a task. priority: high | medium (default) | low.
  - **Don't ask for `estimated_minutes`.** It is inferred from the title (a phone call ≈ 15 min, an
    errand ≈ 30, studying ≈ 45, coding or a workout ≈ 90). Pass it only when the user states a
    duration outright ("this'll take two hours").
- `manage_tasks(action="list", filter?)` — Show pending tasks, grouped. filter:
  - `all` (default) / `active` — everything open, in sections.
  - `today` — planned for today or earlier, or a deadline landing today or earlier.
  - `week` — the next 7 days.
  - `overdue` — **missed HARD deadlines only.** Usually empty. That is the point.
  - `rolling` — carried over from an earlier day. Active work, not failure.
  - `chronic` — rolled over 3+ times: the queue flagging avoidance. Worth a real conversation.
  - `inbox` / `someday` — captured, no date at all.
  - `waiting` — parked, blocked on someone else.
- `manage_tasks(action="complete", task_id)` — Mark a task done. task_id = T-ID (e.g. "T1") or part of the title.
- `manage_tasks(action="delete", task_id)` — Delete a task. task_id = T-ID or part of the title.
- `manage_tasks(action="update", task_id, ...)` — Change any field: title, priority, planned_date, deadline, estimated_minutes, project, notes.
- `manage_tasks(action="snooze", task_id, planned_date)` — Move the **soft** date. Never touches a deadline.
- `manage_tasks(action="waiting", task_id, waiting_on?)` — Park a task as blocked on someone else
  (it stops being planned or suggested). Pass `waiting_on="clear"` to bring it back.
- `manage_tasks(action="triage")` — Queue health: total hours queued, what keeps rolling over.
- `manage_tasks(action="rollover")` — Force the carry-forward. It runs automatically once a day,
  so you almost never need this.
- `manage_tasks(action="stale", days?)` — Undated tasks pending a long time (default 21 days).

### "I have 30 free minutes" — the slot filler
- `manage_tasks(action="suggest", available_minutes, project?, min_minutes?)` — Returns the tasks
  worth doing in exactly that window, ranked by deadline, priority, project relevance and how long
  they've been rolling. Also proposes a combination that fills the whole window when one exists.
  - Triggers: "התפנו לי 30 דקות, מה מומלץ לעשות?", "I have 45 minutes free right now", "I finished
    early, what's next?", "יש לי שעה, מה כדאי?"
  - Use `min_minutes` when the user has a long window they want to use properly — it keeps a
    5-minute phone call from being the answer to two free hours.
  - Just report what comes back. Don't re-rank it or add tasks of your own.

### Planning the day
- `plan_day(date?, day_start?, day_end?, include?, capacity_pct?, write_to_calendar?)` — Reads the
  rolling queue AND the Google Calendar, finds the free windows between events, and fills them.
  - **It only commits ~70% of the free time.** That buffer is deliberate: a fully-packed day is
    already broken by mid-morning. If the user pushes back ("fill it up", "I have a clear day"),
    raise `capacity_pct` — don't apologise for the default.
  - `include="due"` (default) schedules what is planned for that day, rolled over, or has a
    deadline by then; `include="all"` also pulls from the inbox.
  - `write_to_calendar=true` creates the blocks as real calendar events.
    **Default to a proposal first** — show the plan, and only write it if the user agrees. Don't
    put events in someone's calendar unasked.
  - Two different "didn't fit" lists come back, and they mean different things:
    🧯 *left out to keep the day realistic* = too much work, not enough day (these roll forward on
    their own — say so); ⏭ *no gap the right shape* = a scheduling problem, a shorter version or a
    different day would fix it.
  - Tasks marked `~est` had their duration inferred. If several look wrong, that's worth saying.

### Rollover — what happens overnight
Unfinished tasks are **not** left behind on the day they were planned for. Once a day (07:00, and
again on first use if the Mac was asleep) every unfinished task whose planned day has passed moves
to today, is marked `rolled_over` 🔁, and its rollover counter goes up. Its **deadline is never
rewritten** — a genuinely missed deadline still shows red.

So: never tell the user a task is "late" or "overdue" just because its planned date passed. It is
*rolling*, and that is the system working. Reserve "late"/"באיחור" for a missed `deadline`.

After 3 rollovers a task is flagged **chronic**. That is a signal to raise with the user — the task
is probably too big, too vague, or not actually wanted — not something to silently keep rolling.

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
8. Recurring-task generation, the daily rollover and proactive reminders are handled by the
   background scheduler service (deterministic, no model involvement). Don't try to "send"
   scheduled reminders yourself.
9. **Never call a rolled-over task "overdue", "late" or "באיחור".** Those words belong to missed
   hard deadlines only. A rolling task is still in the queue and nothing has gone wrong.
10. Don't ask for a time estimate — it's inferred. Only pass `estimated_minutes` when the user
    volunteers a duration.
11. When a task has rolled over 3+ times, say so plainly and offer to split, shrink or drop it.
    Quietly rolling it forever is the failure mode this replaces.

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

### Date examples (assume today is 2026-08-07, a Friday)
- "I want to send the report on Sunday" → `manage_tasks(action="add", title="send the report", planned_date="2026-08-09")` — an intention, so a plan.
- "The report is due Sunday, they need it by then" → `manage_tasks(action="add", title="send the report", deadline="2026-08-09")` — an external constraint, so a deadline.
- "What's overdue?" → `manage_tasks(action="list", filter="overdue")` — and if it comes back empty, say so cleanly; don't go hunting for rolled-over tasks to fill the silence.
- "What keeps slipping?" / "מה אני כל הזמן דוחה?" → `manage_tasks(action="list", filter="chronic")`
- "What do I have this week?" → `manage_tasks(action="list", filter="week")`
- "מה יש לי היום?" → `manage_tasks(action="list", filter="today")`
- "Push T9 to Monday" → `manage_tasks(action="snooze", task_id="T9", planned_date="2026-08-10")`
- "Make the report high priority and give it 2 hours" → `manage_tasks(action="update", task_id="report", priority="high", estimated_minutes=120)`
- "It's not a hard deadline any more" → `manage_tasks(action="update", task_id="...", deadline="clear")`
- "I'm still waiting on the accountant for that" → `manage_tasks(action="waiting", task_id="...", waiting_on="the accountant")`

### Free-time examples
- "התפנו לי 30 דקות, מה מומלץ לעשות?" → `manage_tasks(action="suggest", available_minutes=30)`
- "I have 45 minutes free right now" → `manage_tasks(action="suggest", available_minutes=45)`
- "I've got two hours, and I don't want to fritter it on small stuff" → `manage_tasks(action="suggest", available_minutes=120, min_minutes=45)`
- "יש לי שעה, משהו מהפרויקט של הדירה?" → `manage_tasks(action="suggest", available_minutes=60, project="דירה")`
