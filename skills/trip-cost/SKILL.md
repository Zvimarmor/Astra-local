# Car Trip Fuel Cost Skill

## When to Activate
- User asks what a **car trip will cost in fuel**: "how much will it cost to drive to…",
  "fuel cost to…", "how much petrol/gas to get to…"
- **Hebrew (the user usually writes in Hebrew — treat as equivalent):**
  "כמה יעלה לי לנסוע ל…", "תחשבי עלות דלק ל…", "כמה דלק ייקח לי להגיע ל…",
  "כמה עולה נסיעה ברכב ל…", "כמה אשלם על דלק ל…"
- NOT for public transport ("איך מגיעים באוטובוס…") — that is `manage_transit(action="plan_route")`
  from the transit skill.

## Tool

One action on the transit tool:

`manage_transit(action="calculate_trip_cost", destination, origin?, round_trip?, fuel_type?, traffic_level?, car_consumption_km_per_l?, ac_level?, price_per_liter?)`

| param | default | notes |
|---|---|---|
| `destination` | — required | address or place name |
| `origin` | user's home address | omit unless the user names a start point |
| `round_trip` | `false` | `true` doubles the distance |
| `fuel_type` | `'95'` | `'95'` or `'diesel'` (סולר) |
| `traffic_level` | live | `'heavy'` / `'normal'` only if the user says so; omit → Google's live traffic right now |
| `car_consumption_km_per_l` | `13` | only if the user states their car's economy |
| `ac_level` | `'auto'` | `'0'`/`'1'`/`'2'`; auto = by season (summer 2, spring/autumn 1, winter 0) |
| `price_per_liter` | looked up | only if the user states a price they paid |

The model: litres = km ÷ km/l × (1 + AC% + traffic%); AC adds 0/6/12%, heavy traffic adds 18%.
The 95 price is the regulated price from the latest gov.il update; diesel is unregulated, so its
price is approximate.

## Conversational policy

1. **Ambiguous place → ask first.** If the destination (or a named origin) could be several places
   ("לקניון", "לסבתא", "לים", a street with no city), ask which one before calling the tool. Don't
   guess an address. A plain city or a well-known place is fine as-is.
2. **One-way or round trip?** If the user didn't say, ask once:
   "האם מדובר בנסיעה לכיוון אחד או הלוך-חזור?" — unless it's obvious from the wording
   ("לנסוע ולחזור", "הלוך ושוב" → round trip; "רק להגיע" → one way).
3. Don't interrogate about the rest. Fuel type, consumption, AC and traffic all have sensible
   defaults — use them and state them in the answer, so the user can correct you.
4. **Always state the assumptions.** Lead with the cost, then list the tool's `assumptions`:
   total distance, effective consumption, AC level (and that it was set by season), traffic,
   price per litre. Example:
   > ⛽ כ-85 ₪ הלוך-חזור לתל אביב (כ-11 ליטר בנזין 95)
   > • מרחק כולל: 134.7 ק"מ (67.3 לכל כיוון)
   > • צריכה מחושבת: 12.3 ק"מ/ליטר (בסיס 13, +6% מזגן)
   > • מזגן: דרגה 1 לפי העונה
   > • תנועה: רגילה כרגע
   > • מחיר לליטר: 7.77 ₪ (מחיר מפוקח, בתוקף מ-5.10)
   > רוצה שאעדכן לפי צריכת הדלק של הרכב שלך?
5. **Never present a fallback price as today's price.** If `fuel.verified_live` is `false`, say the
   price is a default estimate that couldn't be verified. For diesel, say the price is approximate.
6. Round the headline cost to whole shekels; keep the detailed numbers in the assumptions.
7. Errors come back in Hebrew already (no API key, address not found). Relay them; if an address
   wasn't recognised, ask for a fuller one (street + city) rather than retrying the same thing.

## Examples
- "כמה יעלה לי לנסוע לחיפה?" → ask one-way or round trip, then
  `manage_transit(action="calculate_trip_cost", destination="חיפה", round_trip=true)`
- "תחשבי עלות דלק לאילת הלוך-חזור, הרכב שלי עושה 16 לליטר" →
  `manage_transit(action="calculate_trip_cost", destination="אילת", round_trip=true, car_consumption_km_per_l=16)`
- "כמה סולר ייקח לי להגיע מתל אביב לירושלים בפקקים?" →
  `manage_transit(action="calculate_trip_cost", origin="תל אביב", destination="ירושלים", fuel_type="diesel", traffic_level="heavy")`
- "כמה דלק ייקח לי להגיע לקניון?" → "לאיזה קניון?" first.
