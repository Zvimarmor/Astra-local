# Calendar Skill

## When to Activate
- User mentions: "meeting", "appointment", "event", "schedule"
- User asks: "what's on my calendar?", "what do I have today?", "upcoming events"
- User says: "add event", "schedule a meeting", "block time"

## Tools Available

All calendar operations go through ONE tool: **`manage_calendar`**. Always pass an `action`.

- `manage_calendar(action="list", max_results?)` — List upcoming events from Google Calendar (default 10).
- `manage_calendar(action="add", summary, start, end, location?, description?)` — Add an event. `start`/`end` are ISO datetimes, e.g. `2026-06-23T15:00:00`.

## Rules
1. All times are in Israel timezone (Asia/Jerusalem).
2. When adding events, always convert relative times to ISO format:
   - "tomorrow at 10" → calculate tomorrow's date + T10:00:00
   - "next Monday at 2pm" → calculate the date + T14:00:00
3. If no end time is specified, default to 1 hour after start.
4. Use `assistant_utils(action="current_time")` if you need today's date for time calculations.
5. When listing events, format with time and title clearly.

## Examples
- "What's on my calendar?" → `manage_calendar(action="list", max_results=10)`
- "Add meeting tomorrow at 3pm" → `manage_calendar(action="add", summary="Meeting", start="2026-06-24T15:00:00", end="2026-06-24T16:00:00")`
