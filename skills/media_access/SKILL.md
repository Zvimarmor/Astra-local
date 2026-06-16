# Media Access — Read-Only Skill

## When to Activate
- User asks about received WhatsApp photos, images, or media: "what pics did I get?", "show me recent photos", "any new images on WhatsApp?"
- User asks about email: "check my email", "any new emails?", "what's in my inbox?", "read the email from [person]"
- User asks for email digest: "email summary", "email digest", "anything new in email?"
- Scheduler triggers email_digest heartbeat (9:00 AM and 5:00 PM)

## Tools Available
- `list_whatsapp_media(count?, media_type?)` — List recently received WhatsApp media (images, videos, documents).
- `list_recent_emails(count?, account?, folder?)` — List recent emails from a Gmail account.
- `read_email(uid, account?)` — Read the full text content of a specific email by its UID.
- `get_email_digest()` — Quick summary of unread emails across all accounts (envelope metadata only).

## WhatsApp Media

### Usage
When the user asks about photos or media received on WhatsApp, call `list_whatsapp_media`.
- Default: returns the 10 most recent media files.
- Use `media_type` to filter: "image", "video", or "document".
- Results include: sender phone number, media type, caption (if any), timestamp, and local file path.

### Limitations
- **Read-only**: You can list and describe received media. You CANNOT send messages or media on WhatsApp.
- Media is saved locally by a background listener service. If the listener is not running, no new media is captured.

## Email

### Usage
When the user asks about email:
1. For a quick overview, call `get_email_digest()` first — it's fast and lightweight.
2. For detailed listing, call `list_recent_emails` to show subjects and senders.
3. If the user wants to read a specific email, call `read_email` with the `uid` from the listing.

### Email Digest (Scheduler)
The scheduler calls `get_email_digest` at 9 AM and 5 PM. When triggered:
- If there are unread emails, send a summary: "📧 You have 3 unread emails — 1 from university, 2 personal."
- If there are no unread emails, do NOT send a message (stay silent).
- The digest only reads envelope metadata — the agent stays OUTSIDE Gmail.

### Account Selection
The user has two Gmail accounts:
- `"personal"` — Default. The user's personal Gmail.
- `"university"` — The user's university Gmail.

If the user says "check my uni email" or "university inbox", use `account: "university"`.
Otherwise, default to `"personal"`.

### Limitations
- **Read-only**: You can list and read emails. You CANNOT send, reply to, forward, or delete emails.
- You CANNOT download attachments (to avoid filling disk). You can tell the user an attachment exists and its filename.
- Email content is NEVER stored in the database — only displayed to the user.

## Rules
1. Never claim you can send messages, emails, or media. You are read-only.
2. Always specify which account you are checking when reporting email results.
3. If IMAP credentials are not configured, tell the user to set them in the .env file.
4. Keep email summaries concise — show subject, sender, and date. Only read full body when asked.
5. For the scheduler digest, stay silent if there are no unread emails.
