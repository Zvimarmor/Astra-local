# Astra — Live Tool & Skill Inventory

**Verified live 2026-08-06** against the running gateway (`openclaw agent`), the running MCP
server (`tools/list`), and `~/.openclaw/openclaw.json`. Every list below is what the model
*actually* sees right now, not what the source suggests.

**21 tools reach the model: 13 OpenClaw built-ins + 8 Astra MCP tools (44 actions).**

Changed later on 2026-08-06:
- `manage_music` **re-enabled** (§2) — spotifyd was never uninstalled, only stopped.
- `web_search` moved **DuckDuckGo → local SearXNG** (§8) — DDG now IP-blocks this host.
- The two stale live skills flagged in §5 are **fixed and synced**; all 12 now match the repo.

---

## 1. Read this first — the three control planes

Silencing or adding a tool means editing a *different* place depending on which kind it is:

| Plane | What lives there | How to change it | Takes effect |
|---|---|---|---|
| **A. OpenClaw built-ins** | `read`, `web_search`, `image_generate`, … | `tools.deny` in `~/.openclaw/openclaw.json` | Hot reload, seconds |
| **B. Astra MCP tools** | the 7 `manage_*` / `assistant_utils` | `tools/registry/mega-tools.ts` → `npm run build` | After rebuild |
| **C. Skills (prose guidance)** | *when* to use a tool | `~/.openclaw/workspace/skills/` | Next turn |

> ⚠️ **Plane C is the trap.** OpenClaw loads skills from `~/.openclaw/workspace/skills/`, **not**
> from this repo's `skills/`. They are independent copies, and they have already drifted — see §5.
> Editing `skills/` in the repo changes nothing until you copy it across.

---

## 2. Astra's own tools (plane B) — 7 live, 35 actions

Source: `tools/registry/mega-tools.ts`. Only these 7 are advertised; the ~15 domain modules under
`tools/` are the *implementation* the mega-tools route into.

| Tool | Actions | Backed by |
|---|---|---|
| `manage_tasks` | `add`, `list`, `complete`, `delete`, `add_recurring`, `list_recurring`, `remove_recurring` | `tasks.ts`, `recurring-tasks.ts` |
| `manage_finances` | `add_expense`, `expense_summary`, `add_income`, `financial_overview`, `set_budget`, `list_budgets`, `budget_alerts` | `expenses.ts`, `budget.ts` |
| `manage_calendar` | `list`, `add` | `calendar.ts` (Google, service account) |
| `manage_habits` | `track`, `log`, `list` | `habits.ts` |
| `manage_memory` | `propose`, `approve`, `decline` | `memory.ts` (approval-gated) |
| `manage_notes` | `add`, `find`, `list`, `link`, `delete` | `notes.ts` (Obsidian vault) |
| `assistant_utils` | `help`, `current_time`, `daily_status`, `speak`, `set_voice_mode`, `get_voice_mode`, `text_to_speech`, `list_whatsapp_media` | `daily-status.ts`, `voice.ts`, `whatsapp-media.ts` |
| `manage_music` | `play`, `pause`, `next`, `previous`, `volume`, `now_playing`, `set_alarm`, `list_alarms`, `cancel_alarm` | `spotify.ts` → spotifyd (see §9) |

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

## 3. OpenClaw built-ins (plane A) — 13 live

These come from OpenClaw itself, not this repo. Silence via `tools.deny`.

**Probably keep:**

| Tool | Why |
|---|---|
| `read` | reads files |
| `web_search` | DuckDuckGo; the `web_search` skill depends on it |
| `web_fetch` | pulls real page content — the skill explicitly needs this for weather/scores |
| `message` | sends chat messages |
| `pdf` | reads PDFs |
| `image` | reads/analyses images you send |

**Candidates to silence — likely dead weight for a personal assistant:**

| Tool | Why silence |
|---|---|
| `image_generate` | you have no image-gen use case; Gemini image models burn quota fast |
| `video_generate` | same, and far more expensive |
| `music_generate` | generates *audio clips*, unrelated to Spotify playback |
| `sessions_list` | multi-session introspection you don't use |
| `sessions_history` | ditto |
| `sessions_send` | lets the model message other sessions |
| `session_status` | ditto |

Silencing all 7 leaves a 6-built-in + 7-Astra surface. There is **no append syntax** for
`tools.deny` — read the array, add to it, write the whole thing back:

```bash
NEW=$(openclaw config get tools.deny | jq -c '. + [
  "image_generate","video_generate","music_generate",
  "sessions_list","sessions_history","sessions_send","session_status"
] | unique')

openclaw config set tools.deny "$NEW" --dry-run   # validate first
openclaw config set tools.deny "$NEW"
```

Verified working with `--dry-run` on 2026-08-06. The gateway hot-reloads `tools.deny` in seconds —
watch for `tool policy removed N tool(s)` in `~/Library/Logs/openclaw/gateway.log`, and check that
`N` went up by the number you added. That log line is free; confirming via
`openclaw agent -m "list only your tool names"` costs a Gemini request (see §6).

### Your deny list has 9 entries that match nothing

`tools.deny` currently holds 27 names, but the gateway reports only **18 matched**:

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

## 4. Skills (plane C) — 11 live

Prose in `SKILL.md` telling the model *when* to reach for a tool. Loaded from
`~/.openclaw/workspace/skills/`.

| Skill | Drives | Notes |
|---|---|---|
| `task_management` | `manage_tasks` | |
| `expense_tracking` | `manage_finances` | NIS-aware |
| `calendar` | `manage_calendar` | |
| `habits` | `manage_habits` | |
| `notes` | `manage_notes` | Hebrew triggers included |
| `memory` | `manage_memory` | has an explicit "when NOT to activate" — good pattern to copy |
| `daily_briefing` | `assistant_utils(daily_status)` | on-demand only; the 08:00/20:00 sends are the scheduler's |
| `help` | `assistant_utils(help)` | backs `/tools`, built live from the registry |
| `voice` | `assistant_utils(speak, *_voice_mode)` | **stale — see §5** |
| `web_search` | `web_search`, `web_fetch` | **stale and broken — see §5** |
| `media_access` | `assistant_utils(list_whatsapp_media)` | read-only |
| `spotify` | `manage_music` | restored from `_disabled/` 2026-08-06 |

**Disabled** (in `skills/_disabled/`, absent from the workspace): `photo_management` — the pair
for `manage_photos`.

---

## 5. ✅ RESOLVED — two live skills were out of date

The repo has **newer** versions that were never copied to the workspace:

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
nothing, so §8/§9's curl checks are free.

---

## 8. Web search — local SearXNG (replaced DuckDuckGo 2026-08-06)

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

## 9. Spotify / music — re-enabled 2026-08-06

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

## 10. Other context the model gets (not tools)

- `~/.openclaw/workspace/` — `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `HEARTBEAT.md`,
  `TOOLS.md` (the last is an empty OpenClaw template — a natural home for device/voice specifics).
- `knowledge/` in this repo — `learned_facts.md`, `personal_notes.md`, `projects.md`, `routines.md`.
  Recall happens through active tool calls, **not** passive RAG injection.
- `services/scheduler.ts` — 5 core + 2 analytical jobs, fully deterministic, **no model in the
  loop**. Nothing here is a "tool" and none of it is affected by anything above.
