import { config } from './config';

/**
 * Spotify Playback Control — Web API → spotifyd Connect device
 *
 * Controls playback on the Mac Mini's local `spotifyd` daemon (which registers
 * as a Spotify Connect device, default name "Astra_Mac_Mini"). Requires a
 * Spotify **Premium** account and a Spotify developer app:
 *
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN  (in .env)
 *
 * Get the refresh token once via `node scripts/spotify-auth.mjs`.
 * Scopes needed: user-read-playback-state, user-modify-playback-state.
 *
 * This module never stores credentials and never deletes anything; it only
 * issues playback-control calls (play/pause/skip/volume) and reads now-playing.
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

let cachedToken = { value: '', expiresAt: 0 };

function isConfigured(): boolean {
    const s = config.spotify;
    return Boolean(s.clientId && s.clientSecret && s.refreshToken);
}

async function getAccessToken(): Promise<string> {
    if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
        return cachedToken.value;
    }
    if (!isConfigured()) {
        throw new Error('Spotify is not configured. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN in .env (run scripts/spotify-auth.mjs once).');
    }
    const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.spotify.refreshToken }),
    });
    const data = await res.json() as any;
    if (!res.ok) {
        throw new Error(`Spotify token refresh failed: ${data?.error_description || data?.error || res.status}`);
    }
    cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return cachedToken.value;
}

async function api(endpoint: string, opts: { method?: string; body?: any } = {}): Promise<any> {
    const token = await getAccessToken();
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method: opts.method || 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data: any = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
        throw new Error(`Spotify API ${res.status}: ${data?.error?.message || data?.error || text || 'request failed'}`);
    }
    return data;
}

/** Resolve the configured spotifyd device id (so playback targets the Mac). */
async function resolveDeviceId(): Promise<{ id?: string; warning?: string }> {
    const name = config.spotify.deviceName;
    if (!name) return {};
    const data = await api('/me/player/devices');
    const dev = (data?.devices || []).find((d: any) => d.name === name);
    if (!dev) {
        return { warning: `Device "${name}" not found among active Spotify Connect devices. Is spotifyd running and logged in?` };
    }
    return { id: dev.id };
}

function deviceQuery(id?: string): string {
    return id ? `?device_id=${encodeURIComponent(id)}` : '';
}

function nowPlayingSummary(data: any): string {
    if (!data || !data.item) return 'Nothing is playing right now.';
    const t = data.item;
    const artists = (t.artists || []).map((a: any) => a.name).join(', ');
    const state = data.is_playing ? '▶️ Playing' : '⏸️ Paused';
    return `${state}: "${t.name}"${artists ? ` — ${artists}` : ''}`;
}

export const spotifyTools = {
    spotify_play: {
        name: 'spotify_play',
        description: "Start or resume Spotify playback on the Mac. Optionally search for and play a track/artist.",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: "Optional: what to play, e.g. 'Bohemian Rhapsody' or 'lofi beats'. Omit to resume the current track." },
            },
        },
        execute: async (args: any = {}) => {
            try {
                const { id, warning } = await resolveDeviceId();
                if (args.query) {
                    const search = await api(`/search?q=${encodeURIComponent(args.query)}&type=track&limit=1`);
                    const track = search?.tracks?.items?.[0];
                    if (!track) return { status: 'error', error: `No track found for "${args.query}".` };
                    await api(`/me/player/play${deviceQuery(id)}`, { method: 'PUT', body: { uris: [track.uri] } });
                    const artists = (track.artists || []).map((a: any) => a.name).join(', ');
                    return { status: 'success', message: `▶️ Playing "${track.name}"${artists ? ` — ${artists}` : ''}`, warning };
                }
                await api(`/me/player/play${deviceQuery(id)}`, { method: 'PUT' });
                return { status: 'success', message: '▶️ Resumed playback.', warning };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_pause: {
        name: 'spotify_pause',
        description: 'Pause Spotify playback on the Mac.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const { id, warning } = await resolveDeviceId();
                await api(`/me/player/pause${deviceQuery(id)}`, { method: 'PUT' });
                return { status: 'success', message: '⏸️ Paused.', warning };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_next: {
        name: 'spotify_next',
        description: 'Skip to the next track on Spotify.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const { id, warning } = await resolveDeviceId();
                await api(`/me/player/next${deviceQuery(id)}`, { method: 'POST' });
                return { status: 'success', message: '⏭️ Skipped to next track.', warning };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_previous: {
        name: 'spotify_previous',
        description: 'Go back to the previous track on Spotify.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const { id, warning } = await resolveDeviceId();
                await api(`/me/player/previous${deviceQuery(id)}`, { method: 'POST' });
                return { status: 'success', message: '⏮️ Went back to previous track.', warning };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_volume: {
        name: 'spotify_volume',
        description: 'Set Spotify playback volume (0-100).',
        parameters: {
            type: 'object',
            properties: {
                volume_percent: { type: 'number', description: 'Volume level from 0 to 100' },
            },
            required: ['volume_percent'],
        },
        execute: async (args: any = {}) => {
            try {
                const vol = Math.max(0, Math.min(100, Math.round(args.volume_percent)));
                const { id, warning } = await resolveDeviceId();
                await api(`/me/player/volume?volume_percent=${vol}${id ? `&device_id=${encodeURIComponent(id)}` : ''}`, { method: 'PUT' });
                return { status: 'success', message: `🔊 Volume set to ${vol}%.`, warning };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_now_playing: {
        name: 'spotify_now_playing',
        description: 'Show what is currently playing on Spotify.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const data = await api('/me/player/currently-playing');
                return { status: 'success', message: nowPlayingSummary(data) };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },
};
