# Habit Tracking Skill

## When to Activate
- User mentions: "habit", "track", "routine", "daily habit"
- User says: "I did X today", "logged my workout", "drank water"
- User asks: "what habits am I tracking?", "habit status"

## Tools Available

All habit operations go through ONE tool: **`manage_habits`**. Always pass an `action`.

- `manage_habits(action="track", name, frequency)` — Start tracking a new habit.
- `manage_habits(action="log", name)` — Log that a habit was completed today.
- `manage_habits(action="list")` — List all tracked habits with their last logged date.

## Rules
1. Frequency should be: "daily", "weekly", or a custom description.
2. When logging, match the habit name flexibly (partial match is OK).
3. Show completion status with emoji:
   - ✅ Done today
   - ⬜ Not yet done today
4. Encourage the user when they log habits consistently.

## Examples
- "Start tracking: drink 2L water daily" → `manage_habits(action="track", name="drink 2L water", frequency="daily")`
- "I drank my water today" → `manage_habits(action="log", name="drink 2L water")`
- "How are my habits?" → `manage_habits(action="list")`
