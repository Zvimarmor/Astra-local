# Astra — Personal Local AI Agent

**Astra** is a private, autonomous AI assistant that runs entirely on local hardware (Mac Mini M4). It manages personal workflows — tasks, expenses, habits, calendar, and knowledge — via chat, powered by a local LLM through [OpenClaw](https://github.com/openclaw/openclaw) and [Ollama](https://ollama.com/).

**Chat channel:** Astra currently runs on **Telegram** (`@Astra_beta_bot`) — chosen first because it's the simplest channel to bring up and iterate on. **WhatsApp** is planned as a later step, via a dedicated ("burner") number once the agent loop is stable. A separate read-only WhatsApp media listener already runs independently (see below); it does not send messages.

## Architecture

```
Telegram ──► OpenClaw Gateway ──► Ollama (Local LLM, Metal GPU)
 (WhatsApp      │                      │
  planned)      ▼                      ▼
         Channel Adapter        Agent Runtime
                │                      │
                ▼                      ▼
         Skills (SKILL.md)      Custom Tools (TS)
                                       │  via MCP (stdio)
                    ┌──────────────────┤
                    ▼                  ▼
              Local SQLite     Google Calendar API
              (tasks, habits,    (via service_account)
               expenses, memory)
```

Custom tools reach the model through an MCP stdio server (`tools/mcp-server.ts` → `dist/mcp-server.js`), spawned by OpenClaw per its `mcp.servers.astra-tools` config.

## Key Design Decisions

- **Fully Local Storage**: Tasks, expenses, habits, and conversation memory are stored in a local SQLite database. No Google Sheets dependency.
- **Markdown RAG**: Personal knowledge is stored in `knowledge/*.md` files, indexed by OpenClaw for context-aware responses.
- **English-Primary**: The agent communicates primarily in English (with Hebrew support where available).
- **OpenClaw Skills**: Agent behavior is defined via modular `SKILL.md` instruction files, not hardcoded prompts.
- **Google Calendar**: Retained via service account — the only external API dependency.

## Directory Structure

```
Astra/
├── openclaw.json          # Gateway config (Ollama endpoint, channels)
├── .env                   # Secrets (service account path, calendar ID)
├── knowledge/             # Markdown RAG knowledge base
├── skills/                # OpenClaw Skills (instruction files)
├── tools/                 # Custom tools (TypeScript)
├── data/                  # SQLite database + credentials
└── docs/                  # Architecture docs & setup guides
```

## Prerequisites

Before running Astra, you need:

1. **Mac Mini M4** with macOS (16GB+ RAM recommended)
2. **Ollama** installed with the Q8 model pulled: `hermes3:8b-llama3.1-q8_0`
3. **OpenClaw** installed and onboarded
4. **Google service account** JSON file (for Calendar API)

See [`docs/MAC_MINI_SETUP_GUIDE.md`](docs/MAC_MINI_SETUP_GUIDE.md) for detailed setup instructions.

## Status

✅ **Live on the Mac Mini M4** — running via OpenClaw + Ollama, reachable on Telegram (`@Astra_beta_bot`).

### Roadmap

- **Now:** Telegram channel; 34 custom tools exposed over MCP; local SQLite state.
- **Next:** tighten tool-calling accuracy and latency on the local 8B model (smaller active tool set / context tuning).
- **Later:** add **WhatsApp** as a channel using a dedicated number, once the Telegram setup is stable.
