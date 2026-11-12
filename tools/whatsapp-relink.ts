import { execFile } from 'child_process';
import path from 'path';
import { config } from './config';

/**
 * Relink WhatsApp from your phone: the login QR is delivered to the owner's Telegram chat.
 *
 * WHY: when WhatsApp logs Astra out (401 "conflict", 5 times Jul–Nov 2026), relinking used
 * to need a screen-share into the Mac Mini to scan a QR printed in a terminal. The gateway
 * exposes the same login as RPC: `web.login.start` returns the QR as a PNG data URL and
 * `web.login.wait` reports a refreshed QR or a completed link. This drives those two
 * calls and puts the image in Telegram, which keeps working while WhatsApp is down.
 *
 * SAFETY
 * - Scanning the QR gives control of Astra's WhatsApp account, so it goes ONLY to
 *   config.telegram.ownerChatId, and `/qr` is accepted only from that chat.
 * - `web.login.start` stops the WhatsApp channel before it starts, so it must never run
 *   while WhatsApp is linked. The scheduler only calls this after its health probe says
 *   linked=false, and `force` is never passed: on a linked account the gateway answers
 *   "already linked" without a QR.
 *
 * Never throws. Used by services/scheduler.ts.
 */

const TG_TIMEOUT_MS = 15_000;
const SESSION_MS = 4 * 60_000;     // one relink session: about 6 QR refreshes
const WAIT_SLICE_MS = 25_000;      // one web.login.wait call

const GW_PATH = [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter);

function gatewayCall(method: string, params: Record<string, any>, timeoutMs: number): Promise<{ ok: boolean; result?: any; error?: string }> {
    return new Promise((resolve) => {
        execFile(
            config.whatsapp.openclawBin,
            ['gateway', 'call', method, '--json', '--params', JSON.stringify(params), '--timeout', String(timeoutMs)],
            { timeout: timeoutMs + 15_000, env: { ...process.env, PATH: GW_PATH }, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) return resolve({ ok: false, error: String(stderr || err.message || '').slice(0, 300) });
                const text = String(stdout);
                const start = text.indexOf('{');
                try {
                    return resolve({ ok: true, result: JSON.parse(start >= 0 ? text.slice(start) : text) });
                } catch {
                    return resolve({ ok: false, error: `unparseable reply: ${text.slice(0, 200)}` });
                }
            },
        );
    });
}

// ─── Telegram (owner chat only) ───────────────────────────────────────

async function tg(method: string, body: FormData | Record<string, any>): Promise<any | null> {
    const { botToken } = config.telegram;
    if (!botToken) return null;
    try {
        const isForm = body instanceof FormData;
        const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
            method: 'POST',
            headers: isForm ? undefined : { 'Content-Type': 'application/json' },
            body: isForm ? body : JSON.stringify(body),
            signal: AbortSignal.timeout(TG_TIMEOUT_MS),
        });
        const data: any = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
            console.error(`[Relink] telegram ${method} failed:`, res.status, JSON.stringify(data)?.slice(0, 200));
            return null;
        }
        return data.result;
    } catch (err: any) {
        console.error(`[Relink] telegram ${method} error:`, String(err?.message || err).slice(0, 200));
        return null;
    }
}

function pngFromDataUrl(dataUrl: string): Blob | null {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
    return m ? new Blob([new Uint8Array(Buffer.from(m[1], 'base64'))], { type: 'image/png' }) : null;
}

export async function sendRelinkText(text: string): Promise<boolean> {
    const chat = config.telegram.ownerChatId;
    return !!chat && !!(await tg('sendMessage', { chat_id: chat, text }));
}

export async function sendQr(dataUrl: string, caption: string): Promise<number | null> {
    const png = pngFromDataUrl(dataUrl);
    if (!png || !config.telegram.ownerChatId) return null;
    const form = new FormData();
    form.append('chat_id', config.telegram.ownerChatId);
    form.append('caption', caption);
    form.append('photo', png, 'whatsapp-qr.png');
    const r = await tg('sendPhoto', form);
    return r?.message_id ?? null;
}

export async function replaceQr(messageId: number, dataUrl: string, caption: string): Promise<boolean> {
    const png = pngFromDataUrl(dataUrl);
    if (!png) return false;
    const form = new FormData();
    form.append('chat_id', config.telegram.ownerChatId);
    form.append('message_id', String(messageId));
    form.append('media', JSON.stringify({ type: 'photo', media: 'attach://qr', caption }));
    form.append('qr', png, 'whatsapp-qr.png');
    return !!(await tg('editMessageMedia', form));
}

const QR_CAPTION = (n: number) =>
    `🔗 Astra WhatsApp got logged out. Relink:\n` +
    `On Astra's phone (the dedicated number): WhatsApp → Settings → Linked Devices → Link a Device, then scan.\n` +
    `The code refreshes about every 20s; this image updates itself (#${n}).`;

// ─── The relink session ───────────────────────────────────────────────

export type RelinkOutcome = 'linked' | 'expired' | 'already_linked' | 'failed';

/**
 * Start a login, put the QR in Telegram and keep it fresh until linked or ~4 minutes pass.
 * The caller must have checked that WhatsApp is NOT linked (see SAFETY above).
 */
export async function runRelinkSession(): Promise<RelinkOutcome> {
    const { botToken, ownerChatId } = config.telegram;
    if (!botToken || !ownerChatId) {
        console.error('[Relink] TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set — cannot send the QR.');
        return 'failed';
    }
    const account = config.whatsapp.account;
    const start = await gatewayCall('web.login.start', { accountId: account, timeoutMs: 30_000 }, 45_000);
    const startRes = start.result || {};
    if (!start.ok || !startRes.qrDataUrl) {
        const msg = String(startRes.message || start.error || 'no QR returned');
        if (/already linked/i.test(msg)) return 'already_linked';
        await sendRelinkText(`⚠️ Couldn't get a WhatsApp login QR: ${msg.slice(0, 200)}\nSend /qr to try again.`);
        return 'failed';
    }

    let qr: string = startRes.qrDataUrl;
    let version = 1;
    const messageId = await sendQr(qr, QR_CAPTION(version));
    if (!messageId) return 'failed';
    console.log('[Relink] QR sent to Telegram');

    const deadline = Date.now() + SESSION_MS;
    while (Date.now() < deadline) {
        const w = await gatewayCall('web.login.wait', { accountId: account, timeoutMs: WAIT_SLICE_MS, currentQrDataUrl: qr }, WAIT_SLICE_MS + 10_000);
        const r = w.result || {};
        if (r.connected) {
            await sendRelinkText('✅ WhatsApp is linked again. Astra is back on WhatsApp.');
            console.log('[Relink] linked');
            return 'linked';
        }
        if (r.qrDataUrl && r.qrDataUrl !== qr) {
            qr = r.qrDataUrl;
            version += 1;
            await replaceQr(messageId, qr, QR_CAPTION(version));
            continue;
        }
        const msg = String(r.message || w.error || '');
        if (/still waiting/i.test(msg)) continue;
        // Expired, failed, or the login was reset: stop and say so.
        await sendRelinkText(`⌛ The QR is no longer valid (${msg.slice(0, 120) || 'login ended'}). Send /qr for a new one.`);
        return 'expired';
    }
    await sendRelinkText('⌛ The QR expired without a scan. Send /qr for a new one.');
    return 'expired';
}

/**
 * Read new Telegram messages and return true if the owner sent /qr. Only the owner's chat
 * counts. `offset` is persisted by the caller. Returns the next offset.
 */
export async function pollRelinkCommand(offset: number): Promise<{ requested: boolean; nextOffset: number }> {
    const updates = await tg('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
    if (!Array.isArray(updates)) return { requested: false, nextOffset: offset };
    let requested = false;
    let next = offset;
    for (const u of updates) {
        next = Math.max(next, Number(u.update_id) + 1);
        const m = u.message;
        if (m && String(m.chat?.id) === String(config.telegram.ownerChatId) && /^\/qr\b/i.test(String(m.text || '').trim())) requested = true;
    }
    return { requested, nextOffset: next };
}
