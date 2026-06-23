#!/usr/bin/env node
/**
 * One-time Spotify OAuth helper — gets a SPOTIFY_REFRESH_TOKEN for Astra.
 *
 * Prereqs:
 *   1. Create an app at https://developer.spotify.com/dashboard
 *   2. In the app settings, add this Redirect URI EXACTLY:
 *          http://127.0.0.1:8888/callback
 *   3. Put the app's Client ID + Secret in .env:
 *          SPOTIFY_CLIENT_ID=...
 *          SPOTIFY_CLIENT_SECRET=...
 *
 * Run:  node scripts/spotify-auth.mjs
 * Then open the printed URL, approve, and copy the SPOTIFY_REFRESH_TOKEN it
 * prints into .env. Requires a Spotify Premium account for playback control.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state';

function loadEnv() {
    const env = { ...process.env };
    try {
        const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
        for (const line of raw.split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch { /* no .env */ }
    return env;
}

const env = loadEnv();
const CLIENT_ID = env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.');
    process.exit(1);
}

const authUrl =
    'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
    }).toString();

const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/callback')) {
        res.writeHead(404).end('Not found');
        return;
    }
    const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
    if (!code) {
        res.writeHead(400).end('No code in callback.');
        return;
    }
    try {
        const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const r = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error_description || data.error || r.status);
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('✅ Done! You can close this tab and return to the terminal.');
        console.log('\n✅ Success. Add this line to your .env:\n');
        console.log(`SPOTIFY_REFRESH_TOKEN=${data.refresh_token}\n`);
    } catch (err) {
        res.writeHead(500).end('Token exchange failed: ' + err.message);
        console.error('❌ Token exchange failed:', err.message);
    } finally {
        server.close();
        setTimeout(() => process.exit(0), 250);
    }
});

server.listen(8888, '127.0.0.1', () => {
    console.log('\n1. Open this URL in your browser and approve:\n');
    console.log('   ' + authUrl + '\n');
    console.log('2. Waiting for the redirect on ' + REDIRECT_URI + ' ...');
});
