import { config } from './config';
import { addMusicAlarm, getMusicAlarms, cancelMusicAlarm } from './storage';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function describeDays(days: string): string {
    if (!days || days === 'daily') return 'every day';
    const nums = days.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (nums.length === 5 && [1, 2, 3, 4, 5].every(d => nums.includes(d))) return 'weekdays';
    return nums.map(n => DOW[n] ?? '?').join(', ');
}
function hhmm(h: number, m: number): string {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

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

/** Best-effort check: is Spotify actively playing right now? Never throws. */
export async function isSpotifyPlaying(): Promise<boolean> {
    try {
        if (!isConfigured()) return false;
        const data = await api('/me/player');
        return Boolean(data && data.is_playing);
    } catch {
        return false;
    }
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

/** Human-friendly label for a search result, by Spotify object type. */
function describeItem(searchType: string, item: any): string {
    const artists = (item.artists || []).map((a: any) => a.name).join(', ');
    switch (searchType) {
        case 'track': return `"${item.name}"${artists ? ` — ${artists}` : ''}`;
        case 'album': return `album "${item.name}"${artists ? ` — ${artists}` : ''}`;
        case 'playlist': return `playlist "${item.name}"${item.owner?.display_name ? ` by ${item.owner.display_name}` : ''}`;
        case 'artist': return `artist "${item.name}"`;
        case 'show': return `podcast "${item.name}"${item.publisher ? ` — ${item.publisher}` : ''}`;
        default: return `"${item.name}"`;
    }
}

export const spotifyTools = {
    spotify_play: {
        name: 'spotify_play',
        description: "Start or resume Spotify playback on the Mac. Optionally search for and play a track, album, playlist, artist, or podcast.",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: "Optional: what to play, e.g. 'Bohemian Rhapsody', 'Dark Side of the Moon', 'The Daily podcast'. Omit to resume the current track." },
                type: { type: 'string', enum: ['track', 'album', 'playlist', 'artist', 'podcast'], description: "What kind of thing 'query' is. Default 'track'. Use 'album', 'playlist', 'artist', or 'podcast' when the user asks for one." },
            },
        },
        execute: async (args: any = {}) => {
            try {
                const { id, warning } = await resolveDeviceId();
                if (args.query) {
                    const kind = String(args.type || 'track').toLowerCase();
                    const searchType = kind === 'podcast' ? 'show' : kind;
                    const buckets: Record<string, string> = {
                        track: 'tracks', album: 'albums', playlist: 'playlists', artist: 'artists', show: 'shows',
                    };
                    const bucket = buckets[searchType];
                    if (!bucket) return { status: 'error', error: `Unknown play type "${kind}". Use track, album, playlist, artist, or podcast.` };
                    const search = await api(`/search?q=${encodeURIComponent(args.query)}&type=${searchType}&limit=5`);
                    const item = (search?.[bucket]?.items || []).find((x: any) => x && x.uri);
                    if (!item) return { status: 'error', error: `No ${kind} found for "${args.query}".` };
                    // A track plays as a one-item uri list; album/playlist/artist/show play
                    // as a *context* (context_uri) so the whole thing queues up.
                    const body = searchType === 'track' ? { uris: [item.uri] } : { context_uri: item.uri };
                    await api(`/me/player/play${deviceQuery(id)}`, { method: 'PUT', body });
                    return { status: 'success', message: `▶️ Playing ${describeItem(searchType, item)}`, warning };
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

    // ─── Music alarms (the deterministic scheduler plays these at their time) ──
    spotify_set_alarm: {
        name: 'spotify_set_alarm',
        description: "Schedule music to start automatically at a given time. The background scheduler plays it (it fires even at night/Shabbat, and is skipped if the time was missed).",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: "What to play, e.g. 'lofi beats', 'Pink Floyd', 'The Daily'." },
                type: { type: 'string', enum: ['track', 'album', 'playlist', 'artist', 'podcast'], description: "Kind of thing to play. Default 'track'." },
                hour: { type: 'number', description: 'Hour 0-23 (local time).' },
                minute: { type: 'number', description: 'Minute 0-59 (default 0).' },
                days: { type: 'string', description: "When it repeats: 'daily', or CSV of weekday numbers 0=Sun..6=Sat (e.g. '1,2,3,4,5' for weekdays). Default 'daily'." },
            },
            required: ['query', 'hour'],
        },
        execute: async (args: any = {}) => {
            try {
                const hour = parseInt(args.hour, 10);
                const minute = Math.max(0, Math.min(59, parseInt(args.minute ?? 0, 10) || 0));
                if (isNaN(hour) || hour < 0 || hour > 23) return { status: 'error', error: 'hour must be 0-23.' };
                if (!args.query) return { status: 'error', error: 'query is required.' };
                const type = args.type || 'track';
                const days = (args.days || 'daily').trim();
                const { id } = addMusicAlarm(String(args.query), type, hour, minute, days);
                return { status: 'success', message: `⏰ Alarm #${id} set: ${type} "${args.query}" at ${hhmm(hour, minute)}, ${describeDays(days)}.` };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_list_alarms: {
        name: 'spotify_list_alarms',
        description: 'List all scheduled music alarms.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const alarms = getMusicAlarms();
                if (alarms.length === 0) return { status: 'success', message: 'No music alarms set.' };
                const lines = alarms.map(a => `⏰ #${a.id}: ${a.type} "${a.query}" at ${hhmm(a.hour, a.minute)}, ${describeDays(a.days)}`);
                return { status: 'success', message: lines.join('\n'), alarms };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    spotify_cancel_alarm: {
        name: 'spotify_cancel_alarm',
        description: 'Cancel a music alarm by its id (from list_alarms).',
        parameters: {
            type: 'object',
            properties: { alarm_id: { type: 'number', description: 'The alarm id to cancel.' } },
            required: ['alarm_id'],
        },
        execute: async (args: any = {}) => {
            try {
                const ok = cancelMusicAlarm(parseInt(args.alarm_id, 10));
                return ok
                    ? { status: 'success', message: `🗑️ Cancelled alarm #${args.alarm_id}.` }
                    : { status: 'error', error: `No alarm #${args.alarm_id} found.` };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },
};
