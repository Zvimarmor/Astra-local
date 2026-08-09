# The Guest Agent

**Live since 2026-08-09.** A second person (the owner's girlfriend) talks to Astra on
WhatsApp and reaches a **completely different assistant** — different agent, different
workspace, different conversation history, different tool surface. She can track her
calories. She cannot see, and cannot be accidentally shown, anything belonging to the
owner.

This document is the map of how that separation is built, because it spans three systems
(this repo, `~/.openclaw/openclaw.json`, and her workspace) and none of them is obvious
from the others.

---

## 1. Why it isn't one layer

"Tell the model not to look at his tasks" is not a security boundary — it's a suggestion
to a language model. The separation is built from three independent layers, and any one of
them failing still leaves the other two standing.

| # | Layer | What it stops | Where it lives |
|---|---|---|---|
| **1** | **Separate agent** | Shared conversation history, shared memory, shared skills | `agents.list[]` + `bindings[]` in `openclaw.json` |
| **2** | **Tool policy** | The owner's MCP tools being offered to her model | `agents.list[gf].tools` (default-deny) |
| **3** | **Separate MCP process** | The owner's tool *code* existing in her session at all | `ASTRA_PROFILE=guest` → `registry/index.ts` |

Layer 3 is the one that matters most and the one most easily lost in a refactor — see §4.

---

## 2. How a message from her is routed

```
WhatsApp DM from +9725473… ─► OpenClaw gateway
                                  │
                                  │ bindings[]: peer-exact match wins over
                                  │ account, channel, and the default agent
                                  ▼
                            agent "gf"
                              workspace-gf/         (own IDENTITY, USER, skills)
                              agents/gf/agent/      (own session store — no shared history)
                              tools.profile=minimal (default-deny)
                              tools.alsoAllow=[astra-guest-tools__*]
                                  │
                                  ▼
              node dist/mcp-server.js   ENV: ASTRA_PROFILE=guest
                                  │
                                  ▼
                registry/index.ts → guest-tools.ts → nutrition.ts
                                  │
                                  ▼
                   nutrition-store.ts  (own SQLite handle, nutrition_* tables only)
```

Anyone who is **not** her falls through to the default agent `main`, unchanged.

Bindings are matched most-specific-first: exact peer → parent peer → peer wildcard →
guild+roles → guild → team → account → channel → default agent. Hers is an exact peer
match, so it cannot be shadowed by a broader rule added later.

---

## 3. The two tool surfaces

`ASTRA_PROFILE` selects which registry `tools/mcp-server.ts` serves. Both MCP servers run
the *same build*; only the env var differs.

| | `astra-tools` (owner) | `astra-guest-tools` (guest) |
|---|---|---|
| env | *(unset)* → `owner` | `ASTRA_PROFILE=guest` |
| tools | 10 mega-tools + `tools/private/*` | `track_nutrition` only |
| modules loaded | storage, tasks, calendar, expenses, notes, spotify, private… | config, nutrition, nutrition-store |
| bound to | agent `main` | agent `gf` |

Verify the split at any time:

```bash
ASTRA_PROFILE=guest node -e "
const {toolRegistry}=require('./dist/registry/index.js');
console.log(Object.keys(toolRegistry));
console.log(Object.keys(require.cache).filter(p=>p.includes('/dist/')).map(p=>p.split('/dist/')[1]));"
```

Expected: `[ 'track_nutrition' ]` and exactly five modules — `config.js`,
`nutrition-store.js`, `nutrition.js`, `registry/guest-tools.js`, `registry/index.js`.
**Anything else in that list is a leak.**

---

## 4. The rule that keeps layer 3 real

`tools/registry/index.ts` loads the owner's mega-tools with a **`require()` inside a
branch**, not a top-level `import`. That is deliberate and load-bearing:

```ts
// ✅ guest process never executes mega-tools.ts / storage.ts
if (astraProfile === 'guest') return { ...require('./guest-tools').guestTools };
return { ...require('./mega-tools').megaTools, ...loadPrivateTools() };
```

A static `import { megaTools } from './mega-tools'` at the top of that file would execute
the owner's entire module graph — storage, tasks, calendar, expenses — inside the guest
process, on every start. The tools would still be filtered out before reaching the model,
but layer 3 would be gone and only policy strings would remain.

Likewise, **`registry/guest-tools.ts` must never import an owner module.** If a future
change needs shared code, move that code into a module that imports nothing from the owner
side.

`loadPrivateTools()` is also inside the owner branch. `tools/private/` carries
`run_claude_code` — arbitrary code execution on this machine. It must never load in a
guest process.

---

## 5. What is genuinely shared, and the one honest caveat

**Shared:** the SQLite *file* (`data/memory.db`). Her tables (`nutrition_profile`,
`nutrition_food`, `nutrition_activity`, `nutrition_weight`) are separate tables, all keyed
by `user_id`, opened on a separate connection, and no owner query touches them.

**The caveat:** OpenClaw has no per-agent MCP *server* scoping in 2026.6.8 — `mcp.servers`
is global. So the `astra-tools` server is still connected in her session; its tools are
removed by tool policy before they reach her model. Confirmed in the gateway log:

```
[agents/tool-policy] tool policy removed 11 tool(s) via tools.profile (minimal):
  astra-tools__assistant_utils, astra-tools__manage_calendar, … astra-tools__run_claude_code
```

This is acceptable because her policy is **default-deny**: `profile: minimal` grants
nothing, and only `alsoAllow: ["astra-guest-tools__*"]` adds anything back. The failure
mode of a typo is therefore "she loses her own tool", never "she gains his". Do not
replace `profile: minimal` with a bare `deny` list — that inverts the failure direction.

The reverse block is in place too: `agents.main.tools.deny` includes
`astra-guest-tools__*`, so the owner's agent cannot read her food log either.

---

## 6. Her capability: nutrition tracking

One tool, `track_nutrition`, with nine actions: `get_profile`, `set_profile`, `log_food`,
`log_activity`, `today`, `report`, `history`, `log_weight`, `delete_entry`.

**The calorie model.** Mifflin-St Jeor BMR × an activity factor gives `base_tdee`; the
goal applies a deficit/surplus; logged workouts are **added on top of the day's allowance**:

```
remaining = daily_target + burned_today − eaten_today
```

`activity_level` therefore describes **non-exercise** movement only. Setting it high *and*
logging workouts double-counts every session — which is why the default is `sedentary` and
the skill explains the choice in those terms.

**Safety rails, all of which report themselves rather than acting silently:**

- `goal_rate_kg_week` is capped at 1 kg/week.
- `daily_target` has a floor (1200 kcal female / 1500 male). When it fires, `notes` says so
  and the skill relays it.
- The default rate is **0.25 kg/week**, not 0.5 — for a smaller sedentary person 0.5 puts
  the target *under* the floor, which would mean the floor fired on nearly every new profile.
- Implausible height/weight/age are rejected with a "re-ask" error rather than silently
  producing a nonsense target.

**Calories are estimated by the model, not looked up.** The tool stores what the model
passes in. This is what makes free-text Hebrew food descriptions work at all; the skill
requires the agent to state its estimate so she can correct it, and every entry is
deletable.

### Proactive messages

Two deterministic scheduler jobs, built straight from SQLite with **no LLM in the loop** —
so they cannot invent a number she didn't log, and they keep working when the Gemini
free-tier quota is exhausted.

| Job | Time | Behavior |
|---|---|---|
| `guest_nutrition_checkin` | 18:00 daily | Silent unless >700 kcal (`GUEST_NUDGE_THRESHOLD_KCAL`) still unused |
| `guest_nutrition_report` | 21:00 daily | Full Hebrew end-of-day summary; silent if she hasn't onboarded |

Both are in `GUEST_JOBS` in `services/scheduler.ts`, which means:

1. They deliver to `GUEST_WHATSAPP_TARGET` via `notifyGuest()` — **not** `notifyOwner()`.
   There is deliberately **no out-of-band fallback**: if WhatsApp fails, the message is
   dropped and logged. Her calorie report must never be re-routed to the owner's alert
   email or Telegram.
2. Night quiet (22:00–07:00) still applies. **Shabbat quiet does not** — that is the
   owner's preference, not hers (`GUEST_BYPASS_SHABBAT=false` to change).

The "you're running out of calories" warning is *not* a scheduler job — `log_food` returns
a `warning` field the moment the budget gets low or goes negative, so it reaches her in the
same reply.

---

## 7. Operating it

**Her first message needs approval.** `dmPolicy` is `pairing`, so an unknown number
triggers a pending request (expires after 1 hour, max 3 queued):

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

**After changing anything under `tools/`:**

```bash
npm run build && npm run build:services   # tools build MUST come first
launchctl kickstart -k gui/501/com.astra.scheduler
```

**After changing her skill** — remember plane C: OpenClaw loads skills from the *workspace*,
not this repo.

```bash
cp skills/nutrition/SKILL.md ~/.openclaw/workspace-gf/skills/nutrition/SKILL.md
```

Note her workspace is `workspace-gf/`, **not** the owner's `workspace/`. Copying a guest
skill into the owner's workspace would put her tooling guidance in his agent's prompt.

**Test a turn without touching WhatsApp:**

```bash
openclaw agent -m "כמה קלוריות נשארו לי?" --agent gf
```

**Verify the isolation after any change** — run the §3 snippet, then confirm both
directions in `~/Library/Logs/openclaw/gateway.log`:

- `tool policy removed 11 tool(s) … astra-tools__*` under the `gf` agent
- `tool policy removed 1 tool(s) via agents.main.tools.deny … astra-guest-tools__track_nutrition`

**Adding a second guest** costs one binding, one `agents.list` entry, and a `user_id` —
every nutrition table is already keyed by it. `GUEST_USER` in `tools/nutrition.ts` is
currently a constant; it would become a per-agent value.

---

## 8. Turning it off

```bash
openclaw config set bindings '[]'          # her messages fall through to `main`
openclaw gateway restart
```

Her data stays in the `nutrition_*` tables. To stop the proactive messages as well, unset
`GUEST_WHATSAPP_TARGET` (the jobs then skip themselves) or disable the two rows in
`schedules`.
