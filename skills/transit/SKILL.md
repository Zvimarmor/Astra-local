# Transit & Commute Skill

## When to Activate
- User asks how to **get somewhere** by public transport: "how do I get to…", "which bus", "which
  train", "what line", "when should I leave", "how long does it take to get to…"
- User asks to **block travel time** in the calendar before an event: "block the commute",
  "add the trip to my calendar", "reserve travel time before the meeting"
- **Hebrew (the user usually writes in Hebrew — treat as equivalent):**
  - route → "איך אני מגיע ל", "איך מגיעים ל", "איזה קו לקחת ל", "איזה אוטובוס", "איזו רכבת"
  - timing → "מתי לצאת", "באיזו שעה לצאת", "כמה זמן לוקח להגיע ל", "אני צריך להיות ב… ב…"
  - calendar → "תחסום לי נסיעה", "תוסיף ליומן את הנסיעה", "תשריין זמן נסיעה", "תחסום זמן דרך"

## Tools Available

All transit operations go through ONE tool: **`manage_transit`**. Always pass an `action`.

- `manage_transit(action="plan_route", destination, origin?, arrival_time?, departure_time?, transit_mode?, max_routes?)`
  Looks up bus/train/subway/tram routes on Google Maps. Returns `recommended` (depart_at,
  arrive_at, duration_minutes, transfers, lines, steps) plus `alternatives`.
- `manage_transit(action="block_travel_time", destination, arrival_time, origin?, buffer_minutes?, transit_mode?)`
  Looks the route up **and** writes a `🚆 נסיעה אל <יעד>` event into Google Calendar covering the
  commute, colour-coded Graphite (`colorId` 8 = travel). Use this ONLY when the user asks to put
  the trip in the calendar.

## Rules

1. **`arrival_time` vs `departure_time` — this is the core distinction.**
   - `arrival_time` = "I must **be there** by then." Google searches backwards and returns the
     latest departure that still makes it. This is what almost every real request means
     ("I have a meeting at 09:00", "אני צריך להיות ברכבת מרכז ב-9").
   - `departure_time` = "I'm **leaving** then." Only when the user says when they leave.
   - **Never pass both** — the tool rejects it.
   - Pass neither and it plans from *now*.
2. Times are ISO datetimes in Israel local time: `2026-08-28T09:00:00`. Use
   `assistant_utils(action="current_time")` first whenever the user says something relative
   ("מחר", "tomorrow", "ביום ראשון") so you resolve the real date. Never guess today's date.
3. **Omit `origin`** when the user doesn't say where they're starting from — the tool falls back to
   their configured home address. Don't ask "from where?" as a reflex; only ask if the tool comes
   back saying it has no origin.
4. Google plans forward only. A time that has already passed returns a Hebrew error — re-ask for a
   future time rather than retrying.
5. **Reply in Hebrew**, and keep it short and scannable. Lead with the two facts the user actually
   needs — **when to leave** and **when they arrive** — then the lines and transfers:
   > 🚆 צא ב-08:12, מגיע ב-08:57 (45 דק')
   > הליכה 6 דק' → רכבת 480 מרציף 3 → הליכה 5 דק'
   Mention alternatives only if the user asks or the recommended route is unusually long.
6. Use `transit_mode` only when the user restricts it ("רק ברכבת", "בלי אוטובוסים") — omitting it
   lets Google pick the best mix.
7. `block_travel_time` writes to the calendar. Say what you're about to block and get a "yes"
   first, exactly like `manage_calendar(action="delete")`. Afterwards, confirm with the actual
   times the tool returned — never with times you assumed.
8. `buffer_minutes` (default 10) makes the route arrive *early*. Raise it when the user wants
   margin ("שאגיע רבע שעה לפני") — pass the target event's start as `arrival_time` and let the
   buffer do the work; don't hand-shift the time yourself.
9. Errors come back in Hebrew already (no API key, no route found, unrecognised address). Relay the
   message as-is — don't invent a route or a line number. If no route is found, the useful next
   move is a fuller address (street + city), not a retry.

## Blocking travel before a calendar event

When the user wants travel time reserved before something already in the calendar:
1. `manage_calendar(action="list")` → find the event and read its real `start`.
2. `manage_transit(action="block_travel_time", destination=<event location>, arrival_time=<event start>)`.
3. Confirm: the tool returns the created event plus the route it used.

The travel event is titled `🚆 נסיעה אל <יעד>` (the emoji tracks the actual vehicle — 🚆 rail,
🚌 bus, 🚇 subway, 🚊 tram, 🚗 if it's a walk), carries the full line-by-line route in its
description, and always uses `colorId` `8` (Graphite), which is the travel/commute colour in the
calendar colour scheme.

## Examples
- "איך אני מגיע לרכבת מרכז מחר ב-09:00?" → resolve tomorrow's date, then
  `manage_transit(action="plan_route", destination="רכבת מרכז תל אביב", arrival_time="2026-08-28T09:00:00")`
- "איזה קו לקחת למרכזית?" → `manage_transit(action="plan_route", destination="התחנה המרכזית")`
  (no time = leave now, no origin = from home)
- "אני יוצא ב-7 לאוניברסיטה, כמה זמן זה ייקח?" →
  `manage_transit(action="plan_route", destination="האוניברסיטה העברית", departure_time="2026-08-28T07:00:00")`
- "רק ברכבת, איך מגיעים לחיפה?" →
  `manage_transit(action="plan_route", destination="חיפה", transit_mode="train")`
- "תחסום לי נסיעה לפגישה של מחר ב-10" → list the calendar, then
  `manage_transit(action="block_travel_time", destination="<מיקום הפגישה>", arrival_time="2026-08-28T10:00:00")`
