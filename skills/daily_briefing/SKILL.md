# Daily Briefing Skill

> NOTE: The **proactive** 08:00 morning and 20:00 evening briefings are sent automatically by
> the background scheduler service (`dist-services/scheduler.js`), built deterministically from
> SQLite — NOT by you. This skill is for **on-demand** briefings when the user asks for one in
> chat. The format below mirrors what the scheduler sends (see `services/report-format.ts`), so
> on-demand answers feel consistent with the scheduled ones.

## When to Activate
- User asks: "סיכום יומי", "מה יש לי היום?", "בריפינג", "daily summary", "what's on for today?"

## Tools Available
- `assistant_utils(action="daily_status")` — Get pending tasks and uncompleted habits.
- `manage_calendar(action="list", max_results?)` — Get today's calendar events.
- `manage_finances(action="expense_summary", period?)` — Get recent expense totals.
- `manage_finances(action="budget_alerts")` — Check budget status.
- `manage_finances(action="financial_overview", period?)` — Get income vs expense snapshot.
- `assistant_utils(action="current_time")` — Get today's date.

## Red is rare — never call a rolled-over task late

The 🔴 block holds **only tasks that blew a real external `deadline`**, and most days it is empty.
Work the user simply hasn't got to yet appears under 🔁 *ממשיכות איתנו להיום* — it rolled forward
automatically and nothing has gone wrong. Never describe those as "באיחור", "late" or "overdue";
that wording is reserved for the red block, and spending it on ordinary rollovers is what made the
old briefing's red list unreadable.

The one thing worth flagging is the ⚠️ chronic list (3+ rollovers): say it plainly and suggest
splitting, shrinking or dropping the task.

## Language: Hebrew only
Every briefing is written **entirely in Hebrew** — headers, statuses and priorities included.
Never mix English headers with Hebrew task titles. Fixed translations:

| Meaning | Use |
|---|---|
| Missed hard deadline | דד-ליינים שעברו |
| Deadline today / tomorrow | דד-ליין היום / דד-ליין מחר |
| Rolled over from an earlier day | ממשיכות איתנו להיום |
| Chronically postponed (3+ rollovers) | נדחות שוב ושוב |
| Pending tasks | משימות פתוחות |
| Habits to do today | הרגלים להיום / הרגלים יומיים |
| high / medium / low | דחוף / בינוני / רגיל |

Priority is shown as a **group header** (🔴 דחוף / 🟡 בינוני / ⚪ רגיל), never repeated as a tag on
every line — that just adds visual noise.

## Morning Briefing Format (08:00)
```
☀️ *בוקר טוב צבי! סיכום יומי — YYYY-MM-DD*

📌 *לאורך כל היום:*        ← only if there are all-day events
• [שם האירוע]

📅 *לו״ז להיום:*
• HH:MM — [שם האירוע]

⏰ *דד-ליינים ומשימות קריטיות:*   ← only if there is anything here
🔴 *דד-ליינים שעברו* (N):        ← REAL missed deadlines only. Usually absent.
• [שם המשימה] (הדד-ליין היה YYYY-MM-DD, לפני X ימים) (T12)
📌 *דד-ליין היום* (N):
• [שם המשימה] (T13)
🎯 *פרויקטים לקראת יעד:*
• [שם הפרויקט] (2/5 הושלמו) — נותרו 3 ימים

🔁 *ממשיכות איתנו להיום (N):*     ← rolled over from earlier days. NOT late.
• [שם המשימה] 🔁 נדחתה מאתמול (T14)
⚠️ *נדחו 3 פעמים ומעלה (N) — שווה לפצל, להקטין או לוותר:*
• [שם המשימה] (T15)

✅ *משימות פתוחות נוספות (N):*
🟡 *בינוני* (N):
• [שם המשימה] (T14)

🔁 *הרגלים להיום (N):*
• [שם ההרגל]

💰 *תמונת מצב כספית (החודש):*
• הכנסות: X ₪ · הוצאות: Y ₪ · מאזן: ±Z ₪

⚠️ *התראות תקציב:*          ← only if something is breached or at risk
🔴 [קטגוריה]: X ₪ מתוך Y ₪ — חריגה של Z ₪

💪 *שיהיה יום מוצלח ומלא עשייה!*
```

## Evening Summary Format (20:00)
```
🌙 *סיכום ערב — YYYY-MM-DD*

📅 *לו״ז למחר:*
• HH:MM — [שם האירוע]

⏰ *דד-ליינים:*   (🔴 *דד-ליינים שעברו* / 📌 *דד-ליין מחר*)

🔁 *ממשיכות איתנו להיום (N):*   ← whatever didn't get done today rolls into tomorrow by itself

✅ *משימות פתוחות נוספות (N):*  ← grouped by priority

🔁 *הרגלים יומיים (2/6 הושלמו):*
✅ / ⬜ [שם ההרגל] — רצף של X ימים

💰 *כספים:*
• הוצאות השבוע: X ₪
• מאזן החודש עד כה: ±Y ₪

😴 *לילה טוב ומנוחה נעימה!*
```

## Rules
1. Call all relevant tools to build a complete picture (`assistant_utils action="daily_status"`, `manage_calendar action="list"`, the `manage_finances` actions).
2. **Never truncate.** Do not write "ועוד 4 משימות" / "and X more" — list every open task. Long
   lists stay readable through priority grouping and short lines, not by hiding rows.
3. **All-day events** (and anything starting at 00:00) go under `📌 לאורך כל היום:` at the top of
   the agenda — never render them as `00:00 — [event]`.
4. Task ids go in parentheses at the **end** of the line, never at the start: a line beginning with
   an LTR token renders with the bullet on the wrong side in a Hebrew message.
5. Deadlines are part of the morning briefing — it is the single source of truth for the day. Do not
   send a separate deadlines message.
6. If there are no events or tasks, say so positively ("אין אירועים בלו״ז היום.", "אין משימות פתוחות — לוח נקי! 🎉").
7. Only show budget alerts when there are actual warnings or overages; only show the financial
   snapshot when there is at least one expense or income entry.
