# Astra — Live Tool & Skill Inventory

**Verified live 2026-08-06** against the running gateway (`openclaw agent`), the running MCP
server (`tools/list`), and `~/.openclaw/openclaw.json`. Every list below is what the model
*actually* sees right now, not what the source suggests.

**Tools reaching the model: 11 OpenClaw built-ins + 10 Astra MCP tools (53 action slots).**

Changed 2026-08-06 → 07:
- `manage_music` **re-enabled** (§2) — spotifyd was never uninstalled, only stopped.
- `web_search` moved **DuckDuckGo → local SearXNG** (§7) — DDG now IP-blocks this host.
- The two stale live skills flagged in §5 are **fixed and synced**; all skills now match the repo.
- **`manage_projects`** and **`plan_day`** added; `manage_tasks` went 4 → 10 actions with real
  deadlines (§2). Habit streaks and two deterministic scheduler jobs added (§8).
- **`image` denied** at the user's request (§3) — Astra no longer analyses image content. The
  three `*_generate` tools could NOT be removed this way; see §10 for why. Note `manage_photos`/`media_access` are unaffected: they list WhatsApp media metadata
  from SQLite rather than reading the file contents.
- The model chain was **inverted** to `gemini-flash-lite-latest` primary (§6).
- A gitignored `tools/private/` directory can carry **per-machine tools** that are not part of this
  repo; the registry loads it optionally, so a clone without it still builds. Anything there is
  outside `megaTools` and so absent from the `/tools` list, and is expected to carry its own
  authorization check. Not inventoried here by design.

---

## 1. Read this first — the three control planes

Silencing or adding a tool means editing a *different* place depending on which kind it is:

| Plane | What lives there | How to change it | Takes effect |
|---|---|---|---|
| **A. OpenClaw built-ins** | `read`, `web_search`, `image_generate`, … | `tools.deny` in `~/.openclaw/openclaw.json` | Hot reload, seconds |
| **B. Astra MCP tools** | the `manage_*` set, `assistant_utils`, `plan_day` | `tools/registry/mega-tools.ts` → `npm run build` | After rebuild |
| **C. Skills (prose guidance)** | *when* to use a tool | `~/.openclaw/workspace/skills/` | Next turn |

> ⚠️ **Plane C is the trap.** OpenClaw loads skills from `~/.openclaw/workspace/skills/`, **not**
> from this repo's `skills/`. They are independent copies, and they have already drifted — see §5.
> Editing `skills/` in the repo changes nothing until you copy it across.

---

## 2. Astra's own tools (plane B) — 10 live

Source: `tools/registry/mega-tools.ts`. Only these 10 are advertised; the ~17 domain modules under
`tools/` are the *implementation* the mega-tools route into.

| Tool | Actions | Backed by |
|---|---|---|
| `manage_tasks` | `add`, `list`, `complete`, `delete`, `update`, `snooze`, `stale`, `add_recurring`, `list_recurring`, `remove_recurring` | `tasks.ts`, `recurring-tasks.ts` |
| `manage_finances` | `add_expense`, `expense_summary`, `add_income`, `financial_overview`, `set_budget`, `list_budgets`, `budget_alerts` | `expenses.ts`, `budget.ts` |
| `manage_calendar` | `list`, `add`, `delete` | `calendar.ts` (Google, service account) |
| `manage_habits` | `track`, `log`, `list` | `habits.ts` |
| `manage_memory` | `propose`, `approve`, `decline` | `memory.ts` (approval-gated) |
| `manage_notes` | `add`, `find`, `list`, `link`, `delete` | `notes.ts` (Obsidian vault) |
| `assistant_utils` | `help`, `current_time`, `daily_status`, `speak`, `set_voice_mode`, `get_voice_mode`, `text_to_speech`, `list_whatsapp_media` | `daily-status.ts`, `voice.ts`, `whatsapp-media.ts` |
| `manage_music` | `play`, `pause`, `next`, `previous`, `volume`, `now_playing`, `set_alarm`, `list_alarms`, `cancel_alarm` | `spotify.ts` → spotifyd (see §8) |
| `manage_projects` | `add`, `list`, `status`, `breakdown`, `complete`, `delete` | `projects.ts` — progress derived from linked tasks, never stored |
| `plan_day` | *(no action enum — one operation)* | `planner.ts` — tasks × calendar → time blocks |

### Deadlines: the thing that was actually missing

`tasks.date` is the **creation** date and always was — written from `new Date()` at insert. It never
meant "when is this due". So before 2026-08-07, "what's due this week?", "what's overdue?" and any
deadline reminder were not unimplemented, they were **unanswerable**. `due_date` (nullable — NULL
means "someday") is what makes the filters, `deadline_watch`, and `plan_day` possible at all.

`estimate_minutes` exists for `plan_day`: with no duration there is nothing to pack. Tasks without
one are assumed 45 min and flagged `~est` rather than silently treated as accurate.

### Still switched off (code exists, commented out)

Disabled 2026-07-06 as a "speed trim" for the old 8B model. **That constraint is gone** —
Gemini has a 1M context — so these are cheap to bring back.

| Tool | Actions it would add | Re-enable by | Caveat |
|---|---|---|---|
| `manage_email` | `list`, `read`, `digest` | uncomment the block + its `HELP_META` line | read-only, IMAP; the 17:00 digest **already works** via the scheduler |
| `manage_photos` | `stats`, `search`, `list_albums`, `create_album`, `add_to_album` | same comment block | needs Immich up |

Both live in the *same* comment block, so uncommenting brings back both unless you split it.
There is no skill for `manage_email` — write one if you re-enable it.

**After any change here: `npm run build`** (output is flat — `dist/mcp-server.js`, no `dist/tools/`).

---

## 3. OpenClaw built-ins (plane A) — 11 live

These come from OpenClaw itself, not this repo. Silence via `tools.deny`.

**Keeping:**

| Tool | Why |
|---|---|
| `read` | reads files |
| `web_search` | now local SearXNG (§7); the `web_search` skill depends on it |
| `web_fetch` | pulls real page content — the skill explicitly needs this for weather/scores |
| `message` | sends chat messages |

**Silenced 2026-08-07:** `image` — Astra no longer analyses image content. Confirmed in the
gateway's `tool policy removed N tool(s)` line, which lists exactly what matched. `manage_photos` /
`media_access` are unaffected: they read WhatsApp media metadata from the `whatsapp_media` SQLite
table, not the files.

### ⚠️ `tools.deny` does NOT govern the media-generation tools

`image_generate`, `video_generate` and `music_generate` were all added to `tools.deny`, the gateway
was restarted, and **all three survived**. The policy log reported **19 matched** entries with none
of them among it. Per the OpenClaw docs these tools auto-register whenever *any* provider API key is
present — and the Gemini key is the engine, so the trigger can't be removed.

`tools.allow` would exclude them, but it is a live hazard here: the gateway log for 2026-07-03 shows
a previous `tools.allow` attempt that stripped **all 10 Astra tools**. Not worth it — see §10 for
why the prompt-size saving is ~2% and unmeasurable, and §6 for why they can't bill you on the free
tier (Veo returns 429, Imagen 404).

Untested candidates, if you ever want to try: `sessions_list`, `sessions_history`, `sessions_send`,
`session_status` — multi-session introspection that isn't used here.

### How to change `tools.deny` at all

There is **no append syntax** — read the array, add to it, write the whole thing back:

```bash
NEW=$(openclaw config get tools.deny | jq -c '. + ["some_tool"] | unique')
openclaw config set tools.deny "$NEW" --dry-run   # validate first
openclaw config set tools.deny "$NEW"
```

Verified working with `--dry-run`. `tools.deny` hot-reloads in seconds, but **verify by the
`tool policy removed N tool(s): … ; matched …` line** in `~/Library/Logs/openclaw/gateway.log` —
that `matched` list is authoritative, and it is how the generate-tool failure above was caught. Note
the log line only appears when an agent turn runs, not at startup. Asking the model to list its own
tools costs a Gemini request and is less reliable than the log.

### Your deny list has 9 entries that match nothing

`tools.deny` holds 29 names (27 before `image`/`pdf` were added), but the gateway reported only
**18 matched** of the original 27:

> `tool policy removed 18 tool(s) via tools.deny: agents_list, apply_patch, create_goal, cron,
> edit, exec, gateway, get_goal, nodes, process, sessions_spawn, sessions_yield, skill_workshop,
> subagents, tts, update_goal, whatsapp_login, write`

These 9 are **no-ops** — wrong names, or plugins whose tools aren't loaded:

```
update_plan   browser   canvas   file_fetch   dir_list
dir_fetch     file_write   memory_search   memory_get
```

Harmless, but misleading: `browser` and `canvas` plugins *are* loaded, so if you meant to block
them, the real tool names differ and they may still be reachable. Worth confirming before you
trust that list.

Note `tts` is denied at the OpenClaw level while Astra's own `assistant_utils(action="speak")`
still works — voice output goes through Piper, not OpenClaw's TTS.

---

## 4. Skills (plane C) — 13 live

Prose in `SKILL.md` telling the model *when* to reach for a tool. Loaded from
`~/.openclaw/workspace/skills/`.

| Skill | Drives | Notes |
|---|---|---|
| `task_management` | `manage_tasks`, `plan_day` | deadlines + day planning; Hebrew triggers |
| `expense_tracking` | `manage_finances` | NIS-aware |
| `calendar` | `manage_calendar` | |
| `habits` | `manage_habits` | |
| `notes` | `manage_notes` | Hebrew triggers included |
| `memory` | `manage_memory` | has an explicit "when NOT to activate" — good pattern to copy |
| `daily_briefing` | `assistant_utils(daily_status)` | on-demand only; the 08:00/20:00 sends are the scheduler's |
| `help` | `assistant_utils(help)` | backs `/tools`, built live from the registry |
| `voice` | `assistant_utils(speak, *_voice_mode)` | fixed 2026-08-06 (was Telegram-worded) |
| `web_search` | `web_search`, `web_fetch` | fixed 2026-08-06 (pointed at a nonexistent action) |
| `media_access` | `assistant_utils(list_whatsapp_media)` | read-only |
| `spotify` | `manage_music` | restored from `_disabled/` 2026-08-06; Hebrew triggers |
| `projects` | `manage_projects` | new 2026-08-07; Hebrew triggers |

**Disabled** (in `skills/_disabled/`, absent from the workspace): `photo_management` — the pair
for `manage_photos`.

---

## 5. ✅ RESOLVED — two live skills were out of date

Kept for the record, because it's the failure mode most likely to recur. The repo had **newer**
versions that were never copied to the workspace:

**`web_search` — actively broken.** The live copy tells the model to call
`assistant_utils(action="web_search", query=…)`. That action **does not exist** (see §2 — the
real enum has no `web_search`). So the model is being pointed at a nonexistent action instead of
the real built-in `web_search`/`web_fetch` tools. The repo version fixes this and adds the
"snippets aren't enough, fetch the page" guidance.

**`voice` — wrong channel.** The live copy says Telegram throughout and defaults `voice_mode` to
`telegram`. Telegram is now disabled; WhatsApp is the live channel. The repo version says WhatsApp.

Both were synced on 2026-08-06 and **all 12 skills are now byte-identical** between repo and
workspace. Re-check any time with:

```bash
for s in $(ls skills | grep -v _disabled); do
  diff -q "skills/$s/SKILL.md" ~/.openclaw/workspace/skills/$s/SKILL.md >/dev/null \
    && echo "ok:      $s" || echo "DIFFERS: $s"
done
```

To stop this recurring, make the workspace skills symlinks into the repo:

```bash
for s in calendar daily_briefing expense_tracking habits help media_access \
         memory notes task_management voice web_search; do
  rm -rf ~/.openclaw/workspace/skills/$s
  ln -s /Users/zvis_server/MyProjects/Astra/skills/$s ~/.openclaw/workspace/skills/$s
done
```

Then the repo is the single source of truth and drift is impossible. *(Untested — verify OpenClaw
follows symlinks before relying on it.)*

---

## 6. Cost posture — nothing here can bill you

Checked 2026-08-06. **The Gemini project has no billing account and physically cannot charge.**
Four independent confirmations:

| Probe | Result | What it proves |
|---|---|---|
| `gemini-flash-latest` over quota | `429`, quota id `GenerateRequestsPerDayPerProjectPerModel-**FreeTier**`, limit 20 | free-tier buckets only exist on non-billing projects |
| Google Search grounding | `429` refused | a paid feature, blocked rather than billed |
| `imagen-4.0-fast-generate-001` | `404` "no longer available to new users" | paid image models not accessible |
| `veo-3.1-fast-generate-preview` | `429` refused | paid video **refused, not accepted-and-charged** |

The last one is the strongest: on a billing-enabled project that Veo call would have been accepted
and billed. It was refused.

**So the risk is the opposite of a surprise bill — it's hard caps silently breaking things.** That
is exactly what happened on 2026-08-06: the 20/day cap was hit and replies stopped with no error
in the chat.

Everything else in the stack is free or already-owned: Immich is self-hosted, Google Calendar
(service account) and IMAP/SMTP are free tiers, WhatsApp runs on Baileys, SearXNG is local, and
Spotify uses an existing Premium subscription.

**The one thing that would change this:** if you ever enable billing / upgrade the Gemini project,
the free-tier walls become paid usage — and `image_generate`, `video_generate` and `music_generate`
are *currently still active tools* (§3). Veo especially is expensive per second. Silence those
three before enabling billing, not after.

Confirm in the console any time: <https://aistudio.google.com/usage> and
<https://ai.dev/rate-limit>.

### Budget constraint on testing

`gemini-flash-latest` is capped at **20 requests/day**; `gemini-flash-lite-latest` is the fallback
and has a much roomier bucket. Every `openclaw agent -m …` verification costs one request. Batch
your checks — don't re-list tools after each individual edit. SearXNG and the Spotify Web API cost
nothing, so §7/§8's curl checks are free.

---

## 7. Web search — local SearXNG (replaced DuckDuckGo 2026-08-06)

DuckDuckGo started returning bot-detection challenges to this host, so `web_search` failed with
`"DuckDuckGo returned a bot-detection challenge."` It was not recoverable by retrying — DDG's
HTML endpoint serves the challenge to this IP consistently. Public SearXNG instances were also
all bot-challenged or rate-limited, and Gemini's Google Search grounding is **hard-blocked on
this free-tier key** (plain calls 200, grounded calls 429).

So search now runs on a **local SearXNG** — free, unlimited, no account, no API key:

| | |
|---|---|
| Install | `/Users/zvis_server/searxng` (git clone + `.venv`, Python 3.14) |
| Config | `/Users/zvis_server/searxng/settings.yml` |
| Service | launchd `com.astra.searxng`, `127.0.0.1:8888` |
| Logs | `/Users/zvis_server/searxng/searxng.log` + `-error.log` |
| RAM | ~250 MB |

Wired into OpenClaw as:

```
tools.web.search.provider                       = "searxng"
plugins.entries.searxng.enabled                 = true
plugins.entries.searxng.config.webSearch.baseUrl = "http://127.0.0.1:8888"
plugins.entries.duckduckgo.enabled              = false
```

**Two gotchas worth remembering:**

1. **`json` is not in SearXNG's default `formats`.** Without `search.formats: [html, json]` in
   `settings.yml`, the API returns HTML and OpenClaw's provider fails. This is the single most
   likely thing to break if the config is ever regenerated.
2. **SearXNG takes ~60s to become responsive** after start (it initialises ~20 engines). A curl
   immediately after `launchctl bootstrap` will fail with connection refused — that's normal.

Engine health: `wikidata` fails init with a 403, and `torch`/`ahmia` fail (Tor-only, no Tor here).
Harmless — the other engines carry it, and SearXNG rotates them per query, so which engine answers
varies (`brave` on one query, `google cse` on the next). A thin result set is worth one retry with
reworded terms rather than giving up; the `web_search` skill now says so.

Test it without spending Gemini quota:

```bash
curl -s "http://127.0.0.1:8888/search?q=test&format=json" | jq '.results | length'
```

## 8. Spotify / music — re-enabled 2026-08-06

CLAUDE.md said spotifyd was "decommissioned". It wasn't — it was only **stopped**. Everything
survived: brew `spotifyd 0.4.2`, `~/.config/spotifyd/spotifyd.conf`, and the cached OAuth
credentials at `~/.cache/spotifyd/oauth/credentials.json` (so **no interactive re-login was
needed**). Bringing it back took a service start plus uncommenting two code blocks.

What was re-enabled:
- `manage_music` in `tools/registry/mega-tools.ts` (the `../spotify` import, the `HELP_META`
  entry, and the tool block) → `npm run build`
- the `music_alarm` case in `services/scheduler.ts` (+ its `spotify.js` require) →
  `npm run build:services`. **These two must be enabled together** — otherwise
  `manage_music(action="set_alarm")` writes an alarm row that nothing ever fires.
- `skills/spotify/` restored from `skills/_disabled/` and synced to the workspace

### ⚠️ Do not use `brew services start spotifyd`

That **regenerates the plist from the formula and silently drops two flags that matter**:

- `--config-path …/spotifyd.conf` — without it spotifyd ignores the config and registers as
  `Spotifyd@<hostname>` instead of `Astra_Mac_Mini`. `resolveDeviceId()` in `tools/spotify.ts`
  does an **exact name match**, so every playback call fails with "Device not found".
- `ProcessType Interactive` — the scheduling band that fixed the audio stutter (the stutter was
  memory-paging starvation, not CPU).

The good plist is `~/Library/LaunchAgents/homebrew.mxcl.spotifyd.plist`. Start/stop it with
launchctl, not brew:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/homebrew.mxcl.spotifyd.plist
launchctl bootout   gui/$(id -u)/homebrew.mxcl.spotifyd
```

Verify the device name is right (this is the check that actually matters):

```bash
# expects: Astra_Mac_Mini | type=Speaker
curl -s https://api.spotify.com/v1/me/player/devices -H "Authorization: Bearer $AT" \
  | jq -r '.devices[] | "\(.name) | type=\(.type)"'
```

Requires Spotify Premium (Connect device control is a Premium feature).

## 9. Proactive scheduler jobs — the free tier of features

Not tools, but they're where most day-to-day value lives, and they matter for a reason worth
stating plainly: **no model sits in their path**. They're built straight from SQLite, so they cost
**zero Gemini quota**, cannot be rate-limited, and can't hallucinate. On a free tier that ran out
twice on 2026-08-06, that's the difference between a feature that works and one that doesn't.

9 jobs in the `schedules` table:

| Job | When | Behaviour |
|---|---|---|
| `recurring_gen` | 07:00 daily | generates tasks from recurring templates |
| `deadline_watch` | 07:30 daily | overdue + due-today + projects closing within 7d — **silent if nothing** |
| `morning_briefing` | 08:00 daily | the day ahead |
| `budget_check` | 12:00 daily | silent unless a budget is breached |
| `email_digest` | 17:00 daily | silent if no mail |
| `stale_task_nudge` | Sun 19:00 | undated tasks pending 3+ weeks — **silent if nothing** |
| `evening_review` | 20:00 daily | tomorrow's agenda, spend, top task, **habit streaks** |
| `weekly_recap` | Sat 20:30 | week in review |
| `monthly_finance_review` | 21:00 daily | self-gates to the last day of the month |

`deadline_watch` is at 07:30 deliberately: after `recurring_gen` (07:00) so this morning's generated
tasks are included, and before the 08:00 briefing so deadlines lead the day.

Adding one is a row in `schedules` plus a `case` in `runJob` — these nine are the pattern. Quiet
hours (22:00–07:00 and Shabbat) suppress everything except `recurring_gen` and `music_alarm`.

**Habit streaks**: `habits` only ever stored `last_logged_date`, which answers "did I do it today?"
but makes streaks impossible — no history to count back through. `habit_logs` (UNIQUE per habit per
day) fixes that. Streaks anchor on today if logged, else yesterday, otherwise every streak would
read 0 for most of the day.

## 10. Latency and context — what actually moves the needle

Measured 2026-08-07, because the intuitive answers are wrong here.

**Trimming tools does almost nothing.** All Astra MCP tool schemas together are **12,107 bytes
≈ 3,000 tokens**. The WhatsApp session was carrying **44k tokens** of history. So removing two or
three tools shaves ~2% off the prompt — unmeasurable. `thinking=off` vs `thinking=medium` on a
trivial turn measured **3.23s vs 3.18s**, i.e. no difference (flash-lite doesn't spend reasoning
tokens on a trivial prompt anyway). And most of that ~3.2s is `openclaw agent` CLI startup, which
**real chat messages never pay** — they hit the already-running gateway.

**`image_generate` / `video_generate` / `music_generate` cannot be removed via `tools.deny`.**
Confirmed empirically: all three were added to the deny list and survived a gateway restart, and the
policy log reported only **19 matched** entries with none of them among it. Per the docs they
auto-register whenever any provider API key exists — and the Gemini key is the engine, so it can't
be removed. `tools.allow` would work but is dangerous: an earlier `tools.allow` attempt in this
config stripped **all 10 Astra tools** (visible in the gateway log for 2026-07-03). Not worth it for
a 2% prompt saving, and they're refused on the free tier anyway (§6).

**Session history is not needed for anything functional.** Verified: the scheduler's ~18 data calls
all go to SQLite (`getPendingTasks`, `getHabitsWithStreaks`, `checkBudgetAlerts`, …) and never read
chat history; Astra's own `messages` table is **empty and `getRecentHistory()` is never called
outside `storage.ts`** (dead code); and everything durable lives in SQLite, the vault, or
`knowledge/learned_facts.md`. History only buys conversational continuity.

Note the free tier caps **requests per day, not tokens**, so a long session costs no quota — it just
grows prefill.

What is now configured to keep it bounded:

| Setting | Value | Effect |
|---|---|---|
| `agents.defaults.contextPruning` | `{mode: "cache-ttl", ttl: "5m"}` | trims oversized **tool results** in memory; conversation text untouched, transcript not rewritten |
| `session.reset` | `{mode: "daily", atHour: 4}` | fresh session each day at 04:00 — inside quiet hours, before the 07:00 jobs |
| `session.maintenance` | `{mode: "enforce", pruneAfter: "14d", maxEntries: 100}` | prunes the session **store** (old entries + orphaned artifacts) |

Force a cleanup now with `openclaw sessions cleanup --enforce` (one run pruned 1,038 unreferenced
artifacts). Revert the pruning with
`openclaw config set agents.defaults.contextPruning '{"mode":"off"}'`.

## 11. Other context the model gets (not tools)

- `~/.openclaw/workspace/` — `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `HEARTBEAT.md`,
  `TOOLS.md` (the last is an empty OpenClaw template — a natural home for device/voice specifics).
- `knowledge/` in this repo — `learned_facts.md`, `personal_notes.md`, `projects.md`, `routines.md`.
  Recall happens through active tool calls, **not** passive RAG injection.
- `services/scheduler.ts` — 5 core + 2 analytical jobs, fully deterministic, **no model in the
  loop**. Nothing here is a "tool" and none of it is affected by anything above.
