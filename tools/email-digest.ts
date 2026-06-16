import { ImapFlow } from 'imapflow';
import { config } from './config';

/**
 * Email Digest Tool — Safe Read-Only Summary
 *
 * Connects to Gmail IMAP, counts unread/recent emails per account,
 * and returns a summary digest. The agent stays OUTSIDE Gmail:
 *   - Only reads envelope metadata (subject, sender, date)
 *   - Never downloads message bodies or attachments
 *   - Never stores email content in the database
 *   - Uses ImapFlow (IMAP only) — no SMTP library imported
 *   - Connection timeout of 10 seconds
 *   - No credentials are logged
 *
 * This is designed for the scheduler heartbeat (9:00 AM and 5:00 PM)
 * and can also be called on demand.
 */

interface EmailDigestEntry {
    account: string;
    total_recent: number;
    unseen: number;
    top_emails: { from: string; subject: string; date: string }[];
    status: 'ok' | 'error' | 'not_configured';
    error?: string;
}

async function getAccountDigest(accountName: string): Promise<EmailDigestEntry> {
    const acct = config.imapAccounts[accountName];

    // Check if account is configured
    if (!acct || !acct.user || !acct.password) {
        return {
            account: accountName,
            total_recent: 0,
            unseen: 0,
            top_emails: [],
            status: 'not_configured',
        };
    }

    let client: ImapFlow | null = null;

    try {
        client = new ImapFlow({
            host: acct.host,
            port: acct.port,
            secure: true,
            auth: {
                user: acct.user,
                pass: acct.password,
            },
            logger: false,
        });

        // Connect with timeout
        const connectTimeout = setTimeout(() => {
            if (client) client.close();
        }, 10000);

        await client.connect();
        clearTimeout(connectTimeout);

        const lock = await client.getMailboxLock('INBOX');

        try {
            // Get mailbox status
            const status = await client.status('INBOX', {
                messages: true,
                unseen: true,
            });

            const total = status.messages || 0;
            const unseen = status.unseen || 0;

            // Fetch the 5 most recent email envelopes (metadata only — no body)
            const topEmails: { from: string; subject: string; date: string }[] = [];

            if (total > 0) {
                const from = Math.max(1, total - 4); // last 5
                for await (const message of client.fetch(`${from}:*`, {
                    envelope: true,
                })) {
                    const env = message.envelope;
                    if (env) {
                        topEmails.push({
                            from: env.from?.[0]?.name || env.from?.[0]?.address || '(unknown)',
                            subject: env.subject || '(no subject)',
                            date: env.date?.toISOString() || '',
                        });
                    }
                }
                topEmails.reverse(); // newest first
            }

            return {
                account: accountName,
                total_recent: Math.min(total, 100), // cap for display
                unseen,
                top_emails: topEmails,
                status: 'ok',
            };
        } finally {
            lock.release();
        }
    } catch (err: any) {
        console.error(`[EmailDigest] Error for ${accountName}:`, err.message);
        return {
            account: accountName,
            total_recent: 0,
            unseen: 0,
            top_emails: [],
            status: 'error',
            error: err.message,
        };
    } finally {
        if (client) {
            try { await client.logout(); } catch { /* ignore */ }
        }
    }
}

export const emailDigestTools = {
    get_email_digest: {
        name: "get_email_digest",
        description: "Get a quick digest of recent emails across all configured accounts. Shows unread count and the latest 5 email subjects per account. Read-only: only reads envelope metadata, never downloads message bodies.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const accountNames = Object.keys(config.imapAccounts);
                const digests: EmailDigestEntry[] = [];

                for (const name of accountNames) {
                    const digest = await getAccountDigest(name);
                    digests.push(digest);
                }

                const totalUnseen = digests.reduce((s, d) => s + d.unseen, 0);
                const configuredCount = digests.filter(d => d.status !== 'not_configured').length;

                if (configuredCount === 0) {
                    return {
                        status: "not_configured",
                        message: "No email accounts configured. Set IMAP_USER and IMAP_PASSWORD in .env to enable email digest.",
                    };
                }

                return {
                    digests,
                    total_unseen: totalUnseen,
                    accounts_checked: configuredCount,
                    summary: totalUnseen > 0
                        ? `📧 You have ${totalUnseen} unread email${totalUnseen !== 1 ? 's' : ''} across ${configuredCount} account${configuredCount !== 1 ? 's' : ''}.`
                        : `📧 No unread emails across ${configuredCount} account${configuredCount !== 1 ? 's' : ''}.`,
                };
            } catch (err: any) {
                console.error("[EmailDigest] Error:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
