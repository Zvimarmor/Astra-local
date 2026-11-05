/**
 * Hebrew notice sent on WhatsApp when a chat turn fails before the agent replies.
 *
 * WHY THIS EXISTS: when the whole model chain fails (Google 503 "overloaded",
 * 429 quota, …) OpenClaw does build an English error reply — but the WhatsApp
 * plugin drops every `isError` payload (`resolveWhatsAppDeliverablePayload`:
 * `if (payload.isError === true) return null`). The user saw "typing…" and then
 * nothing, which reads as "Astra is broken" when it's really "Google is busy".
 * scripts/patch-whatsapp-failure-notice.js patches that one line to call
 * `failureNoticeText()` instead, so a final failure becomes this short note.
 *
 * Runs INSIDE the gateway process (required from the patched plugin), so it must
 * stay dependency-free: no config.ts (dotenv would inject our .env into the
 * gateway), no storage.ts. A pure string function — editing the wording only
 * needs `npm run build`, not a re-patch.
 *
 * Every notice ends with the original error, because a friendly catch-all hid the
 * real cause on 2026-11-05. The plugin serves the guest number too, so it's reduced
 * to one line with paths and key-like strings removed.
 */

const CONTEXT_RE = /context overflow|prompt too large|context length|too many tokens|compaction/i;
const OVERLOADED_RE = /overload|high demand|503|unavailable|temporarily/i;
const QUOTA_RE = /rate.?limit|quota|429|resource_exhausted|too many requests|cooldown/i;
const TIMEOUT_RE = /timed? ?out|timeout|deadline exceeded/i;

const DETAIL_MAX_CHARS = 200;

/** The original error as one safe line, or '' if there's nothing to show. */
function errorDetail(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .replace(/(?:\/[\w.@+-]+){2,}/g, '<path>')
        .replace(/\b(?:AIza|sk-|ya29\.|AQ\.)[\w.-]+/g, '<key>')
        .trim()
        .slice(0, DETAIL_MAX_CHARS);
}

function friendlyNotice(t: string): string {
    if (CONTEXT_RE.test(t)) {
        return '⚠️ השיחה של היום ארוכה מדי למודל הגיבוי, ו-Google לא זמין כרגע. שלח /new כדי להתחיל שיחה חדשה — המשימות והנתונים שלך שמורים, רק ההקשר של השיחה יתאפס.';
    }
    if (QUOTA_RE.test(t)) {
        return '⚠️ הגעתי למכסת הבקשות של Google להיום (או לרגע). נסה שוב מאוחר יותר — המשימות והנתונים שלך שמורים, לא נפגע כלום.';
    }
    if (OVERLOADED_RE.test(t)) {
        return '⚠️ השרתים של Google עמוסים כרגע ולא הצלחתי לענות. נסה שוב בעוד כמה דקות — המשימות והנתונים שלך שמורים, לא נפגע כלום.';
    }
    if (TIMEOUT_RE.test(t)) {
        return '⚠️ התשובה לקחה יותר מדי זמן ונקטעה. נסה לשאול שוב.';
    }
    return '⚠️ משהו השתבש ולא הצלחתי לענות הפעם. נסה שוב בעוד רגע.';
}

/** OpenClaw's original (English) error text → the Hebrew note to send instead. */
export function failureNoticeText(originalText: unknown): string {
    const t = String(originalText ?? '');
    const detail = errorDetail(t);
    return detail ? `${friendlyNotice(t)}\n\n🔧 ${detail}` : friendlyNotice(t);
}
