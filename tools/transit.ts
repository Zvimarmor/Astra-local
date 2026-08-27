import { config } from './config';
import { calendarTools } from './calendar';

/**
 * Public Transit & Commute Planning — Google Maps Directions API (transit mode).
 *
 * Israel-first: `language=iw`, `region=il`, and every user-facing error string is
 * Hebrew, because this tool answers questions like "איך אני מגיע לרכבת מרכז מחר ב-09:00?"
 * on the WhatsApp channel.
 *
 * Dependency-free on purpose (global fetch, Node 18+), matching tools/gemini.ts and
 * tools/spotify.ts — the whole surface is two REST calls; @googlemaps/google-maps-services-js
 * would drag in a transitive tree to buy nothing.
 *
 * TIME SEMANTICS — the one thing to get right:
 *   - `arrival_time`  = "I must BE THERE by X" → Google works backwards and returns the
 *     latest departure that still makes it. This is what you want for a meeting.
 *   - `departure_time` = "I'm leaving at X" → forward search.
 *   Pass one or the other, never both. With neither, we search from "now".
 *   Both accept an ISO datetime ("2026-08-28T09:00:00", read as Asia/Jerusalem) or a
 *   raw Unix timestamp in seconds — the model reliably produces the former.
 *
 * The Directions API rejects an `arrival_time`/`departure_time` in the past, so a route
 * for a time that has already gone by comes back as a Hebrew error, not an empty result.
 */

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const REQUEST_TIMEOUT_MS = 20_000;

/** Vehicle type (Google's enum) → the emoji we label the leg / calendar event with. */
const VEHICLE_EMOJI: Record<string, string> = {
    BUS: '🚌',
    INTERCITY_BUS: '🚌',
    TROLLEYBUS: '🚌',
    SHARE_TAXI: '🚕',
    HEAVY_RAIL: '🚆',
    COMMUTER_TRAIN: '🚆',
    HIGH_SPEED_TRAIN: '🚄',
    LONG_DISTANCE_TRAIN: '🚆',
    RAIL: '🚆',
    METRO_RAIL: '🚇',
    SUBWAY: '🚇',
    MONORAIL: '🚇',
    TRAM: '🚊',
    CABLE_CAR: '🚡',
    GONDOLA_LIFT: '🚡',
    FUNICULAR: '🚡',
    FERRY: '⛴️',
};

/** Hebrew label per vehicle type, for the human-readable summary line. */
const VEHICLE_HE: Record<string, string> = {
    BUS: 'אוטובוס',
    INTERCITY_BUS: 'אוטובוס בין-עירוני',
    TROLLEYBUS: 'טרולייבוס',
    SHARE_TAXI: 'מונית שירות',
    HEAVY_RAIL: 'רכבת',
    COMMUTER_TRAIN: 'רכבת פרברית',
    HIGH_SPEED_TRAIN: 'רכבת מהירה',
    LONG_DISTANCE_TRAIN: 'רכבת בין-עירונית',
    RAIL: 'רכבת',
    METRO_RAIL: 'רכבת קלה',
    SUBWAY: 'רכבת תחתית',
    MONORAIL: 'מונורייל',
    TRAM: 'רכבת קלה',
    FERRY: 'מעבורת',
};

/** Google `status` values → a Hebrew sentence the user can actually act on. */
const STATUS_HE: Record<string, string> = {
    ZERO_RESULTS: 'לא נמצא מסלול בתחבורה ציבורית בין המוצא ליעד בזמן שביקשת. אולי אין קווים בשעה הזו, או שאחת הכתובות לא מזוהה.',
    NOT_FOUND: 'לא הצלחתי לזהות את כתובת המוצא או היעד. אפשר לנסח אותה מלא יותר (רחוב + עיר)?',
    MAX_ROUTE_LENGTH_EXCEEDED: 'המסלול ארוך מדי לחישוב בתחבורה ציבורית.',
    INVALID_REQUEST: 'הבקשה למפות לא תקינה — בדוק את הכתובות ואת שעת היעד.',
    OVER_DAILY_LIMIT: 'חרגנו ממכסת ה-API של Google Maps (או שיש בעיה בחיוב/במפתח). נסה שוב מאוחר יותר.',
    OVER_QUERY_LIMIT: 'חרגנו ממכסת השאילתות של Google Maps. נסה שוב בעוד כמה דקות.',
    REQUEST_DENIED: 'Google Maps דחה את הבקשה — כנראה מפתח ה-API לא תקף או שה-Directions API לא מופעל בפרויקט.',
    UNKNOWN_ERROR: 'שגיאה זמנית בשרת של Google Maps. נסה שוב.',
};

const MISSING_KEY_HE =
    'לא מוגדר מפתח Google Maps. הוסף GOOGLE_MAPS_API_KEY לקובץ .env (והפעל את Directions API בפרויקט ב-Google Cloud) כדי שאוכל לתכנן נסיעות בתחבורה ציבורית.';

const NO_ORIGIN_HE =
    'לא ידוע לי מאיפה אתה יוצא. ציין כתובת מוצא, או הגדר HOME_ADDRESS בקובץ .env כדי שאשתמש בה כברירת מחדל.';

/** Uniform Hebrew error result. `hint` stays in English — it's for the logs/dev, not the chat. */
function err(message: string, hint?: string): Record<string, any> {
    return hint ? { status: 'error', error: message, hint } : { status: 'error', error: message };
}

// ─── Time helpers ────────────────────────────────────────────────────────────
// Everything the model says is Israel wall-clock time; everything Google speaks is
// epoch seconds. These two functions are the only bridge — don't hand-roll another.

/** Offset (minutes) of `config.timezone` from UTC at that instant — DST-aware. */
function tzOffsetMinutes(at: Date): number {
    const asTz = new Date(at.toLocaleString('en-US', { timeZone: config.timezone }));
    const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((asTz.getTime() - asUtc.getTime()) / 60_000);
}

/**
 * Parse a time reference into epoch **seconds**.
 * Accepts: a Unix timestamp (number or numeric string, seconds or ms), or an ISO
 * datetime. A bare ISO datetime with no zone suffix is read as Asia/Jerusalem wall
 * clock — NOT as the process's local time and not as UTC.
 * Returns null when the value is absent or unparseable.
 */
function parseTimeInput(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;

    // Unix timestamp — accept seconds or milliseconds.
    if (typeof value === 'number' || /^\d{9,14}$/.test(String(value).trim())) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return Math.floor(n > 1e11 ? n / 1000 : n);
    }

    const raw = String(value).trim();
    // An explicit zone (Z or ±HH:MM) means Date already knows the instant.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const t = Date.parse(raw);
        return Number.isNaN(t) ? null : Math.floor(t / 1000);
    }

    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) {
        const t = Date.parse(raw);
        return Number.isNaN(t) ? null : Math.floor(t / 1000);
    }
    const [, y, mo, d, h, mi, s] = m;
    const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
    // Subtract the offset to turn the wall clock into a real instant. Done twice
    // because the offset itself depends on the instant (DST boundary days).
    let guess = asUtc - tzOffsetMinutes(new Date(asUtc)) * 60_000;
    guess = asUtc - tzOffsetMinutes(new Date(guess)) * 60_000;
    return Math.floor(guess / 1000);
}

/** Epoch seconds → "2026-08-28T09:00:00" in Israel wall-clock (what calendar.ts wants). */
function toLocalIso(epochSeconds: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(epochSeconds * 1000));
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Epoch seconds → "09:05" in Israel time. */
function toLocalHhMm(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleTimeString('he-IL', {
        timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
}

// ─── Directions API ──────────────────────────────────────────────────────────

/** Resolve the origin: explicit arg → configured home address → null. */
function resolveOrigin(origin?: string): string | null {
    const explicit = String(origin || '').trim();
    if (explicit) return explicit;
    return config.homeAddress || null;
}

async function fetchDirections(params: Record<string, string>): Promise<{ ok: true; data: any } | { ok: false; result: Record<string, any> }> {
    const url = new URL(DIRECTIONS_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', config.googleMapsApiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
        res = await fetch(url.toString(), { signal: controller.signal });
    } catch (e: any) {
        const aborted = e?.name === 'AbortError';
        return {
            ok: false,
            result: err(
                aborted ? 'Google Maps לא ענה בזמן. נסה שוב.' : 'לא הצלחתי להתחבר ל-Google Maps. בדוק את החיבור לאינטרנט.',
                e?.message,
            ),
        };
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        return { ok: false, result: err(`שגיאה בפנייה ל-Google Maps (HTTP ${res.status}).`, await res.text().catch(() => '')) };
    }

    const data: any = await res.json().catch(() => null);
    if (!data) return { ok: false, result: err('Google Maps החזיר תשובה לא קריאה.') };

    if (data.status !== 'OK') {
        const he = STATUS_HE[data.status] || `Google Maps החזיר שגיאה: ${data.status}.`;
        return { ok: false, result: { ...err(he, data.error_message || undefined), google_status: data.status } };
    }
    if (!Array.isArray(data.routes) || data.routes.length === 0) {
        return { ok: false, result: { ...err(STATUS_HE.ZERO_RESULTS), google_status: 'ZERO_RESULTS' } };
    }
    return { ok: true, data };
}

/** One parsed step of a leg — walking or a single transit ride. */
interface TransitStep {
    kind: 'walk' | 'transit';
    emoji: string;
    minutes: number;
    summary: string;
    line?: string;
    vehicle?: string;
    from?: string;
    to?: string;
    platform?: string;
    headsign?: string;
    stops?: number;
    departure?: string;
    arrival?: string;
}

function parseSteps(leg: any): TransitStep[] {
    return (leg.steps || []).map((s: any): TransitStep => {
        const minutes = Math.round((s.duration?.value || 0) / 60);
        const td = s.transit_details;

        if (s.travel_mode !== 'TRANSIT' || !td) {
            const distance = s.distance?.text ? ` (${s.distance.text})` : '';
            return { kind: 'walk', emoji: '🚶', minutes, summary: `הליכה ${minutes} דק'${distance}` };
        }

        const vehicleType = td.line?.vehicle?.type || 'BUS';
        const emoji = VEHICLE_EMOJI[vehicleType] || '🚏';
        const vehicleHe = VEHICLE_HE[vehicleType] || td.line?.vehicle?.name || 'תחבורה ציבורית';
        // short_name is the line NUMBER (what you actually look for at the stop);
        // name is the full route description. Prefer the number, fall back to the name.
        const line = td.line?.short_name || td.line?.name || '';
        const from = td.departure_stop?.name || '';
        const to = td.arrival_stop?.name || '';
        // Google puts the platform in the stop name for rail; there is no separate field.
        const platform = td.departure_stop?.name && /רציף|platform/i.test(td.departure_stop.name)
            ? td.departure_stop.name : undefined;

        const depAt = td.departure_time?.value ? toLocalHhMm(td.departure_time.value) : undefined;
        const arrAt = td.arrival_time?.value ? toLocalHhMm(td.arrival_time.value) : undefined;

        const bits = [`${vehicleHe}${line ? ` ${line}` : ''}`];
        if (from) bits.push(`מ-${from}${depAt ? ` ב-${depAt}` : ''}`);
        if (to) bits.push(`עד ${to}${arrAt ? ` ב-${arrAt}` : ''}`);
        if (td.num_stops) bits.push(`${td.num_stops} תחנות`);

        return {
            kind: 'transit',
            emoji,
            minutes,
            summary: bits.join(' · '),
            line: line || undefined,
            vehicle: vehicleHe,
            from: from || undefined,
            to: to || undefined,
            platform,
            headsign: td.headsign || undefined,
            stops: td.num_stops || undefined,
            departure: depAt,
            arrival: arrAt,
        };
    });
}

interface ParsedRoute {
    depart_at: string | null;
    arrive_at: string | null;
    depart_epoch: number | null;
    arrive_epoch: number | null;
    duration_minutes: number;
    transfers: number;
    lines: string[];
    emoji: string;
    steps: TransitStep[];
    summary: string;
    origin_address: string;
    destination_address: string;
}

function parseRoute(route: any): ParsedRoute {
    const leg = route.legs?.[0] || {};
    const steps = parseSteps(leg);
    const rides = steps.filter(s => s.kind === 'transit');

    const departEpoch = leg.departure_time?.value ?? null;
    const arriveEpoch = leg.arrival_time?.value ?? null;
    const durationMinutes = Math.round((leg.duration?.value || 0) / 60);

    const lines = rides.map(r => `${r.emoji} ${r.vehicle}${r.line ? ` ${r.line}` : ''}`);
    // The event emoji is the "heaviest" leg: rail beats bus, walking-only gets a car.
    const emoji = rides.find(r => ['🚆', '🚄', '🚇', '🚊'].includes(r.emoji))?.emoji
        || rides[0]?.emoji
        || '🚗';

    const summaryBits: string[] = [];
    if (departEpoch && arriveEpoch) summaryBits.push(`יציאה ${toLocalHhMm(departEpoch)} → הגעה ${toLocalHhMm(arriveEpoch)}`);
    summaryBits.push(`${durationMinutes} דק'`);
    if (lines.length) summaryBits.push(lines.join(' → '));
    if (rides.length > 1) summaryBits.push(`${rides.length - 1} החלפות`);

    return {
        depart_at: departEpoch ? toLocalIso(departEpoch) : null,
        arrive_at: arriveEpoch ? toLocalIso(arriveEpoch) : null,
        depart_epoch: departEpoch,
        arrive_epoch: arriveEpoch,
        duration_minutes: durationMinutes,
        transfers: Math.max(0, rides.length - 1),
        lines,
        emoji,
        steps,
        summary: summaryBits.join(' · '),
        origin_address: leg.start_address || '',
        destination_address: leg.end_address || '',
    };
}

/** Shared route lookup used by both actions. Returns parsed routes or a Hebrew error. */
async function lookupRoutes(args: any): Promise<{ ok: true; routes: ParsedRoute[] } | { ok: false; result: Record<string, any> }> {
    if (!config.googleMapsApiKey) return { ok: false, result: err(MISSING_KEY_HE) };

    const destination = String(args.destination || '').trim();
    if (!destination) return { ok: false, result: err('חסר יעד — לאן אתה נוסע?') };

    const origin = resolveOrigin(args.origin);
    if (!origin) return { ok: false, result: err(NO_ORIGIN_HE) };

    const arrival = parseTimeInput(args.arrival_time);
    const departure = parseTimeInput(args.departure_time);
    if (args.arrival_time && arrival === null) return { ok: false, result: err('לא הצלחתי לפענח את שעת ההגעה. פורמט: 2026-08-28T09:00:00') };
    if (args.departure_time && departure === null) return { ok: false, result: err('לא הצלחתי לפענח את שעת היציאה. פורמט: 2026-08-28T09:00:00') };
    if (arrival !== null && departure !== null) {
        return { ok: false, result: err('אפשר לציין או שעת הגעה או שעת יציאה, לא את שתיהן.') };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    // Directions rejects a past time outright; say so in Hebrew instead of surfacing INVALID_REQUEST.
    if ((arrival !== null && arrival < nowSec) || (departure !== null && departure < nowSec)) {
        return { ok: false, result: err('הזמן שביקשת כבר עבר — Google Maps מתכנן רק קדימה. ציין מועד עתידי.') };
    }

    const params: Record<string, string> = {
        origin,
        destination,
        mode: 'transit',
        alternatives: 'true',
        language: 'iw',
        region: 'il',
    };
    if (arrival !== null) params.arrival_time = String(arrival);
    else params.departure_time = String(departure !== null ? departure : nowSec);

    const modes = String(args.transit_mode || '').trim();
    if (modes) {
        const allowed = ['bus', 'subway', 'train', 'tram', 'rail'];
        const picked = modes.split(/[,\s|]+/).map(m => m.toLowerCase()).filter(m => allowed.includes(m));
        if (picked.length) params.transit_mode = picked.join('|');
    }

    const res = await fetchDirections(params);
    if (!res.ok) return res;

    const routes = res.data.routes.map(parseRoute);
    if (routes.length === 0) return { ok: false, result: err(STATUS_HE.ZERO_RESULTS) };
    return { ok: true, routes };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export const transitTools = {
    plan_transit_route: {
        name: 'plan_transit_route',
        description:
            'Plan a public-transit trip (bus/train/subway/tram) with the Google Maps Directions API. ' +
            'Returns the recommended departure time, arrival time, total duration, and a step-by-step ' +
            'breakdown (walking minutes, line numbers, boarding stations, transfers). ' +
            'Origin defaults to the configured home address when omitted.',
        parameters: {
            type: 'object',
            properties: {
                origin: { type: 'string', description: "Starting address. Omit to use the user's home address." },
                destination: { type: 'string', description: 'Destination address or place name.' },
                arrival_time: { type: 'string', description: 'Be there BY this time. ISO datetime (Asia/Jerusalem) or Unix seconds.' },
                departure_time: { type: 'string', description: 'Leave AT this time. ISO datetime (Asia/Jerusalem) or Unix seconds. Do not combine with arrival_time.' },
                transit_mode: { type: 'string', description: "Restrict vehicles: 'bus', 'train', 'subway', 'tram' (comma-separated). Omit for all." },
                max_routes: { type: 'number', description: 'How many alternative routes to return (default 3).' },
            },
            required: ['destination'],
        },
        execute: async (args: any = {}) => {
            try {
                const res = await lookupRoutes(args);
                if (!res.ok) return res.result;

                const limit = Math.max(1, Math.min(5, Number(args.max_routes) || 3));
                const routes = res.routes.slice(0, limit);
                const best = routes[0];

                return {
                    status: 'success',
                    origin: best.origin_address || resolveOrigin(args.origin),
                    destination: best.destination_address || String(args.destination || '').trim(),
                    recommended: {
                        depart_at: best.depart_at,
                        arrive_at: best.arrive_at,
                        duration_minutes: best.duration_minutes,
                        transfers: best.transfers,
                        lines: best.lines,
                        summary: best.summary,
                        steps: best.steps,
                    },
                    alternatives: routes.slice(1).map(r => ({
                        depart_at: r.depart_at,
                        arrive_at: r.arrive_at,
                        duration_minutes: r.duration_minutes,
                        transfers: r.transfers,
                        lines: r.lines,
                        summary: r.summary,
                    })),
                };
            } catch (e: any) {
                console.error('[Transit] plan_transit_route failed:', e?.message);
                return err('שגיאה בתכנון הנסיעה.', e?.message);
            }
        },
    },

    block_travel_time: {
        name: 'block_travel_time',
        description:
            'Look up a transit route that arrives before a calendar event, then block the commute in ' +
            'Google Calendar as an event titled "🚆 נסיעה אל <destination>" (colorId 8 / Graphite, the ' +
            'travel colour), with the line-by-line route in the description. ' +
            'Give it the time the user must BE at the destination.',
        parameters: {
            type: 'object',
            properties: {
                destination: { type: 'string', description: 'Where the user needs to get to.' },
                arrival_time: { type: 'string', description: 'When the user must be there — usually the target event start. ISO datetime (Asia/Jerusalem) or Unix seconds.' },
                origin: { type: 'string', description: "Starting address. Omit to use the user's home address." },
                buffer_minutes: { type: 'number', description: 'Arrive this many minutes early (default 10).' },
                transit_mode: { type: 'string', description: "Restrict vehicles: 'bus', 'train', 'subway', 'tram' (comma-separated)." },
            },
            required: ['destination', 'arrival_time'],
        },
        execute: async (args: any = {}) => {
            try {
                const targetEpoch = parseTimeInput(args.arrival_time);
                if (targetEpoch === null) {
                    return err('לא הצלחתי לפענח את שעת ההגעה. פורמט: 2026-08-28T09:00:00');
                }
                const buffer = Math.max(0, Number.isFinite(Number(args.buffer_minutes)) ? Number(args.buffer_minutes) : 10);
                const arriveBy = targetEpoch - buffer * 60;

                const res = await lookupRoutes({
                    origin: args.origin,
                    destination: args.destination,
                    arrival_time: arriveBy,
                    transit_mode: args.transit_mode,
                });
                if (!res.ok) return res.result;

                const best = res.routes[0];
                if (!best.depart_epoch || !best.arrive_epoch) {
                    return err('המסלול חזר בלי שעות יציאה/הגעה, אז אין מה לחסום ביומן.');
                }

                const destLabel = best.destination_address || String(args.destination).trim();
                const summary = `${best.emoji} נסיעה אל ${destLabel}`;
                const description = [
                    best.summary,
                    '',
                    ...best.steps.map(s => `${s.emoji} ${s.summary}`),
                    '',
                    `סה"כ ${best.duration_minutes} דק'${best.transfers ? ` · ${best.transfers} החלפות` : ''}`,
                ].join('\n');

                const added = await calendarTools.add_calendar_event.execute({
                    summary,
                    location: destLabel,
                    description,
                    startDateTime: toLocalIso(best.depart_epoch),
                    endDateTime: toLocalIso(best.arrive_epoch),
                    colorId: '8',   // Graphite — travel/commute (see manage_calendar colour rules)
                });
                if (added.status !== 'success') {
                    return { ...added, error: `המסלול נמצא אבל לא הצלחתי להוסיף אותו ליומן: ${added.error || 'שגיאה לא ידועה'}` };
                }

                return {
                    status: 'success',
                    message: `חסמתי ביומן: ${summary} · ${toLocalHhMm(best.depart_epoch)}–${toLocalHhMm(best.arrive_epoch)}`,
                    event: added.event,
                    route: {
                        depart_at: best.depart_at,
                        arrive_at: best.arrive_at,
                        duration_minutes: best.duration_minutes,
                        transfers: best.transfers,
                        lines: best.lines,
                        steps: best.steps,
                    },
                    buffer_minutes: buffer,
                };
            } catch (e: any) {
                console.error('[Transit] block_travel_time failed:', e?.message);
                return err('שגיאה בחסימת זמן הנסיעה ביומן.', e?.message);
            }
        },
    },
};
