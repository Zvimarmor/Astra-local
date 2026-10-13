#!/usr/bin/env node
/**
 * One-time Google Tasks consent → writes the refresh token the mirror runs on.
 *
 * WHY THIS EXISTS
 * ---------------
 * Calendar works off a service account because the user shared their calendar
 * with it. Google Tasks has no sharing at all: a service account would get its
 * own private, invisible task store. So the "Astra Tasks" mirror needs a real
 * user OAuth token for the owner's Google account, and that needs one consent
 * click in a browser. After that the refresh token keeps it going unattended.
 *
 * SETUP (once)
 *   1. Cloud Console → the same project → APIs & Services → enable "Google Tasks API".
 *   2. Credentials → Create credentials → OAuth client ID → Application type "Desktop app".
 *      Download the JSON to data/google_oauth_client.json (gitignored).
 *   3. If the consent screen is in "Testing", add your Google account as a test user.
 *      (Testing-mode refresh tokens expire after 7 days — publish the app to
 *      "In production" to make it permanent; no verification is needed for personal use.)
 *   4. npm run build && npm run auth:google-tasks   → open the printed URL, approve.
 *   5. openclaw gateway restart   (the MCP server caches "no token" until restarted)
 *
 *   node scripts/google-tasks-auth.js            # run the consent flow
 *   node scripts/google-tasks-auth.js --check    # list the task lists the token can see
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

const { config } = require(path.join(__dirname, '..', 'dist', 'config.js'));
const { oauthClientPath, tokenPath, listName } = config.googleTasks;
const SCOPE = 'https://www.googleapis.com/auth/tasks';

function loadClient(redirectUri) {
    if (!fs.existsSync(oauthClientPath)) {
        console.error(`✗ No OAuth client at ${oauthClientPath}.\n  Create a "Desktop app" OAuth client in Cloud Console and save its JSON there.`);
        process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));
    const c = raw.installed || raw.web || raw;
    return new google.auth.OAuth2(c.client_id, c.client_secret, redirectUri);
}

async function check() {
    if (!fs.existsSync(tokenPath)) {
        console.error(`✗ No token at ${tokenPath} — run without --check first.`);
        process.exit(1);
    }
    const auth = loadClient();
    auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
    const api = google.tasks({ version: 'v1', auth });
    const res = await api.tasklists.list({ maxResults: 100 });
    const lists = (res.data.items || []).map(l => l.title);
    console.log(`✓ Token works. Task lists: ${lists.join(', ') || '(none)'}`);
    console.log(lists.includes(listName)
        ? `✓ "${listName}" exists.`
        : `· "${listName}" will be created on the first sync.`);
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
    });
    console.log('\nOpen this URL in a browser signed in to your Google account:\n');
    console.log(url, '\n');
    console.log(`Waiting for the redirect on ${redirectUri} …`);

    const code = await new Promise((resolve, reject) => {
        server.on('request', (req, res) => {
            const q = new URL(req.url, redirectUri).searchParams;
            if (q.get('error')) {
                res.end('Consent was declined. You can close this tab.');
                reject(new Error(q.get('error')));
            } else if (q.get('code')) {
                res.end('Astra is connected to Google Tasks. You can close this tab.');
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
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log(`✓ Saved token to ${tokenPath}`);
    console.log('  Now restart the gateway: openclaw gateway restart');
}

(process.argv.includes('--check') ? check() : consent()).catch(e => {
    console.error('✗', e.message || e);
    process.exit(1);
});
