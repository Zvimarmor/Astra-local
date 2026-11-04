#!/usr/bin/env node
/**
 * One-time Gmail consent for the university account → writes the refresh token the
 * email fetcher runs on.
 *
 * WHY THIS EXISTS
 * ---------------
 * HUJI's Google Workspace blocks App Passwords, so IMAP can't log in to mail.huji.ac.il.
 * The Gmail API with user OAuth is the way in, using only the gmail.readonly scope.
 *
 * SETUP (once)
 *   1. Cloud Console → the same project as Google Tasks → APIs & Services → enable "Gmail API".
 *   2. OAuth consent screen → Data access → add the gmail.readonly scope.
 *   3. Publish the app ("In production"), or refresh tokens die after 7 days. gmail.readonly
 *      is a restricted scope, so Google shows an "unverified app" warning: Advanced → continue.
 *   4. npm run build && npm run auth:gmail:huji   → open the URL signed in to the HUJI account.
 *
 * If the browser says "Access blocked" or admin_policy_enforced, HUJI's Workspace admin
 * restricts third-party access to Gmail. No code here can get around that; it needs IT to
 * allow this OAuth client.
 *
 * Reuses data/google_oauth_client.json. The token is separate from the Google Tasks one.
 * No restart needed afterwards: the fetcher reads the token on every call.
 *
 *   node scripts/gmail-huji-auth.js            # run the consent flow
 *   node scripts/gmail-huji-auth.js --check    # confirm the token works (counts only)
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

const { config } = require(path.join(__dirname, '..', 'dist', 'config.js'));
const { oauthClientPath } = config.googleTasks;
const { tokenPath, domain } = config.gmailAccounts.university;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function loadClient(redirectUri) {
    if (!fs.existsSync(oauthClientPath)) {
        console.error(`✗ No OAuth client at ${oauthClientPath}.\n  Create a "Desktop app" OAuth client in Cloud Console and save its JSON there.`);
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));
    const c = raw.installed || raw.web || raw;
    return new google.auth.OAuth2(c.client_id, c.client_secret, redirectUri);
}

const inDomain = address => String(address).toLowerCase().endsWith(`@${domain.toLowerCase()}`);

async function check() {
    if (!fs.existsSync(tokenPath)) {
        console.error(`✗ No token at ${tokenPath} — run without --check first.`);
        process.exit(1);
    }
    const auth = loadClient();
    auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
    const api = google.gmail({ version: 'v1', auth });
    const { data: profile } = await api.users.getProfile({ userId: 'me' });
    const { data: inbox } = await api.users.labels.get({ userId: 'me', id: 'INBOX' });
    console.log(`✓ Token works for ${profile.emailAddress}. Inbox: ${inbox.messagesUnread} unread of ${inbox.messagesTotal}.`);
    if (!inDomain(profile.emailAddress)) {
        console.error(`✗ That is not a ${domain} account. Run the consent flow again.`);
        process.exit(1);
    }
}

async function consent() {
    // Loopback redirect on an ephemeral port — the flow Google recommends for desktop apps.
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const auth = loadClient(redirectUri);

    const url = auth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',          // forces a refresh_token even on a re-consent
        scope: [SCOPE],
        hd: domain,                 // the account chooser offers only university accounts
    });
    console.log(`\nOpen this URL in a browser signed in to your ${domain} account:\n`);
    console.log(url, '\n');
    console.log(`Waiting for the redirect on ${redirectUri} …`);

    const code = await new Promise((resolve, reject) => {
        server.on('request', (req, res) => {
            const q = new URL(req.url, redirectUri).searchParams;
            if (q.get('error')) {
                res.end('Consent was declined or blocked. You can close this tab.');
                reject(new Error(`${q.get('error')} (see "Access blocked" in this script's header)`));
            } else if (q.get('code')) {
                res.end('Done. You can close this tab and go back to the terminal.');
                resolve(q.get('code'));
            } else {
                res.statusCode = 404;
                res.end();
            }
        });
    });
    server.close();

    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) {
        console.error('✗ Google returned no refresh_token. Remove Astra under myaccount.google.com → Security → Third-party access, then retry.');
        process.exit(1);
    }
    // `hd` only steers the chooser, so check. A personal account's token saved here would
    // show personal mail labelled as University.
    auth.setCredentials(tokens);
    const { data: profile } = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    if (!inDomain(profile.emailAddress)) {
        console.error(`✗ You signed in as ${profile.emailAddress}, not a ${domain} account. Nothing was saved.`);
        process.exit(1);
    }
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log(`✓ Saved token for ${profile.emailAddress} to ${tokenPath}`);
}

(process.argv.includes('--check') ? check() : consent()).catch(e => {
    console.error('✗', e.message || e);
    process.exit(1);
});
