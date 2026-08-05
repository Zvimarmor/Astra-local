# Media Access — RETIRED 2026-08-05

**This skill is disabled and its tool no longer exists.** Kept only as a record of
what was here and how to bring it back.

## Why it was retired

It documented exactly one tool, `assistant_utils(action="list_whatsapp_media")`,
which read the `whatsapp_media` SQLite table. That table was filled by
`services/whatsapp-listener.ts` — a second, independent Baileys client that was
**never once linked in 47 days of running**: empty `data/whatsapp_auth/`, 0 rows
in `whatsapp_media`, 0 files in `data/media/whatsapp/`, but 145,388 QR pairing
attempts and a 43 MB log. The listener was stopped and disabled on 2026-08-05, so
the table is now permanently empty and the tool could only ever answer "no media
found".

Removing it also buys back tool-schema budget, which is scarce on a local 8B model
(see CLAUDE.md — the full schema set is what pushes the system prompt toward
context overflow).

Inbound WhatsApp media is **not** lost: the OpenClaw gateway captures it natively
into `~/.openclaw/media/inbound/` and hands it to the agent as part of the message.

## To restore

1. Link `services/whatsapp-listener.ts` for real (`launchctl enable` +
   `bootstrap gui/$UID ~/Library/LaunchAgents/com.astra.whatsapp-listener.plist`,
   then scan the QR it prints) — and first decide whether a second Baileys client
   on the same number is worth the account risk.
2. Restore `tools/whatsapp-media.ts` and `getRecentWhatsAppMedia()` in
   `tools/storage.ts` from git history (removed in the same commit that moved this
   file here).
3. Re-add the `list_whatsapp_media` action, its `count`/`media_type` params, and
   the `whatsappMediaTools` import to `assistant_utils` in
   `tools/registry/mega-tools.ts`.
4. Move this directory back to `skills/media_access/` and restore its guidance from
   git history.

<!-- NOTE (2026-07-06), unrelated to the retirement above: chat email access
     (manage_email) was removed to shrink the model's prompt for speed. The 17:00
     email_digest is still sent by the deterministic scheduler
     (services/scheduler.ts → email-digest.js), which does NOT use any skill. To
     restore chat email access, re-enable the manage_email tool in
     tools/registry/mega-tools.ts and add its guidance to a skill file. -->
