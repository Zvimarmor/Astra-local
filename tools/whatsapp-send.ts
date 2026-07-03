import { execFile } from 'child_process';
import { config } from './config';

/**
 * Outbound WhatsApp — via the OpenClaw gateway CLI.
 *
 * WhatsApp has no bot HTTP API (unlike Telegram's sendMessage). So both the
 * proactive scheduler and voice replies push through
 *   openclaw message send --channel whatsapp --target <E.164>
 * which reuses the single linked WhatsApp session the interactive agent uses —
 * no second login, no second socket. Text and media (voice notes) both route
 * through here.
 *
 * Shared by tools/ (voice) and, via the compiled dist/whatsapp-send.js, by the
 * standalone services/scheduler.ts (same require() pattern it uses for storage).
 */

const SEND_TIMEOUT_MS = 30000;

function ocSend(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(config.whatsapp.openclawBin, args, { timeout: SEND_TIMEOUT_MS }, (err, _stdout, stderr) => {
            if (err) {
                console.error('[WhatsApp] send failed:', String(stderr || err.message || '').slice(0, 300));
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

function baseArgs(target: string): string[] {
    return ['message', 'send', '--channel', 'whatsapp', '--account', config.whatsapp.account, '--target', target];
}

function resolveTarget(target?: string): string {
    return (target || config.whatsapp.ownerTarget).trim();
}

/** Send a text message to the owner (or an explicit E.164 target). Returns success. */
export async function sendWhatsAppText(text: string, target?: string): Promise<boolean> {
    const to = resolveTarget(target);
    if (!to) {
        console.error('[WhatsApp] WHATSAPP_OWNER_TARGET not set — cannot send.');
        return false;
    }
    return ocSend([...baseArgs(to), '--message', text]);
}

/** Send a media file (e.g. an OGG/Opus voice reply) with an optional caption. */
export async function sendWhatsAppMedia(mediaPath: string, target?: string, caption?: string): Promise<boolean> {
    const to = resolveTarget(target);
    if (!to) {
        console.error('[WhatsApp] WHATSAPP_OWNER_TARGET not set — cannot send.');
        return false;
    }
    const args = [...baseArgs(to), '--media', mediaPath];
    if (caption) args.push('--message', caption);
    return ocSend(args);
}
