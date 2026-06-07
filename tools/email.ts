import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config';

/**
 * Email Tools — Read-Only IMAP Access
 *
 * Connects to Gmail via IMAP to list and read emails.
 * Uses ImapFlow (IMAP only) — NO SMTP library is imported.
 * Physically cannot send, reply to, forward, or delete emails.
 *
 * Supports two accounts: "personal" and "university" (both Gmail).
 */

async function getImapClient(account: string): Promise<ImapFlow> {
    const acct = config.imapAccounts[account];
    if (!acct || !acct.host || !acct.user || !acct.password) {
        throw new Error(
            `IMAP account "${account}" is not configured. ` +
            `Set IMAP_USER${account === 'university' ? '_UNI' : ''} and IMAP_PASSWORD${account === 'university' ? '_UNI' : ''} in .env`
        );
    }

    const client = new ImapFlow({
        host: acct.host,
        port: acct.port,
        secure: true,
        auth: {
            user: acct.user,
            pass: acct.password,
        },
        logger: false,
    });

    await client.connect();
    return client;
}

export const emailTools = {
    list_recent_emails: {
        name: "list_recent_emails",
        description: "List recent emails from a Gmail inbox. Returns subject, sender, date, and UID for each email. Read-only: cannot send or delete emails.",
        parameters: {
            type: "object",
            properties: {
                count: {
                    type: "number",
                    description: "Number of recent emails to return (default: 10, max: 30)"
                },
                account: {
                    type: "string",
                    description: "Which email account to check: 'personal' (default) or 'university'",
                    enum: ["personal", "university"]
                },
                folder: {
                    type: "string",
                    description: "Mailbox folder to check (default: 'INBOX')"
                }
            }
        },
        execute: async (args: any) => {
            const account = args.account || 'personal';
            const folder = args.folder || 'INBOX';
            const count = Math.min(args.count || 10, 30);
            let client: ImapFlow | null = null;

            try {
                client = await getImapClient(account);
                const lock = await client.getMailboxLock(folder);

                try {
                    const status = await client.status(folder, { messages: true });
                    const total = status.messages || 0;

                    if (total === 0) {
                        return { emails: [], count: 0, account, folder, message: "No emails in this folder." };
                    }

                    const from = Math.max(1, total - count + 1);
                    const emails: any[] = [];

                    for await (const message of client.fetch(`${from}:*`, {
                        envelope: true,
                        uid: true,
                    })) {
                        const env = message.envelope;
                        emails.push({
                            uid: message.uid,
                            subject: env?.subject || '(no subject)',
                            from: env?.from?.[0]?.address || '(unknown)',
                            from_name: env?.from?.[0]?.name || '',
                            date: env?.date?.toISOString() || '',
                            to: env?.to?.[0]?.address || '',
                        });
                    }

                    // Newest first
                    emails.reverse();

                    return {
                        emails,
                        count: emails.length,
                        account,
                        folder,
                    };
                } finally {
                    lock.release();
                }
            } catch (err: any) {
                console.error(`[Email] Error listing emails (${account}):`, err.message);
                return { status: "error", error: err.message, account };
            } finally {
                if (client) {
                    try { await client.logout(); } catch { /* ignore */ }
                }
            }
        }
    },

    read_email: {
        name: "read_email",
        description: "Read the full text content of a specific email by its UID. Returns subject, sender, date, body text, and attachment filenames. Read-only: cannot reply or forward.",
        parameters: {
            type: "object",
            properties: {
                uid: {
                    type: "number",
                    description: "The UID of the email to read (from list_recent_emails results)"
                },
                account: {
                    type: "string",
                    description: "Which email account: 'personal' (default) or 'university'",
                    enum: ["personal", "university"]
                }
            },
            required: ["uid"]
        },
        execute: async (args: any) => {
            const account = args.account || 'personal';
            const uid = args.uid;
            let client: ImapFlow | null = null;

            try {
                client = await getImapClient(account);
                const lock = await client.getMailboxLock('INBOX');

                try {
                    // Download the full message source
                    const downloadResult = await client.download(String(uid), undefined, { uid: true });

                    if (!downloadResult || !downloadResult.content) {
                        return { status: "error", error: `Email UID ${uid} not found.` };
                    }

                    // Parse with mailparser
                    const parsed = await simpleParser(downloadResult.content);

                    // Truncate very long bodies to avoid token overload
                    let bodyText = parsed.text || '(no text content)';
                    if (bodyText.length > 3000) {
                        bodyText = bodyText.substring(0, 3000) + '\n\n... (truncated — email too long)';
                    }

                    return {
                        uid,
                        subject: parsed.subject || '(no subject)',
                        from: parsed.from?.text || '(unknown)',
                        to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t: any) => t.text).join(', ') : (parsed.to as any).text) : '',
                        date: parsed.date?.toISOString() || '',
                        body: bodyText,
                        hasAttachments: (parsed.attachments?.length || 0) > 0,
                        attachments: parsed.attachments?.map(a => ({
                            filename: a.filename || '(unnamed)',
                            size_kb: Math.round((a.size || 0) / 1024),
                            contentType: a.contentType,
                        })) || [],
                        account,
                    };
                } finally {
                    lock.release();
                }
            } catch (err: any) {
                console.error(`[Email] Error reading email UID ${uid} (${account}):`, err.message);
                return { status: "error", error: err.message, account };
            } finally {
                if (client) {
                    try { await client.logout(); } catch { /* ignore */ }
                }
            }
        }
    }
};
