# Shared Household

**Live since 2026-11-10.** The owner (Zvi) and his roommate (Michal) share expenses, a balance
and a shopping list through Astra. Each of them talks to Astra in their own WhatsApp chat. Michal
reaches a separate agent, `house`, built like the guest agent in `GUEST-AGENT.md`: its own
workspace, its own MCP process, and one tool.

## Pieces

| Piece | Where |
|---|---|
| Store and rules | `tools/household.ts` (own SQLite handle on `data/memory.db`) |
| Tool, pinned to one person | `tools/household-tools.ts` → `makeHouseholdTool(actor)` |
| Owner's tool | `manage_household` in `registry/mega-tools.ts`, acting as `zvi` |
| Roommate's tool | `registry/household-profile.ts`, served when `ASTRA_PROFILE=household`, acting as `michal` |
| Scheduler | `household_monthly_digest`, `household_bill_check` and the outbox delivery in `services/scheduler.ts` |
| Skill | `skills/household_management/SKILL.md`, copied to **both** `~/.openclaw/workspace/skills/` and `~/.openclaw/workspace-house/skills/` |
| Tests | `npm run test:household` (throwaway DB, sends nothing) |

Tables: `household_expenses`, `household_settlements`, `household_shopping_list`, `household_outbox`,
`household_settings`.

## Rules

- **Balance.** Every approved expense is split 50/50. `computeBalance()` returns how much Michal owes
  Zvi (negative means Zvi owes Michal): half of (Zvi paid − Michal paid), minus what Michal has
  transferred to Zvi, plus what Zvi has transferred to her. Pending and rejected expenses don't count.
- **Balance alert.** When the debt goes past ₪400 (`HOUSEHOLD_BALANCE_ALERT`), both of them get a
  message. A debt that just stays above ₪400 doesn't re-alert on every expense. It alerts again when the
  debt flips direction or grows past the next ₪400 step (₪800, ₪1,200…).
- **Approval.** A single expense over ₪500 (`HOUSEHOLD_APPROVAL_THRESHOLD`), a plumber, or
  `major_repair=true` is stored as `pending_approval`. The person who did *not* enter it is asked to
  approve. Only that person can approve or reject it, and it enters the balance only once approved.
- **Shopping list.** Every item needs a quantity. `parseShoppingItems()` reads "2 חלב 3%", "שתי
  קופסאות טונה", "קרטון ביצים", "במבה x3". An item without one ("חלב") isn't added: the tool returns
  `needs_clarification` and the skill makes the model ask. Logging a supermarket expense returns the
  open list so the model can offer to mark items as bought.
- **Bill reminder.** From the 15th of a month a bill is expected in, if no expense with that
  `bill_type` is logged that month, both get e.g. "לא נרשם תשלום אינטרנט החודש, תרצו שאזין סכום?".
  Expected months are set per bill in `.env` (`HOUSEHOLD_BILL_MONTHS_<BILL>`); unset means no reminder.
  Currently configured: internet (Partner wifi, ₪94) every month; electricity, water and arnona are not
  paid by them. Sent once a month.
- **Monthly digest.** On the 1st at 10:00 (or the first non-quiet day up to the 7th), both get last
  month's total, the category breakdown, what each paid, the carried-over balance, and any pending
  approvals.

## Identity is not the model's choice

`makeHouseholdTool(actor)` closes over the person. The tool has no "who am I" parameter, so a prompt
can't make Michal's agent act as Zvi. The two gates on this are:

1. Tool policy. `house` is `profile: minimal` with `alsoAllow: ["astra-household-tools__*"]`, so the
   owner's `astra-tools__manage_household` (acting as Zvi) is stripped from her session along with all
   his other tools. `main` and `gf` both deny `astra-household-tools__*`, because that server acts as
   Michal.
2. Process. Her MCP process loads only `config`, `household`, `household-tools` and the registry
   (checked by the test). An unknown `ASTRA_PROFILE` value serves no tools at all.

## Messages: queued, not sent

The tools have no send path. They insert rows into `household_outbox` with the recipient decided in
code, and the scheduler delivers them on its 60-second tick:

- Held through quiet hours (night, Shabbat) like other proactive messages; expired after 48h.
- To Zvi: `notifyOwner` (WhatsApp, then Telegram/email).
- To Michal: her WhatsApp only (`HOUSEHOLD_ROOMMATE_TARGET`). A failed row is retried 5 times; then
  Zvi is told it didn't reach her.
- With `HOUSEHOLD_ENABLED` off, nothing is queued, so turning it on later doesn't release a backlog.

## Operating it

Her first message needs pairing approval (`dmPolicy: pairing`):

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

After editing the skill, copy it to both workspaces:

```bash
cp skills/household_management/SKILL.md ~/.openclaw/workspace/skills/household_management/
cp skills/household_management/SKILL.md ~/.openclaw/workspace-house/skills/household_management/
```

Test a turn without WhatsApp (read-only question, so nothing is queued):

```bash
openclaw agent -m "מה יש ברשימת הקניות של הבית?" --agent house
```

Turn off: set `HOUSEHOLD_ENABLED=false` and `launchctl kickstart -k gui/501/com.astra.scheduler`
(stops all household messages), and remove her two bindings to cut her chat off.

## Not done

- The list isn't mirrored to Google Tasks. A Google Tasks list lives in one Google account and can't be
  shared, so Michal couldn't see it. SQLite is the shared list.
- Split is always 50/50. There is no per-expense custom split.
