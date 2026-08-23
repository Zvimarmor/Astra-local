# Calendar Skill

## When to Activate
- User mentions: "meeting", "appointment", "event", "schedule"
- User asks: "what's on my calendar?", "what do I have today?", "upcoming events"
- User says: "add event", "schedule a meeting", "block time"
- User says: "cancel", "delete", "remove" about a meeting/appointment/event

## Tools Available

All calendar operations go through ONE tool: **`manage_calendar`**. Always pass an `action`.

- `manage_calendar(action="list", max_results?)` — List upcoming events from Google Calendar (default 10).
- `manage_calendar(action="add", summary, start, end, location?, description?, colorId?)` — Add an event. `start`/`end` are ISO datetimes, e.g. `2026-06-23T15:00:00`.
- `manage_calendar(action="delete", event_id)` — Delete an event. `event_id` is either the `id` from `action="list"` or part of the event title.

## Rules
1. All times are in Israel timezone (Asia/Jerusalem).
2. When adding events, always convert relative times to ISO format:
   - "tomorrow at 10" → calculate tomorrow's date + T10:00:00
   - "next Monday at 2pm" → calculate the date + T14:00:00
3. If no end time is specified, default to 1 hour after start.
4. Use `assistant_utils(action="current_time")` if you need today's date for time calculations.
5. When listing events, format with time and title clearly.
6. Deleting is irreversible: say which event you are about to delete and get a "yes" before calling `action="delete"`.
   If the tool returns `status="ambiguous"`, do NOT retry blindly — show the returned events and ask which one, then
   call again with that event's `id`.
7. When adding an event, always pick a `colorId` from context — never leave it blank:
   - `9` (Blueberry, default) meetings/syncs · `11` (Tomato) deadlines/exams/critical · `3` (Grape) focused work/coding
   - `2` (Sage) — STRICT: any event involving Einav/עינב · `10` (Basil) — STRICT: army/reserve duty/מילואים/צו
   - `6` (Tangerine) gym/sports/health · `5` (Banana) birthdays/celebrations/family · `1` (Lavender) parties/leisure
   - `8` (Graphite) travel/commute/errands
   The Einav and army rules win over every other category if more than one could apply.

## Examples
- "What's on my calendar?" → `manage_calendar(action="list", max_results=10)`
- "Add meeting tomorrow at 3pm" → `manage_calendar(action="add", summary="Meeting", start="2026-06-24T15:00:00", end="2026-06-24T16:00:00", colorId="9")`
- "Add date night with Einav Friday 8pm" → `manage_calendar(action="add", summary="Date night with Einav", start="2026-06-26T20:00:00", end="2026-06-26T22:00:00", colorId="2")`
- "Add reserve duty next Sunday" → `manage_calendar(action="add", summary="מילואים", start="2026-06-28T08:00:00", end="2026-06-28T18:00:00", colorId="10")`
