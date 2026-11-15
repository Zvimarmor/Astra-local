# Nutrition Tracking Skill (the user's own)

## When to Activate
- The user says what he ate or drank: "אכלתי כריך סביח בארומה", "שתיתי הפוך גדול", "ארוחת צהריים: שניצל ואורז".
- He asks about his intake: "כמה קלוריות אכלתי היום?", "כמה חלבון נשאר לי?", "סיכום תזונה".
- He gives nutrition values himself: "תרשום 450 קלוריות, 30 חלבון, 40 פחמימות, 15 שומן".
- He wants Astra to remember a food: "תזכרי שהכריך הקבוע שלי בארומה הוא…".
- A workout ("רצתי 40 דקות") or a weigh-in.

Not this skill: expenses ("שילמתי 40 בארומה" is money → `manage_finances`). If one message has both
("אכלתי בארומה ב-48 ש״ח"), do both.

## Tool: `manage_nutrition`
- **First use:** `get_profile`. If it returns `needs_onboarding`, ask once for height, weight and age
  (and lose/maintain/gain), then call `set_profile` with `sex="male"`. Don't ask again later.
- **Daily status:** `today` shows calories, protein, carbs and fat so far. `report` returns the Hebrew
  daily summary; send it as is.

## Logging food: which numbers to use, in this order
1. **Numbers he gave.** If he says the values, use them exactly. Never "correct" them.
2. **A saved food.** If it sounds like something he eats often, call `list_foods` (once per conversation
   is enough), then `log_food(saved_food=<name>, servings=…)`. "חצי כריך" is `servings=0.5`.
3. **Aroma (ארומה).** Aroma publishes calories per item on its website (aroma.co.il). Search for it:
   `web_search` with a query like `aroma.co.il <item name in English> calories` or
   `ארומה <שם המנה> ערכים תזונתיים`. Use a figure only if the result is clearly Aroma's own page or quotes
   it for that exact item. Aroma's figures are per **whole** item and depend on the bread, so ask which
   bread if it matters. Third-party apps (MyFitnessPal etc.) are user-submitted and often conflict; treat
   them as an estimate.
4. **Your estimate.** If nothing reliable turned up, estimate calories, protein, carbs and fat from
   typical portions, and say plainly that it's an estimate ("הערכה: ~520 קק״ל, 25ג׳ חלבון…").

After logging an Aroma item or a regular meal from steps 3–4, offer once: "לשמור את זה כמאכל קבוע עם
הערכים האלה?". If he agrees or corrects the numbers, call `save_food` with `source` (aroma.co.il / user /
estimate) and `serving` (e.g. "כריך שלם, לחם דגנים"). Next time step 2 makes it exact and instant.

**Manual values for an unknown food:** if you don't recognise a food, ask for the values (calories,
protein, carbs, fat; any of them is fine), log them, and offer to save them.

## Reply format
One short line per log, then the day so far:
`✅ נרשם: כריך סביח (ארומה) — 574 קק״ל · חלבון 22ג׳ · פחמ׳ 60ג׳ · שומן 26ג׳`
`היום עד עכשיו: 1,240 קק״ל · חלבון 68ג׳ · פחמ׳ 130ג׳ · שומן 45ג׳ (נשארו ~900)`
- Say where the numbers came from when they're not exact: (הערכה) / (מהאתר של ארומה) / (מאכל שמור).
- If the tool returns `warning`, include it.
- Mistakes: `delete_entry(kind="food")` removes the last entry; with `entry_id` a specific one.

## Rules
- Never invent a "published" figure. If you didn't actually find Aroma's number, it's an estimate.
- Hebrew, masculine forms.
- No diet advice or comments about his body. Numbers only, unless he asks.
