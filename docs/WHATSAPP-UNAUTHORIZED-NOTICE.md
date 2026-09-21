# The polite Hebrew redirect for unknown WhatsApp senders

*Added 2026-09-21.*

Astra's WhatsApp line (`+972539037993`) is not the owner's personal number. People
who find it and write to it used to receive OpenClaw's built-in pairing block:

```
OpenClaw: access not configured.

Your WhatsApp phone number: +9725…
Pairing code:
…
Ask the bot owner to approve with:
openclaw pairing approve whatsapp …
```

That is a confusing thing to send a stranger. It is now replaced by:

```
היי! זהו מספר ייעודי של העוזרת האישית שלי (אסטרה) 🤖.
לתקשורת ישירה איתי, מוזמנים לכתוב למספר הראשי שלי: <OWNER_PRIMARY_NUMBER>.
שיהיה יום מעולה!
```

sent **at most once per sender per 7 days**.

---

## 1. Why this could not be built inside this repo

This is the important part, and it is the reason the implementation looks the way
it does. **An unauthorized DM never reaches Astra.**

OpenClaw's WhatsApp plugin gates inbound messages in
`checkInboundAccessControl()`, and its caller drops the message on the spot:

```js
// @openclaw/whatsapp/dist/monitor-Ggwn3FDi.js
const access = await checkInboundAccessControl({ … });
if (!access.allowed) return null;     // ← message dies here
```

Everything Astra owns lives *downstream* of that line:

| Surface | Reaches unauthorized DMs? | Why not |
| --- | --- | --- |
| MCP mega-tools (`tools/`) | ✗ | The model is never invoked; no session exists. |
| `message:received` internal hook | ✗ | Fired from `dispatch`, and only `if (sessionKey)`. Dispatch is never reached. |
| `services/whatsapp-listener.ts` | ✗ | Separate read-only Baileys socket; it cannot send, by design. |
| A config key | ✗ | No `pairingMessage`/`unauthorizedMessage` key exists for any channel. |

`issuePairingChallenge()` *does* accept a `buildReplyText` override — but it is a
plugin-SDK parameter, and the WhatsApp plugin does not pass it through to any
config. So the only place the text can be changed is inside the plugin.

### Options that were rejected

- **`dmPolicy: "allowlist"`** — blocks strangers silently. Kills the spam, but
  nobody gets the redirect either. This is the zero-maintenance fallback if the
  patch below ever becomes a nuisance.
- **`dmPolicy: "open"` + a locked-down "stranger" agent binding** — would let the
  model answer. Rejected: it exposes the agent to anyone, makes a deterministic
  auto-reply nondeterministic, and burns the free-tier Gemini quota
  (~20 requests/day, shared project-wide) on strangers.
- **Forking and pinning the plugin tarball** via
  `OPENCLAW_PLUGIN_INSTALL_OVERRIDES` — survives reinstalls more cleanly, but
  OpenClaw documents overrides as test-only and it means carrying a 57 MB fork.

## 2. What was actually done

Three pieces:

**`tools/unauthorized-notice.ts`** — the message text plus
`claimUnauthorizedNotice(sender)`, an atomic check-and-set against the
`unauthorized_sender_notices` table that returns the text to send, or `null` to
stay silent.

The owner's primary number is **not** hardcoded — this repo is public, and a
personal mobile number in git history is forever. It lives in `.env`
(gitignored) as `OWNER_PRIMARY_NUMBER`, with a placeholder in `.env.example`.
Reading it takes a little care because of the no-dotenv rule below: the gateway
is launched by launchd and inherits none of our `.env`, so `process.env` alone
is empty there, while calling dotenv is exactly what we are avoiding. So the
module parses that one key straight out of the file and never touches
`process.env`. **If the key is unset, no message is sent at all** — better
silence than a reply quoting `05X-XXXXXXX`.

This module is **deliberately dependency-light** and does *not* import
`tools/config.ts` or `tools/storage.ts`, because it is loaded **inside the
OpenClaw gateway process**:

- `tools/config.ts` runs `dotenv` on import, which would inject all ~45 keys of
  our `.env` into the gateway — including `PORT` and `GEMINI_API_KEY`. Silently
  repointing the gateway's port is not an acceptable price for a cooldown check.
- It opens its own `better-sqlite3` connection. Safe, because `tools/storage.ts`
  puts `data/memory.db` in WAL mode.

It **fails closed**: if the DB is unreachable it returns `null`. A stranger
getting no reply is a far smaller failure than a stranger getting one reply per
message because the ledger could not be written.

**`tools/storage.ts`** — the same table plus `claimSenderNotice()` /
`isSenderOnNoticeCooldown()` / `recordSenderNotice()`, for use from Astra's own
processes. Both modules read and write the same rows.

```sql
CREATE TABLE unauthorized_sender_notices (
    sender_e164      TEXT PRIMARY KEY,   -- bare digits, no '+'
    last_notified_at INTEGER NOT NULL    -- ms epoch
);
```

Keys are normalized to **bare digits**: the same human arrives as `+972…`,
`972…` or a LID-resolved form depending on the code path (the same dual-form
trap the `gf` agent bindings document), and three spellings would mean three
notices.

**`scripts/patch-whatsapp-notice.js`** — applies the change to the installed
plugin. Two hunks: a lazy `createRequire` bridge at the top (the plugin is ESM,
our `dist/` is CommonJS), and a replacement of `sendPairingReply`:

```js
sendPairingReply: async (_text) => {          // _text IS the pairing block —
    let __astraMsg = null;                    // discarding it is the suppression
    try { __astraMsg = __astraNotice().claimUnauthorizedNotice(candidate); }
    catch (err) { console.error("[ASTRA-UNAUTHORIZED-NOTICE] …", err); }
    if (!__astraMsg) return;
    await params.sock.sendMessage(params.remoteJid, { text: __astraMsg });
},
```

The surrounding `createChannelPairingChallengeIssuer(…)` call is left intact, so
the pairing *request* is still recorded. `openclaw pairing list whatsapp` and
`openclaw pairing approve whatsapp <CODE>` still work for admitting someone for
real — the stranger just never sees the code.

## 3. Operating it

```bash
npm run build                  # dist/unauthorized-notice.js must exist first
npm run patch:whatsapp         # idempotent
npm run patch:whatsapp:check   # exit 0 = patched
openclaw gateway restart
```

`node scripts/patch-whatsapp-notice.js --revert` restores the `.astra-orig`
backup the first apply wrote next to the bundle.

### ⚠ Re-apply after every plugin update

The patched file lives at

```
~/.openclaw/npm/projects/openclaw-whatsapp-*/node_modules/@openclaw/whatsapp/dist/access-control-*.js
```

which is **outside this repo** and is replaced by any `openclaw plugins update`
or reinstall. After one, run `npm run patch:whatsapp` and restart the gateway.
The script locates the bundle by content (its hash suffix changes per release),
so a renamed file is fine.

If the plugin's internals change, the script **refuses to patch** rather than
guessing, and prints which hunk it could not find. Re-read the file and update
`ORIGINAL_HUNK` — do not force it.

### Changing the message or the number

The number is `OWNER_PRIMARY_NUMBER` in `.env` — no rebuild needed, it is read
from the file (cached per process, so it takes effect on the gateway's next
start). For the wording, edit `buildUnauthorizedRedirectMessage()` in
`tools/unauthorized-notice.ts`, then `npm run build`.

Either way **no re-patch is needed** — the patched plugin `require()`s the
compiled module lazily, so the change is picked up on the gateway's next start.
Restart the gateway to apply it immediately.

### Resetting a sender's cooldown

```bash
sqlite3 data/memory.db "DELETE FROM unauthorized_sender_notices WHERE sender_e164='972500001111';"
```

## 4. How it was verified

Driving the real `checkInboundAccessControl()` with a stub socket and an
unapproved number, three messages in a row:

```
msg 1: allowed=false sentSoFar=1
msg 2: allowed=false sentSoFar=1
msg 3: allowed=false sentSoFar=1
pairing-code text leaked? no
```

Then, to prove the **cooldown** is doing the work rather than OpenClaw's own
"already requested" gate, the pending pairing request was deleted and the same
three messages replayed. A brand-new pairing request was created
(`whatsapp pairing request sender=…` logged) and still:

```
msg 1: allowed=false sentSoFar=0
```

Zero sends — suppressed by the 7-day ledger alone.

Not covered by that test: delivery from a genuine third-party handset. The stub
replaces `sock.sendMessage`, so the send path itself is exercised only as far as
the plugin's own socket call.
