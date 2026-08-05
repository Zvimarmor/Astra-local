import { sendTelegramText } from './telegram-send';
import { sendEmailAlert } from './email-send';

/**
 * Out-of-band alerts — fan out to every channel that does NOT depend on the
 * primary WhatsApp session, so an operational fault (e.g. WhatsApp unlinked)
 * still reaches the user.
 *
 * Currently: Telegram (always-on, no setup) + email (activates once a Gmail app
 * password is in .env). Returns which carriers succeeded; `delivered` is true if
 * at least one did.
 */

export interface AlertResult {
    telegram: boolean;
    email: boolean;
    delivered: boolean;
}

/**
 * Send `text` out of band. `subject` is used as the email subject; Telegram gets
 * the body only. Both carriers are attempted in parallel and neither can throw.
 */
export async function sendOutOfBandAlert(subject: string, text: string): Promise<AlertResult> {
    const [telegram, email] = await Promise.all([
        sendTelegramText(text),
        sendEmailAlert(subject, text),
    ]);
    return { telegram, email, delivered: telegram || email };
}
