# Astra — Future Roadmap

> Planning doc. Written 2026-06-23. **Read this first**, then start coding.
> Nothing here is built yet. This is the agreed design for the next feature wave.

---

## Phase 1 — Proactive Scheduler ("the heartbeat that actually beats") ✅ DONE (2026-06-23)

> **Shipped.** `services/scheduler.ts` → `dist-services/scheduler.js`, running under launchd
> `com.astra.scheduler`. Deterministic Telegram pushes, `schedules`/`schedule_runs` tables,
> quiet hours (night + Shabbat), fire-late-once catch-up. Verified end-to-end (Telegram
> message_id 222) and idempotency confirmed. The notes below are the as-built design.



### The problem we're solving

Astra already has all the **content** for time-based automation, but **nothing triggers it**.
Every `SKILL.md` says *"when the scheduler triggers the 7 AM heartbeat…"* — but there is no
scheduler. Verified 2026-06-23:

- ❌ No `crontab` entries
- ❌ No launchd agent for scheduling (only `gateway`, `dashboard`, `whatsapp-listener`)
- ❌ No `cron`/`heartbeat` block in `~/.openclaw/openclaw.json`
- ❌ No `setInterval` in any service
- ❌ OpenClaw exposes **no native cron** to the agent in this config
  (`reminders.add` on line 41 of openclaw.json is an Apple-Reminders node command that is *denied*, not a scheduler).

**Consequence today:** recurring tasks never auto-generate, no briefing ever arrives unless
the user asks, budget alerts never fire, email digests never send.

### What already exists and will be REUSED (do not rewrite)

| Capability | Code | Notes |
|---|---|---|
| Recurring task generation | `generateDueRecurringTasks()` in `tools/storage.ts` | **Pure DB logic, zero LLM.** Already idempotent via `last_generated_date`. |
| Daily status (tasks + habits) | `dailyStatusTools.get_daily_status` in `tools/daily-status.ts` | Returns pending tasks + uncompleted habits. |
| Email digest | `emailDigestTools.get_email_digest` in `tools/email-digest.ts` | Read-only IMAP envelope summary. |
| Budget alerts | `tools/budget.ts` | Only surfaces warnings/overages. |
| Expense/financial summary | `tools/expenses.ts`, `tools/budget.ts` (via `manage_finances`) | |
| Briefing format/spec | `skills/daily_briefing/SKILL.md` | The exact morning/evening message layout to mirror deterministically. |
| Timezone | `config.timezone` = `Asia/Jerusalem` | |

---

### Decisions (locked in 2026-06-23)

1. **Schedule source → SQLite table + sensible defaults.** A `schedules` table, seeded with
   defaults, editable later (chat/dashboard) without code changes.
2. **Message engine → Deterministic.** Node reads the DB and formats the message itself.
   No LLM in the loop for Phase 1. Rationale: cannot hallucinate ("I sent it" while sending
   nothing — the exact bug we just fixed), runs even if Ollama is cold/asleep, reuses existing
   content code. (Hybrid/LLM phrasing is a Phase 2 option, see below.)
3. **Quiet hours → Night + Shabbat.** Silent 22:00–07:00 daily, AND Friday sunset → Saturday
   night. Fits `Asia/Jerusalem`.
4. **Missed jobs → Fire late, once.** If the machine was asleep/off at fire time, run the
   missed job when it wakes — but only once per calendar day per job (idempotent via a sent-log).

---

### Architecture

```
launchd (com.astra.scheduler) ─► dist-services/scheduler.js
        │  wakes every 60s
        │  reads data/memory.db: schedules + per-job content tables
        │  for each DUE job not already sent today, and not in quiet hours:
        │      build message deterministically (reuse tools/* content fns)
        │      mark sent in schedule_runs
        ▼
   Telegram Bot API  sendMessage  ──►  owner chat (telegram id 1005480492)
```

- New file: **`services/scheduler.ts`** → builds to `dist-services/scheduler.js` (same
  `build:services` target as dashboard/whatsapp-listener; `rootDir ./services`).
- New launchd plist: **`~/Library/LaunchAgents/com.astra.scheduler.plist`** (model on the two
  existing `com.astra.*` plists). `RunAtLoad` + `KeepAlive`. The 60s tick is internal
  (`setInterval`), so KeepAlive just restarts it if it crashes.
- **Send path:** direct Telegram Bot API call
  (`https://api.telegram.org/bot<TOKEN>/sendMessage`). This bypasses the model and the
  gateway entirely — most reliable. (Alternative considered: POST to the OpenClaw gateway so
  the message "comes from Astra" via the LLM — rejected for Phase 1 due to 8B unreliability.)

#### Config additions (`tools/config.ts`)

Add a `scheduler` / `telegram` block, read from `.env` (never hardcode the token):

```
TELEGRAM_BOT_TOKEN=...        # currently only in ~/.openclaw/openclaw.json — copy into .env
TELEGRAM_OWNER_CHAT_ID=1005480492
SCHEDULER_TICK_SECONDS=60
SCHEDULER_QUIET_NIGHT_START=22   # 22:00
SCHEDULER_QUIET_NIGHT_END=7      # 07:00
```

> ⚠️ The bot token lives in `openclaw.json` today. Copy it into `.env` (gitignored). Add the
> new vars to `.env.example` as blank templates. Do **not** commit the real token.

---

### Database schema (add to `tools/storage.ts`)

```sql
-- The schedule definitions (seeded with defaults, editable later)
CREATE TABLE IF NOT EXISTS schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job           TEXT NOT NULL,        -- 'recurring_gen' | 'morning_briefing' |
                                        -- 'budget_check' | 'email_digest' |
                                        -- 'evening_review'
    hour          INTEGER NOT NULL,     -- local hour 0-23 (Asia/Jerusalem)
    minute        INTEGER NOT NULL DEFAULT 0,
    days          TEXT NOT NULL DEFAULT 'daily', -- 'daily' | csv of 0-6 (0=Sun)
    enabled       INTEGER NOT NULL DEFAULT 1,
    catch_up      INTEGER NOT NULL DEFAULT 1,     -- fire-late-once if missed
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency / "fire once per day" log
CREATE TABLE IF NOT EXISTS schedule_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id   INTEGER NOT NULL,
    run_date      TEXT NOT NULL,        -- 'YYYY-MM-DD' local
    ran_at        TEXT NOT NULL DEFAULT (datetime('now')),
    status        TEXT NOT NULL,        -- 'sent' | 'skipped_quiet' | 'skipped_empty' | 'error'
    detail        TEXT,
    UNIQUE(schedule_id, run_date)       -- guarantees once-per-day
);
```

Seed defaults on first run (only if `schedules` is empty):

| job | time | days | notes |
|---|---|---|---|
| `recurring_gen` | 07:00 | daily | runs `generateDueRecurringTasks()`; **silent** unless tasks created |
| `morning_briefing` | 08:00 | daily | full briefing (daily_briefing SKILL.md morning format) |
| `budget_check` | 12:00 | daily | **silent unless** warnings/overages |
| `email_digest` | 17:00 | daily | only if accounts configured + unread > 0 |
| `evening_review` | 20:00 | daily | evening format; top task for tomorrow |

---

### Core scheduler loop (pseudocode for `services/scheduler.ts`)

```ts
const TZ = config.timezone; // Asia/Jerusalem
setInterval(tick, SCHEDULER_TICK_SECONDS * 1000);

function tick() {
  const now = nowInTZ(TZ);
  for (const s of getEnabledSchedules()) {
    if (!dayMatches(s.days, now)) continue;
    if (alreadyRanToday(s.id, now)) continue;          // schedule_runs UNIQUE
    if (!isDue(s, now)) continue;                       // due = now >= scheduled time today
    if (s.catch_up === 0 && minutesPast(s, now) > GRACE) continue; // (not used by defaults)

    if (inQuietHours(now)) {                            // night OR shabbat
      recordRun(s.id, now, 'skipped_quiet');
      continue;
    }

    const msg = buildMessage(s.job);                    // deterministic, reuse tools/*
    if (msg == null) { recordRun(s.id, now, 'skipped_empty'); continue; } // silent jobs
    sendTelegram(OWNER_CHAT_ID, msg)
      ? recordRun(s.id, now, 'sent')
      : recordRun(s.id, now, 'error');
  }
}
```

Key behaviors:
- **Fire-late-once** falls out naturally: `isDue` is `now >= scheduledTime` (not `==`), and
  `schedule_runs UNIQUE(schedule_id, run_date)` guarantees one send per day. So if the Mac was
  off at 08:00 and boots at 09:30, the 08:00 briefing fires at 09:30 — once.
- **Silent jobs** (`recurring_gen`, `budget_check`, `email_digest`) return `null` from
  `buildMessage` when there's nothing to report → logged as `skipped_empty`, no Telegram spam.
  - `recurring_gen` is special: it always *runs* `generateDueRecurringTasks()` (side effect on
    DB) and only sends a message if `> 0` tasks were created.

### Quiet hours logic (`inQuietHours`)

```
night:   local hour >= 22 OR local hour < 7
shabbat: Friday from sunset → Saturday night.
```

**Shabbat decision needed at code time** (pick the simplest acceptable):
- **Option A (recommended, no deps):** approximate — Friday 18:00 → Saturday 20:00 local.
  Simple, no sunset math. Slightly off in summer (real sunset ~19:40) but always errs on the
  side of *more* quiet, which is safe.
- **Option B (precise):** compute Jerusalem sunset (lat 31.78, lon 35.21) per date. More code,
  no external call needed (sunset is a closed-form astronomical calc) but more surface area.

Default to **A** unless the user asks for precision.

---

### Implementation checklist (Phase 1)

1. [ ] `tools/config.ts`: add `telegram` + `scheduler` config from new `.env` vars; update `.env.example`.
2. [ ] Copy `TELEGRAM_BOT_TOKEN` from `openclaw.json` into `.env` (gitignored).
3. [ ] `tools/storage.ts`: add `schedules` + `schedule_runs` tables + seed-defaults-if-empty;
       export helpers (`getEnabledSchedules`, `alreadyRanToday`, `recordRun`).
4. [ ] `services/scheduler.ts`: tick loop, quiet-hours, `buildMessage(job)` (deterministic,
       reuse `get_daily_status`, budget, email-digest, expense summary), `sendTelegram`.
5. [ ] `npm run build:services`; sanity-run `node dist-services/scheduler.js` with a temporary
       test schedule (fire in ~1 min) and confirm a real Telegram message arrives.
6. [ ] `~/Library/LaunchAgents/com.astra.scheduler.plist` (RunAtLoad + KeepAlive); `launchctl load`.
7. [ ] Update the SKILL.md files: the scheduler now genuinely exists — make the prose match
       reality (it's a deterministic background service, not the LLM "deciding" to run a heartbeat).
8. [ ] Update `CLAUDE.md` "Background services" section to document `scheduler.ts` next to
       `whatsapp-listener.ts` / `dashboard.ts`.
9. [ ] Add a memory file documenting the scheduler design + the launchd label.
10. [ ] Commit (short message, **no mention of Claude**). Offer to open PR.

### How to verify it actually works (don't trust "it should")

- Temporarily insert a schedule row for "2 minutes from now" → confirm a Telegram message lands.
- Set one job's time to the past, restart the service → confirm it fires **once** (catch-up),
  then does **not** re-fire on the next tick (idempotency).
- Set night/Shabbat window to "now" → confirm `skipped_quiet` logged, no message.
- Confirm `recurring_gen` creates tasks (check `tasks` table) but stays silent when none are due.

---

## Phase 2 — candidates (NOT yet decided; brainstorm later)

These came up but are explicitly *out of scope for Phase 1*. Park them here.

- **Hybrid LLM phrasing.** Let the deterministic scheduler build the *facts*, then optionally
  pass them to Astra (8B) for a warmer one-line intro — with a hard fallback to the
  deterministic text if the model errors/times out. Gets natural tone without trusting the
  model with correctness.
- **Conversational schedule editing.** "Astra, move my morning briefing to 7:30" /
  "remind me every weekday at 14:00 to take meds" → model writes rows into the `schedules`
  table via a `manage_schedules` mega-tool. Magical but needs reliable structured writes; gate
  behind a confirmation echo.
- **Interactive briefings.** Reply to a briefing ("mark T3 done", "snooze habit", "what's this
  afternoon?") and have it act. Pulls the model back into the loop — design carefully.
- **More job types:** weekly money recap (Sun), monthly summary (1st), "no expenses logged
  today" nudge, habit-streak congratulations, bill/recurring-expense reminders, calendar
  lookahead for tomorrow's first meeting.
- **Snooze / acknowledge** semantics on reminders.
- **Dashboard surface** for schedules (view/toggle/edit in the existing `dashboard.html`).

---

## Guardrails to carry into all of the above

- **Never commit secrets** — `.env`, `data/`, `service_account.json`, `whatsapp_auth/`,
  `openclaw.json` stay untracked. Only `.env.example` templates get committed.
- **Never paste credentials into chat.**
- **Commit messages: short, no mention of Claude.**
- **`whatsapp-listener.ts` stays isolated** — no exports, no `sendMessage`. The new scheduler is
  a *separate* service; do not entangle them.
- **Respect the 8B constraints** — keep the active tool count small; deterministic-first.
- After touching `tools/`, `npm run build` and confirm the MCP server still connects (a wrong
  `dist/...` path fails silently). The scheduler builds to `dist-services/`, separate target.
```
