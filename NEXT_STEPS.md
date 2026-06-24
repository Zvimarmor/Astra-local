# NEXT_STEPS.md

Deployment strategy agreed 2026-06-23. **✅ EXECUTED 2026-06-23.**

> Both parts shipped and verified: model swapped to `qwen3:8b` (validated end-to-end — the
> agent added a real task via MCP→SQLite through Qwen3), and the scheduler gained two
> LLM-phrased analytical jobs (`weekly_recap`, `monthly_finance_review`) with deterministic
> fallback. Gateway + scheduler restarted under launchd. Hermes q4/q8 kept as rollback.

## Decisions (locked)

1. **Local tool-calling model → switch to Qwen3 8B.**
2. **"Recurring complex analytical tasks" → extend the existing deterministic scheduler.**
   **We are NOT deploying Hermes Agent as a second gateway** (see "Why not Hermes Agent" below).

---

## Part 1 — Swap OpenClaw's local model to Qwen3 8B

**Why:** Qwen3 8B is the most stable 8B tool-caller in 2026 benchmarks (rarely drops params or
hallucinates calls) and is ~5GB resident vs ~8.5GB for the current `hermes3:8b-llama3.1-q8_0`
— a quality *and* RAM win on the 16GB Mac Mini.

**Steps:**
1. `ollama pull qwen3:8b` and confirm `ollama ps` shows `100% GPU`.
2. Update the model in **`~/.openclaw/openclaw.json`** (the value OpenClaw actually runs) — prefer
   the `openclaw` CLI over hand-editing; it keeps `.bak`/`.last-good` copies.
3. Update the Ollama model default in **`tools/config.ts`** so config stays in sync, then
   `npm run build` (tools compile flat → `dist/`).
4. **Re-validate all 9 mega-tools** against Qwen3 over MCP: confirm the MCP server still connects
   (a wrong `dist/...` path fails silently) and that each `manage_*` / `assistant_utils` action
   round-trips. Watch the 4096 default `num_ctx` — the full tool-schema system prompt is large;
   bump `num_ctx` if the model loops on hallucinated calls.
5. Keep `hermes3:8b-q8_0` pulled as a one-line rollback in `openclaw.json` until Qwen3 is proven.

**Fallback if Qwen3 tool-calling regresses:** drop Hermes 3 to `q4_K_M` instead (same family/
behavior, ~3–4GB lighter, no schema re-validation needed).

---

## Part 2 — Extend the deterministic scheduler for analytical jobs

**Why this shape (not a second gateway):** the scheduler (`services/scheduler.ts`, launchd
`com.astra.scheduler`) already owns recurring work deterministically — it reads SQLite, formats
the message itself, pushes to Telegram, and keeps `schedule_runs UNIQUE(schedule_id, run_date)`
idempotency so it can't double-send or hallucinate "I sent it," and it runs even when Ollama is
cold. We extend *that*, adding LLM calls only where genuine natural-language analysis is needed.

**Pattern for an analytical job:**
- Add a row to the `schedules` table (e.g. `weekly_recap` Sun 20:00, `monthly_finance_review`
  day_of_month 1) — no rebuild needed for new rows.
- In `services/scheduler.ts`, the job gathers facts **deterministically from SQLite** (totals,
  trends, anomalies), then makes **one** Ollama call with a **fixed prompt** purely to phrase/
  summarize those facts. The numbers come from SQLite, never from the model.
- **Hard rule:** if the Ollama call fails or times out, fall back to the deterministic plain-text
  summary and still send. The LLM is phrasing polish, never the source of truth, and never gates
  the send. Idempotency (`claimScheduleRun` first) stays exactly as-is.

**Candidate analytical jobs to scope:** weekly spend/trend recap, monthly finance review
(income vs expenses, budget drift), habit-streak analysis, "what slipped this week" task review.

---

## Why NOT Hermes Agent (Nous Research) — for the record

Hermes Agent is real and genuinely good at open-ended analytical work (self-authored skills +
a user-modeling/memory loop). We evaluated deploying it and chose not to, because:

- **It's a full second gateway** (own Telegram/Discord/etc. connectors + own LLM), and it
  **rejects any model under 64K context at startup**. A 64K-context 8B needs ~10–12GB; its own
  docs recommend **27B+** for reliable tool-calling.
- The Mac Mini is **16GB and already saturated** (OpenClaw + Ollama + Immich + spotifyd +
  scheduler + WhatsApp listener + dashboard). Two concurrent local agent gateways won't fit.
- It overlaps our deterministic scheduler and would re-introduce the LLM-in-the-loop send risk
  we deliberately engineered out.

**Corrections to the original brief (these would have silently failed):**
- Config file is **`~/.hermes/config.yaml`** (YAML), *not* `~/.hermes/config.toml`.
- There is **no `skill_generation` key** — the real keys are `skills.guard_agent_created` /
  `skills.write_approval`.
- There is **no `user_modeling` key** — the real keys are `memory.memory_enabled` /
  `memory.user_profile_enabled`.

**If we ever revisit Hermes:** run it **headless pointed at a cloud model** (OpenRouter) so it
never competes for local RAM — set `auxiliary`/model `base_url` to the provider, keep all local
inference for OpenClaw. That was the only deployment shape that fit the hardware.

---

## Sources

- [Best Ollama Models — Coding, RAG & Agents (June 2026), Morph](https://www.morphllm.com/best-ollama-models)
- [Best Ollama Models for 8GB RAM 2026, Local AI Master](https://localaimaster.com/blog/best-local-ai-models-8gb-ram)
- [Hermes Agent — Configuration docs (GitHub)](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)
- [Hermes Agent — Run Locally with Ollama](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup)
- [Hermes Agent — requirements (Markaicode)](https://markaicode.com/hermes-agent-requirements/)
