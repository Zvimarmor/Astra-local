# Media Access — Read-Only Skill

## When to Activate
- User asks about received WhatsApp photos, images, or media: "what pics did I get?", "show me recent photos", "any new images on WhatsApp?"
- User asks about email: "check my email", "any new emails?", "what's in my inbox?", "read the email from [person]"

## Tools Available
- `list_whatsapp_media(count?, media_type?)` — List recently received WhatsApp media (images, videos, documents).
- `list_recent_emails(count?, account?, folder?)` — List recent emails from a Gmail account.
- `read_email(uid, account?)` — Read the full text content of a specific email by its UID.

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
1. First call `list_recent_emails` to show a summary of recent messages.
2. If the user wants to read a specific email, call `read_email` with the `uid` from the listing.

### Account Selection
The user has two Gmail accounts:
- `"personal"` — Default. The user's personal Gmail.
- `"university"` — The user's university Gmail.

If the user says "check my uni email" or "university inbox", use `account: "university"`.
Otherwise, default to `"personal"`.

### Limitations
- **Read-only**: You can list and read emails. You CANNOT send, reply to, forward, or delete emails.
- You CANNOT download attachments (to avoid filling disk). You can tell the user an attachment exists and its filename.

## Rules
1. Never claim you can send messages, emails, or media. You are read-only.
2. Always specify which account you are checking when reporting email results.
3. If IMAP credentials are not configured, tell the user to set them in the .env file.
4. Keep email summaries concise — show subject, sender, and date. Only read full body when asked.
