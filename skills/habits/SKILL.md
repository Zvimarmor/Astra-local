# Habit Tracking Skill

## When to Activate
- User mentions: "habit", "track", "routine", "daily habit"
- User says: "I did X today", "logged my workout", "drank water"
- User asks: "what habits am I tracking?", "habit status"

## Tools Available
- `track_habit(name, frequency)` — Start tracking a new habit.
- `log_habit(name)` — Log that a habit was completed today.
- `list_habits()` — List all tracked habits with their last logged date.

## Rules
1. Frequency should be: "daily", "weekly", or a custom description.
2. When logging, match the habit name flexibly (partial match is OK).
3. Show completion status with emoji:
   - ✅ Done today
   - ⬜ Not yet done today
4. Encourage the user when they log habits consistently.

## Examples
- "Start tracking: drink 2L water daily" → `track_habit("drink 2L water", "daily")`
- "I drank my water today" → `log_habit("drink 2L water")`
- "How are my habits?" → `list_habits()`
