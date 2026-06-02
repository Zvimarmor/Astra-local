# Astra — Personal Local AI Agent

**Astra** is a private, autonomous AI assistant that runs entirely on local hardware (Mac Mini M4). It manages personal workflows — tasks, expenses, habits, calendar, and knowledge — via WhatsApp, powered by a local LLM through [OpenClaw](https://github.com/openclaw/openclaw) and [Ollama](https://ollama.com/).

## Architecture

```
WhatsApp ──► OpenClaw Gateway ──► Ollama (Local LLM)
                │                      │
                ▼                      ▼
         Channel Adapter        Agent Runtime
                │                      │
                ▼                      ▼
         Skills (SKILL.md)      Custom Tools (TS)
                                       │
                    ┌──────────────────┤
                    ▼                  ▼
              Local SQLite     Google Calendar API
              (tasks, habits,    (via service_account)
               expenses, memory)
```

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
2. **Ollama** installed with a model pulled (e.g., `llama3` or `nous-hermes`)
3. **OpenClaw** installed and onboarded
4. **Google service account** JSON file (for Calendar API)

See [`docs/MAC_MINI_SETUP_GUIDE.md`](docs/MAC_MINI_SETUP_GUIDE.md) for detailed setup instructions.

## Status

🚧 **Pre-deployment** — Code is prepared, awaiting Mac Mini hardware.
