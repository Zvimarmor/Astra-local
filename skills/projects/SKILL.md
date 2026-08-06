# Projects / Missions Skill

A **project** (the user often says "mission", or in Hebrew "משימה גדולה" / "פרויקט") is a named
objective with a target date that owns several tasks. Use it when the user talks about a bigger
goal rather than a single to-do.

## When to Activate
- User describes a multi-step goal: "I need to prepare for the dynamics exam", "the poster
  presentation for Dina", "sorting out the garden"
- User asks about progress: "how's the exam going?", "how much is left?", "am I on track?"
- User wants a goal split up: "break this down", "what are the steps?", "make me a plan for it"
- User sets a deadline for a whole objective: "the exam is on the 20th"
- **Hebrew:**
  - project/mission → "פרויקט", "משימה גדולה", "מטרה", "יעד"
  - progress → "מה ההתקדמות", "כמה נשאר", "איך אני מתקדם", "כמה סיימתי"
  - breakdown → "תפרק לי את זה", "מה השלבים", "תכין לי תוכנית"

## Tools Available

All project operations go through ONE tool: **`manage_projects`**. Always pass an `action`.

- `manage_projects(action="add", name, target_date?, description?)` — Create a project. `target_date` is `YYYY-MM-DD`.
- `manage_projects(action="list", include_completed?)` — All active projects with progress and days left.
- `manage_projects(action="status", project)` — One project plus its remaining tasks. `project` = name (partial ok) or numeric id.
- `manage_projects(action="breakdown", project, tasks)` — Create several tasks under the project at once. `tasks` is an array of `{title, due_date?, estimate_minutes?, priority?}`.
- `manage_projects(action="complete", project)` — Mark the whole project finished.
- `manage_projects(action="delete", project)` — Delete the project. **Its tasks are kept**, just unfiled.

To file a *single* new task under a project, use the task tool instead:
`manage_tasks(action="add", title="...", project="Dynamics exam")`.

## Rules
1. **Progress is computed from the linked tasks** — you never set it. `2/7 done` means 2 of the 7
   tasks pointing at that project are Completed. So the way to move a project forward is to
   complete its *tasks*.
2. `target_date` and task `due_date` must both be absolute `YYYY-MM-DD`. You know today's date —
   resolve "the 20th" or "next Thursday" yourself.
3. When the user describes a goal with obvious steps, offer a `breakdown` rather than creating one
   vague task. Give each step a realistic `estimate_minutes` — that's what makes day planning work
   later.
4. Don't create a project for something that is genuinely one action. A project with one task is
   just a task.
5. If several existing tasks share a prefix like `"לסדר בחוץ: ..."`, that's a project the user
   built by hand. Offer to turn it into a real project and move those tasks into it (create the
   project, then `manage_tasks(action="update", task_id=..., project=...)` for each).
6. Report exactly what the tool returns. Never claim progress you didn't read back.

## Examples
- "I have a dynamics exam on August 20th" → `manage_projects(action="add", name="Dynamics exam", target_date="2026-08-20")`
- "Break the exam down into study sessions" →
  `manage_projects(action="breakdown", project="Dynamics exam", tasks=[{title:"Review chapter 4", estimate_minutes:90, due_date:"2026-08-10"}, {title:"Past paper 2024", estimate_minutes:120, due_date:"2026-08-14"}, ...])`
- "How's the exam project going?" → `manage_projects(action="status", project="Dynamics exam")`
- "What am I working on overall?" → `manage_projects(action="list")`
- "Add 'print the poster' to the Dina presentation" → `manage_tasks(action="add", title="print the poster", project="Dina")`
- "The garden stuff is done" → `manage_projects(action="complete", project="garden")`
