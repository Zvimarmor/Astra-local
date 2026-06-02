# Calendar Skill

## When to Activate
- User mentions: "meeting", "appointment", "event", "schedule"
- User asks: "what's on my calendar?", "what do I have today?", "upcoming events"
- User says: "add event", "schedule a meeting", "block time"

## Tools Available
- `list_calendar_events(maxResults)` — List upcoming events from Google Calendar.
- `add_calendar_event(summary, startDateTime, endDateTime, location, description)` — Add a new calendar event.

## Rules
1. All times are in Israel timezone (Asia/Jerusalem).
2. When adding events, always convert relative times to ISO format:
   - "tomorrow at 10" → calculate tomorrow's date + T10:00:00
   - "next Monday at 2pm" → calculate the date + T14:00:00
3. If no end time is specified, default to 1 hour after start time.
4. Use `get_current_time` if you need today's date for time calculations.
5. When listing events, format with time and title clearly.

## Examples
- "What's on my calendar?" → `list_calendar_events(10)`
- "Add meeting tomorrow at 3pm" → `add_calendar_event("Meeting", "2026-06-03T15:00:00", "2026-06-03T16:00:00")`
