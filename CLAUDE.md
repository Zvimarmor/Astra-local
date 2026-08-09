# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Astra is a private personal AI assistant running on a Mac Mini M4 (16GB). It is **not a standalone app** — it is a set of TypeScript tools/services that plug into a separately-installed **OpenClaw gateway**, which drives the **Gemini API** (`gemini-flash-latest`) and exposes the agent over a chat channel (currently Telegram `@Astra_beta_bot`; a WhatsApp media listener also exists). This repo owns the *tools, skills, knowledge, and background services* — OpenClaw itself and its config (`~/.openclaw/openclaw.json`) live outside the repo.

## Build & run

There is no test suite (`npm test` is a stub). There are **two separate TypeScript build targets**:

```bash
npm run build            # tsc: tools/**  -> dist/         (rootDir ./tools)
npm run build:services   # tsc: services/** -> dist-services/ (rootDir ./services)
npm run build:all        # both
```

- `tools/` compiles **flat** into `dist/` (because `rootDir` is `./tools`). So `tools/mcp-server.ts` → `dist/mcp-server.js`, `tools/registry/index.ts` → `dist/registry/index.js`. There is **no `dist/tools/` directory** — be careful: any path that references `dist/tools/...` is wrong and the MCP server will fail to launch silently.
- After changing anything under `tools/`, you must `npm run build` for OpenClaw to pick it up (it runs the compiled `dist/` JS, not the `.ts`).
- Background services are launched manually / via launchd, e.g. `node dist-services/whatsapp-listener.js`, `node dist-services/dashboard.js`.

## Architecture: how a message becomes a tool call

```
Telegram ─► OpenClaw gateway (~/.openclaw, port 18789) ─► Gemini API (gemini-flash-latest)
                     │                                          │ decides tool call
                     │  spawns MCP server (stdio) ◄─────────────┘
                     ▼
   node dist/mcp-server.js  (tools/mcp-server.ts)
                     │  ListTools / CallTool
                     ▼
   toolRegistry (tools/registry/index.ts) ─► 7 mega-tools (registry/mega-tools.ts)
                     │                        action-dispatch ──► tools/<domain>.ts execute()
                     │
                     ▼
   tools/storage.ts (better-sqlite3, data/memory.db)  +  Google Calendar / IMAP / Immich / Piper
```

Key point: tools reach the model **only** through MCP. `tools/mcp-server.ts` is a `@modelcontextprotocol/sdk` stdio server that exposes `toolRegistry` over `ListTools`/`CallTool`. OpenClaw is told to spawn it via `mcp.servers.astra-tools` in `~/.openclaw/openclaw.json`. The configured `args` path **must** point at the actual build output (`dist/mcp-server.js`).

### The tool registry pattern

Every domain file under `tools/` (`tasks.ts`, `expenses.ts`, `budget.ts`, `calendar.ts`, `habits.ts`, `immich.ts`, `email.ts`, `voice.ts`, etc.) exports a single object named `<domain>Tools`, where each entry is:

```ts
{ name, description, parameters /* JSON Schema */, execute: async (args) => Record<string, any> }
```

**The model does NOT see these domain objects.** `tools/registry/index.ts` no longer spreads them — it exports only `megaTools` from `tools/registry/mega-tools.ts`, which advertises **10 action-dispatched "mega-tools"** (`manage_tasks`, `manage_projects`, `manage_finances`, `manage_calendar`, `manage_habits`, `manage_memory`, `manage_notes`, `manage_music`, `assistant_utils`, plus the actionless `plan_day` — 54 actions total) and routes each `action` into the domain `execute()` underneath. Two more blocks (`manage_email`, `manage_photos`) are **commented out** in `mega-tools.ts`, as are their `HELP_META` entries.

So to add a capability you usually add an **action** to an existing mega-tool (extend its `action` enum + the dispatch `switch`), not a new top-level tool. `execute()` should catch its own errors and return `{ status: "error", error }` rather than throwing — the MCP layer wraps throws as `isError`, but the established convention is to return structured results. `docs/TOOL-INVENTORY.md` holds the verified live inventory and the three places tools get switched on/off.

### Two tool profiles — the guest agent

`ASTRA_PROFILE` selects which surface `tools/mcp-server.ts` serves: unset/`owner` → the full
mega-tool set + `tools/private/*`; `guest` → **only** `tools/registry/guest-tools.ts`
(`track_nutrition`). OpenClaw registers both as separate MCP servers off the same build and routes
one WhatsApp number to an isolated agent `gf`. **`tools/registry/index.ts` must keep loading
`mega-tools` via a branched `require()`, never a top-level `import`** — a static import would
execute storage/tasks/calendar (and `run_claude_code`) inside the guest process. Same rule for
`guest-tools.ts`: it must not import any owner module. Full design + verification commands in
`docs/GUEST-AGENT.md`.

### State & config

- **All persistent state is local SQLite** at `data/memory.db` via `tools/storage.ts` (tables: `messages`, `tasks`, `recurring_tasks`, `habits`, `expenses`, `income`, `budgets`, `pending_facts`, `whatsapp_media`). No Google Sheets. The DB module opens the connection and creates tables on import.
- **`tools/config.ts`** is the single source of runtime config; it loads `.env` (via dotenv) and centralizes everything (Gemini key/model, timezone `Asia/Jerusalem`, IMAP accounts, Piper TTS paths, Immich, dashboard). Read config from here, not `process.env` directly.
- IDs use human-friendly prefixes (tasks are `T1`, `T2`, …); many tools accept either the ID or a partial title match.

### Skills vs. tools (don't confuse them)

- `tools/` = executable code the model can call.
- `skills/<name>/*.md` = OpenClaw `SKILL.md` instruction files that tell the model *when* to use which tools and how to behave (activation phrases, parameter hints, scheduler behavior). They are prose, not code, and are loaded by OpenClaw. When you change a tool's name/signature, update the matching `SKILL.md` so the model's guidance stays in sync.
- `knowledge/*.md` = markdown RAG knowledge base (personal notes, routines, learned facts) indexed by OpenClaw for context.

### Background services (`services/`, build to `dist-services/`)

These are **standalone long-running processes, independent of OpenClaw and the agent**:

- `whatsapp-listener.ts` — read-only Baileys listener. Deliberately has **no exports** and **never calls `sendMessage`**, so the LLM has no code path to send WhatsApp messages; it only downloads incoming media into `data/media/whatsapp/` and records metadata in the shared DB. Preserve this isolation — do not export from it or add send capability.
- `dashboard.ts` (+ `dashboard.html`) — local status dashboard.
- `immich-organizer.ts` — Immich photo organization.
- `scheduler.ts` — **proactive scheduler** (launchd `com.astra.scheduler`). Deterministic: on a 60s tick it reads the `schedules` table, and for each due job builds a message **straight from SQLite** and pushes it to Telegram via the Bot API. The 5 core jobs have **no LLM in the loop** — they can't hallucinate "I sent it", and they kept working unchanged through the Gemini migration precisely because no model sits in their path. Core jobs: `recurring_gen` (07:00, generates tasks from templates), `morning_briefing` (08:00), `budget_check` (12:00, silent unless alerts), `email_digest` (17:00, silent if nothing), `evening_review` (20:00). Two **analytical** jobs — `weekly_recap` (Sat 20:30) and `monthly_finance_review` (daily 21:00, self-gates to the last day of the month) — are now **fully deterministic too** (as of 2026-07-06): they used to pass their SQLite-built draft through a qwen3 "reword it warmly" call, but that call shared Ollama's single KV slot and evicted the interactive gateway's cached prompt prefix, making the user's next chat a ~35s cold-prefill turn. The phrasing was cosmetic, so `phraseWithLLM()` was dropped — the draft is the message. (**Sends now go via WhatsApp** through the OpenClaw gateway CLI, not Telegram's Bot API — see `tools/whatsapp-send.ts`.) The `music_alarm` job path was re-enabled 2026-08-06 (spotifyd was only ever *stopped*, never uninstalled — see `docs/TOOL-INVENTORY.md` §9). It must stay enabled in lockstep with the `manage_music` chat tool: with the tool on and this case off, `set_alarm` writes an alarm row that nothing ever fires. Idempotency = `schedule_runs UNIQUE(schedule_id, run_date)` (one send per day; "fire late, once" on catch-up). Quiet hours: night 22:00–07:00 + Shabbat (Fri 18:00→Sat 20:00) — except `recurring_gen` (and `music_alarm` when re-enabled). It `require()`s the compiled `dist/` tool modules (`storage.js`, `email-digest.js`, `whatsapp-send.js`) at runtime, so **`npm run build` must run before `build:services`** for it to work.

## Hard-won gotchas

- **The engine moved to the Gemini API on 2026-08-06** (was local Ollama `qwen3:8b`). Ollama is stopped (`brew services stop ollama`) — it pinned ~7.6GB on this 16GB box and left the machine swapping (compressor was at 8.4GB). Revert with `brew services start ollama` + `openclaw models set ollama/qwen3:8b`.
  - The old 8B constraints (4096 default `num_ctx`, tool-schema overflow, loops on hallucinated tool calls, "keep the active tool count small") **no longer bind** — `gemini-flash-latest` has a 1M-token context. Tight, flat tool schemas are still good practice, but they're no longer load-bearing.
  - **Model ids are a trap.** `gemini-1.5-flash` and `gemini-2.5-flash` return 404 "no longer available to new users" on keys created recently. Use the `gemini-flash-latest` alias. Check what a key can actually call with `curl -H "x-goog-api-key: $KEY" https://generativelanguage.googleapis.com/v1beta/models`. Note the list endpoint advertises far more models than the key can actually *generate* with — listing is not permission.
  - **`gemini-flash-latest` is capped at 20 requests/day on the free tier** (it currently aliases `gemini-3.6-flash`; quota id `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue: 20`). That is ~20 chat turns per *day* for the whole project, and it is shared with everything else on the key. When it's gone every call returns 429 `RESOURCE_EXHAUSTED` until the quota resets. `gemini-flash-lite-latest` is a **separate, far roomier bucket** and is the configured `fallback#1` for exactly this reason — keep a fallback configured.
  - **A dead model chain fails silently on the chat channel.** With no fallback, OpenClaw logs `model fallback decision … chain_exhausted` → `failover decision … surface_error` → `Embedded agent failed before reply`, and then sends **nothing**. On WhatsApp/Telegram the user sees the typing indicator and then silence — no error message ever reaches the chat. So "bot types then goes quiet" is a *provider* symptom, not an Astra bug: check the gateway log first, don't go looking in `tools/`.
  - `generateContent` is served on **v1beta**, not v1.
  - The API intermittently returns a **404 with an empty body** for a model that works on retry. A genuine "model not found" always carries a JSON error body — `tools/gemini.ts` retries empty-bodied failures for this reason. Rapid back-to-back probing makes *every* model 404 this way for a minute or two, so an empty-bodied 404 storm means "you're being throttled", **not** "these models are retired".
  - **Privacy posture changed**: prompts (tasks, expenses, email digests, notes) now leave the machine and go to Google. This repo used to be local-only.
- After editing tools, rebuild and confirm the MCP server actually connects (a wrong `dist/...` path fails silently — the model just behaves as if it has no tools).
- `~/.openclaw/openclaw.json` is auto-managed by OpenClaw (it keeps timestamped `.bak`/`.last-good` copies). Prefer `openclaw` CLI commands (`openclaw mcp ...`, `openclaw models set/fallbacks add`) over hand-editing. As of 2026-08-06 the active chat channel is **WhatsApp** (`channels.whatsapp.enabled: true`, `+972539037993`) and **Telegram is disabled** — so the README's WhatsApp diagram is right again, but `commands.ownerAllowFrom` still lists only `telegram:1005480492`, which means owner-gated commands have no WhatsApp identity to match.
- **Debugging the live chat path**: the gateway's human-readable log is `~/Library/Logs/openclaw/gateway.log`; the full structured JSON log (one object per line, with the real provider error bodies) is `/tmp/openclaw/openclaw-<date>.log`. `openclaw agent -m "..." --agent main` runs a single turn through the real gateway + model chain without sending anything to a chat channel — the fastest way to tell "is the engine broken" from "is the channel broken".
- **Skills are loaded from `~/.openclaw/workspace/skills/`, NOT from this repo's `skills/`.** They are independent copies and they have silently drifted before (a stale live skill was pointing the model at an `assistant_utils(action="web_search")` action that no longer exists). Editing `skills/` here changes nothing until you copy it across — see `docs/TOOL-INVENTORY.md` §5 for the drift check.
- **`web_search` runs on a local SearXNG** (`127.0.0.1:8888`, launchd `com.astra.searxng`) since 2026-08-06; DuckDuckGo IP-blocks this host and Gemini's Google Search grounding is blocked on the free-tier key. `json` must stay in SearXNG's `search.formats` or the provider silently gets HTML back. Details + gotchas in `docs/TOOL-INVENTORY.md` §8.
- **Never `brew services start spotifyd`** — it regenerates the plist and drops `--config-path` (device then registers under the wrong name and every playback call fails) and `ProcessType Interactive` (the audio-stutter fix). Use `launchctl bootstrap` with `~/Library/LaunchAgents/homebrew.mxcl.spotifyd.plist`. See `docs/TOOL-INVENTORY.md` §9.

## Secrets

`.env`, `data/service_account.json`, and `data/whatsapp_auth/` hold live credentials and are gitignored. The repo has prior GitGuardian history around `.env.immich` — keep real secrets in `.env*` (untracked) and only commit `.env*.example` templates.
