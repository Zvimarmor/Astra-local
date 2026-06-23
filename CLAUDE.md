# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Astra is a private, local-only personal AI assistant running on a Mac Mini M4 (16GB). It is **not a standalone app** — it is a set of TypeScript tools/services that plug into a separately-installed **OpenClaw gateway**, which drives a local **Ollama** LLM (`hermes3:8b-llama3.1-q8_0`) and exposes the agent over a chat channel (currently Telegram `@Astra_beta_bot`; a WhatsApp media listener also exists). This repo owns the *tools, skills, knowledge, and background services* — OpenClaw itself and its config (`~/.openclaw/openclaw.json`) live outside the repo.

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
Telegram ─► OpenClaw gateway (~/.openclaw, port 18789) ─► Ollama (hermes3 8B, Metal GPU)
                     │                                          │ decides tool call
                     │  spawns MCP server (stdio) ◄─────────────┘
                     ▼
   node dist/mcp-server.js  (tools/mcp-server.ts)
                     │  ListTools / CallTool
                     ▼
   toolRegistry  (tools/registry/index.ts)  ── 34 flat tools ──► tools/<domain>.ts execute()
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

`tools/registry/index.ts` spreads all of these into one `toolRegistry` and re-exports them as OpenAI-style function declarations via `getToolDeclarations()`. To add a tool: create/extend a `<domain>Tools` object and spread it into `toolRegistry`. `execute()` should catch its own errors and return `{ status: "error", error }` rather than throwing — the MCP layer wraps throws as `isError`, but the established convention is to return structured results.

### State & config

- **All persistent state is local SQLite** at `data/memory.db` via `tools/storage.ts` (tables: `messages`, `tasks`, `recurring_tasks`, `habits`, `expenses`, `income`, `budgets`, `pending_facts`, `whatsapp_media`). No Google Sheets. The DB module opens the connection and creates tables on import.
- **`tools/config.ts`** is the single source of runtime config; it loads `.env` (via dotenv) and centralizes everything (Ollama URL/model, timezone `Asia/Jerusalem`, IMAP accounts, Piper TTS paths, Immich, dashboard). Read config from here, not `process.env` directly.
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
- `scheduler.ts` — **proactive scheduler** (launchd `com.astra.scheduler`). Deterministic: on a 60s tick it reads the `schedules` table, and for each due job builds a message **straight from SQLite** and pushes it to Telegram via the Bot API. **No LLM in the loop** — it can't hallucinate "I sent it" and runs even when Ollama is cold. Jobs: `recurring_gen` (07:00, generates tasks from templates), `morning_briefing` (08:00), `budget_check` (12:00, silent unless alerts), `email_digest` (17:00, silent if nothing), `evening_review` (20:00). Idempotency = `schedule_runs UNIQUE(schedule_id, run_date)` (one send per day; "fire late, once" on catch-up). Quiet hours: night 22:00–07:00 + Shabbat (Fri 18:00→Sat 20:00). It `require()`s the compiled `dist/` tool modules (`storage.js`, `email-digest.js`) at runtime, so **`npm run build` must run before `build:services`** for it to work. The Telegram bot token lives in `.env` as `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_OWNER_CHAT_ID`).

## Hard-won gotchas

- **Local 8B model constraints dominate everything.** Ollama runs on Metal GPU (verify with `ollama ps` → `100% GPU`), but cold model load is ~8s and Ollama defaults to `num_ctx 4096`. The full 34-tool JSON schema set is a large system prompt; with the default context it overflows and the model loops on hallucinated tool calls. Keep tool schemas tight, prefer explicit flat parameters with `enum`s over nested `args` objects or `additionalProperties: true` (8B models handle those poorly), and keep the active tool count small.
- After editing tools, rebuild and confirm the MCP server actually connects (a wrong `dist/...` path fails silently — the model just behaves as if it has no tools).
- `~/.openclaw/openclaw.json` is auto-managed by OpenClaw (it keeps timestamped `.bak`/`.last-good` copies). Prefer `openclaw` CLI commands (`openclaw mcp ...`) over hand-editing, and note it currently has Telegram enabled / WhatsApp disabled — the README's WhatsApp-centric diagram predates the Telegram switch.

## Secrets

`.env`, `data/service_account.json`, and `data/whatsapp_auth/` hold live credentials and are gitignored. The repo has prior GitGuardian history around `.env.immich` — keep real secrets in `.env*` (untracked) and only commit `.env*.example` templates.
