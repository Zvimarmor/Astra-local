import { config } from './config';

/**
 * Outbound Telegram — the out-of-band ALERT channel.
 *
 * Telegram was Astra's primary channel before the WhatsApp migration; its bot
 * token + owner chat id are still in .env as a LEGACY fallback. Unlike WhatsApp
 * (which has no bot HTTP API and depends on a fragile linked Web session), Telegram
 * sends via a plain HTTPS Bot API call with no session state — so it still works
 * when the WhatsApp channel has silently unlinked itself. That makes it the ideal
 * carrier for "your primary channel is down" alerts (see tools/alert.ts, used by
 * the scheduler's channel watchdog).
 *
 * Never throws — returns false on any failure so callers can log-and-continue.
 */

const SEND_TIMEOUT_MS = 15000;

/** Send a plain-text alert to the owner's Telegram chat. Returns success. */
export async function sendTelegramText(text: string): Promise<boolean> {
    const { botToken, ownerChatId } = config.telegram;
    if (!botToken || !ownerChatId) {
        console.error('[Telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set — cannot send alert.');
        return false;
    }
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ownerChatId, text, disable_web_page_preview: true }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error('[Telegram] send failed:', res.status, body.slice(0, 200));
            return false;
        }
        return true;
    } catch (err: any) {
        console.error('[Telegram] send error:', String(err?.message || err).slice(0, 200));
        return false;
    }
}
