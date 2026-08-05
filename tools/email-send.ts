import path from 'path';
import { config } from './config';

/**
 * Outbound email — a SECOND out-of-band alert channel (belt & suspenders with
 * Telegram; see tools/alert.ts).
 *
 * Astra's normal email stack is READ-ONLY IMAP (no SMTP). For alerts we open a
 * one-off SMTP connection via nodemailer. Gmail app passwords work for both IMAP
 * and SMTP, so this reuses the personal IMAP creds by default — set dedicated
 * SMTP_USER / SMTP_PASSWORD only if you want a different sender.
 *
 * ⚠ Inert until an app password is present: if no SMTP password resolves, this
 * logs once and returns false (it never throws). Telegram remains the always-on
 * fallback, so a missing app password doesn't leave you with no alert path.
 *
 * nodemailer is required lazily as `any` (it ships transitively via imapflow /
 * mailparser) so the tools build needs no @types/nodemailer.
 */

const SEND_TIMEOUT_MS = 20000;

function smtpUser(): string {
    return config.smtp.user || config.imapAccounts.personal.user || '';
}
function smtpPass(): string {
    return config.smtp.password || config.imapAccounts.personal.password || '';
}

/** Send a plain-text alert email to config.alertEmail. Returns success. */
export async function sendEmailAlert(subject: string, text: string): Promise<boolean> {
    const to = config.alertEmail;
    const user = smtpUser();
    const pass = smtpPass();
    if (!to) {
        console.error('[Email] ALERT_EMAIL not set — cannot send alert email.');
        return false;
    }
    if (!user || !pass) {
        console.error('[Email] No SMTP credentials (set SMTP_PASSWORD or IMAP_PASSWORD, a Gmail app password) — skipping email alert.');
        return false;
    }
    try {
        // Lazy, untyped require: keeps the dep out of the type graph (no @types needed).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nodemailer: any = require(path.join('nodemailer'));
        const transport = nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.port === 465, // 465 = implicit TLS; 587 = STARTTLS
            auth: { user, pass },
            connectionTimeout: SEND_TIMEOUT_MS,
            greetingTimeout: SEND_TIMEOUT_MS,
        });
        await transport.sendMail({
            from: config.smtp.from || user,
            to,
            subject,
            text,
        });
        return true;
    } catch (err: any) {
        console.error('[Email] send error:', String(err?.message || err).slice(0, 250));
        return false;
    }
}
