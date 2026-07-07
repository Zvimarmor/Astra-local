# Media Access — Read-Only Skill

## When to Activate
- User asks about received WhatsApp photos, images, or media: "what pics did I get?", "show me recent photos", "any new images on WhatsApp?"

## Tools Available
- `assistant_utils(action="list_whatsapp_media", count?, media_type?)` — List recently received WhatsApp media (images, videos, documents).

## WhatsApp Media

### Usage
When the user asks about photos or media received on WhatsApp, call `assistant_utils(action="list_whatsapp_media")`.
- Default: returns the 10 most recent media files.
- Use `media_type` to filter: "image", "video", or "document".
- Results include: sender phone number, media type, caption (if any), timestamp, and local file path.

### Limitations
- **Read-only**: You can list and describe received media. You CANNOT send messages or media on WhatsApp.
- Media is saved locally by a background listener service. If the listener is not running, no new media is captured.

## Rules
1. Never claim you can send messages or media. You are read-only.

<!-- NOTE (2026-07-06): chat email access (manage_email) was removed to shrink
     the model's prompt for speed. The 17:00 email_digest is still sent by the
     deterministic scheduler (services/scheduler.ts → email-digest.js), which
     does NOT use this skill. To restore chat email access, re-enable the
     manage_email tool in tools/registry/mega-tools.ts and add its guidance
     back here (see git history of this file). -->
