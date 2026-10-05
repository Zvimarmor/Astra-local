import { config } from './config';
import { fetchDirections, resolveOrigin, err, MISSING_KEY_HE, NO_ORIGIN_HE } from './transit';

/**
 * Car trip fuel-cost estimate — Google Maps Directions (driving) × a consumption model ×
 * the current Israeli pump price.
 *
 *   litres = (km / km_per_l) × (1 + ac_penalty + traffic_penalty)
 *   cost   = litres × price_per_litre
 *
 * The penalties are deliberately coarse rules of thumb, not physics:
 *   - AC: level 0/1/2 → +0% / +6% / +12%. `auto` picks by the Israeli month
 *     (Jun–Sep → 2, Apr/May/Oct/Nov → 1, Dec–Mar → 0).
 *   - Traffic: heavy → +18%. With no explicit level we ask Google for live traffic
 *     (`departure_time=now`) and call it heavy when the trip takes ≥25% longer than
 *     free-flow. That live reading only describes the outbound leg *right now* — a
 *     return trip later in the day is assumed to see the same.
 *
 * FUEL PRICE. Only 95-octane self-service is regulated in Israel; the Ministry of Energy
 * publishes each update on a gov.il page whose slug carries the effective date
 * (`fuel-october-2026`, `fuel-october-5-2026`). We search the local SearXNG for those
 * pages and take the latest one that is already in effect — a search snippet without that
 * date is not trusted, because the same "לא יעלה על X" sentence recurs every month and
 * stale copies rank well. Diesel is unregulated, so its figure is a best-effort read of a
 * price-list snippet. Either way, a failed lookup falls back to `config.fuelPriceDefaults`
 * and the result says so — the model must never present a fallback as today's price.
 */

const AC_PENALTY: Record<number, number> = { 0: 0, 1: 0.06, 2: 0.12 };
const HEAVY_TRAFFIC_PENALTY = 0.18;
/** duration_in_traffic / duration at or above this counts as heavy traffic. */
const HEAVY_TRAFFIC_RATIO = 1.25;
const DEFAULT_KM_PER_L = 13.0;
const SEARCH_TIMEOUT_MS = 12_000;
const PRICE_CACHE_MS = 6 * 60 * 60 * 1000;

type FuelType = '95' | 'diesel';

const FUEL_HE: Record<FuelType, string> = { '95': 'בנזין 95', diesel: 'סולר' };
const AC_HE = ['כבוי', 'בינוני', 'חזק'];

const MONTHS: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function round(n: number, digits = 2): number {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

/** Calendar month (1-12) and YYYY-MM-DD "today" in Israel, not process-local time. */
function israelToday(): { month: number; ymd: string } {
    const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return { month: Number(ymd.slice(5, 7)), ymd };
}

function normalizeFuelType(v: any): FuelType | null {
    const s = String(v ?? '95').trim().toLowerCase();
    if (['95', 'בנזין', 'בנזין 95', 'petrol', 'gasoline', 'benzine', ''].includes(s)) return '95';
    if (['diesel', 'סולר', 'solar'].includes(s)) return 'diesel';
    return null;
}

// ─── AC & traffic ────────────────────────────────────────────────────────────

function resolveAc(v: any): { level: number; source: 'auto' | 'user'; penalty: number } | null {
    const s = String(v ?? 'auto').trim().toLowerCase();
    if (s === 'auto' || s === '') {
        const { month } = israelToday();
        const level = month >= 6 && month <= 9 ? 2 : [4, 5, 10, 11].includes(month) ? 1 : 0;
        return { level, source: 'auto', penalty: AC_PENALTY[level] };
    }
    const level = Number(s);
    if (![0, 1, 2].includes(level)) return null;
    return { level, source: 'user', penalty: AC_PENALTY[level] };
}

/** true/'heavy' → heavy, false/'normal' → normal, anything else → read Google's live traffic. */
function parseTrafficArg(v: any): 'heavy' | 'normal' | 'live' {
    if (v === true) return 'heavy';
    if (v === false) return 'normal';
    const s = String(v ?? '').trim().toLowerCase();
    if (['heavy', 'true', 'כבד', 'עומס', 'פקקים'].includes(s)) return 'heavy';
    if (['normal', 'false', 'light', 'none', 'רגיל'].includes(s)) return 'normal';
    return 'live';
}

// ─── Fuel price lookup ───────────────────────────────────────────────────────

interface FuelPrice { price: number; source: string; as_of: string | null; live: boolean }

const priceCache = new Map<FuelType, { at: number; value: FuelPrice }>();

async function searx(query: string): Promise<any[]> {
    const url = new URL('/search', config.searxngUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
        const res = await fetch(url.toString(), { signal: controller.signal });
        if (!res.ok) return [];
        const data: any = await res.json().catch(() => null);
        return Array.isArray(data?.results) ? data.results : [];
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}

const plausible = (n: number) => Number.isFinite(n) && n >= 4 && n <= 20;

/** Latest regulated 95 price that is already in effect, from gov.il's dated update pages. */
async function lookup95(): Promise<FuelPrice | null> {
    const results = await searx('עדכון מחיר הבנזין 95 כולל מע"מ לא יעלה על');
    const today = israelToday().ymd;
    let best: FuelPrice | null = null;
    for (const r of results) {
        const slug = String(r.url || '').match(/gov\.il\/he\/pages\/fuel-([a-z]+)(?:-(\d{1,2}))?-(\d{4})/i);
        if (!slug || !MONTHS[slug[1].toLowerCase()]) continue;
        // "(כולל מע"מ)" is what separates the national price from Eilat's VAT-free one.
        const m = String(r.content || '').match(/כולל מע"?מ\)?\s*לא יעלה על\s*(\d+(?:\.\d+)?)/);
        if (!m) continue;
        const price = Number(m[1]);
        if (!plausible(price)) continue;
        const effective = `${slug[3]}-${String(MONTHS[slug[1].toLowerCase()]).padStart(2, '0')}-${String(slug[2] || 1).padStart(2, '0')}`;
        if (effective > today) continue;   // announced but not yet at the pump
        if (!best || effective > (best.as_of || '')) {
            best = { price, source: r.url, as_of: effective, live: true };
        }
    }
    return best;
}

/** Diesel is unregulated — read the first plausible figure off a price-list snippet. */
async function lookupDiesel(): Promise<FuelPrice | null> {
    const results = await searx('מחיר הסולר לליטר היום');
    for (const r of results) {
        const m = String(r.content || '').match(/סולר[^\d]{0,12}(\d{1,2}\.\d{2})/);
        if (m && plausible(Number(m[1]))) {
            return { price: Number(m[1]), source: r.url, as_of: null, live: true };
        }
    }
    return null;
}

export async function getFuelPrice(type: FuelType): Promise<FuelPrice> {
    const cached = priceCache.get(type);
    if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.value;

    let found: FuelPrice | null = null;
    try {
        found = type === '95' ? await lookup95() : await lookupDiesel();
    } catch (e: any) {
        console.error('[TripCost] fuel price lookup failed:', e?.message);
    }
    if (found) {
        priceCache.set(type, { at: Date.now(), value: found });
        return found;
    }
    // Not cached, so the next call retries the lookup.
    return { price: config.fuelPriceDefaults[type], source: 'fallback default (config)', as_of: null, live: false };
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export const tripCostTools = {
    calculate_trip_cost: {
        name: 'calculate_trip_cost',
        description:
            'Estimate the fuel cost of a car trip: driving distance from Google Maps, a consumption model ' +
            '(km/l adjusted for air-conditioning and traffic) and the current Israeli fuel price.',
        parameters: {
            type: 'object',
            properties: {
                destination: { type: 'string', description: 'Where the user is driving to.' },
                origin: { type: 'string', description: "Starting address. Omit to use the user's home address." },
                round_trip: { type: 'boolean', description: 'Count the way back too (default false).' },
                fuel_type: { type: 'string', description: "'95' (default) or 'diesel'." },
                traffic_level: { type: 'string', description: "'heavy' or 'normal'. Omit to use Google's live traffic." },
                car_consumption_km_per_l: { type: 'number', description: 'Car fuel economy in km per litre (default 13).' },
                ac_level: { type: 'string', description: "0 (off), 1, 2 (strong) or 'auto' (by season, default)." },
                price_per_liter: { type: 'number', description: 'Override the looked-up fuel price (ILS/litre).' },
            },
            required: ['destination'],
        },
        execute: async (args: any = {}) => {
            try {
                if (!config.googleMapsApiKey) return err(MISSING_KEY_HE);
                const destination = String(args.destination || '').trim();
                if (!destination) return err('חסר יעד — לאן נוסעים?');
                const origin = resolveOrigin(args.origin);
                if (!origin) return err(NO_ORIGIN_HE);

                const fuelType = normalizeFuelType(args.fuel_type);
                if (!fuelType) return err("סוג דלק לא נתמך. אפשר '95' או 'diesel' (סולר).");

                const ac = resolveAc(args.ac_level);
                if (!ac) return err("דרגת מזגן לא תקינה — 0, 1, 2 או 'auto'.");

                const kmPerL = args.car_consumption_km_per_l === undefined || args.car_consumption_km_per_l === null || args.car_consumption_km_per_l === ''
                    ? DEFAULT_KM_PER_L : Number(args.car_consumption_km_per_l);
                if (!Number.isFinite(kmPerL) || kmPerL <= 0 || kmPerL > 50) {
                    return err('צריכת הדלק של הרכב לא הגיונית — ציין קילומטרים לליטר (למשל 13).');
                }

                const overridePrice = args.price_per_liter === undefined || args.price_per_liter === null || args.price_per_liter === ''
                    ? null : Number(args.price_per_liter);
                if (overridePrice !== null && !plausible(overridePrice)) {
                    return err('מחיר הדלק לליטר לא הגיוני — ציין מחיר בש"ח (למשל 7.80).');
                }

                const roundTrip = args.round_trip === true || String(args.round_trip).toLowerCase() === 'true';
                const trafficArg = parseTrafficArg(args.traffic_level);

                // Route + price in parallel — they're independent and both are network-bound.
                const [route, fetchedPrice] = await Promise.all([
                    fetchDirections({
                        origin,
                        destination,
                        mode: 'driving',
                        departure_time: 'now',   // required for duration_in_traffic
                        language: 'iw',
                        region: 'il',
                    }),
                    overridePrice === null ? getFuelPrice(fuelType) : Promise.resolve(null),
                ]);
                if (!route.ok) return route.result;

                const leg = route.data.routes[0]?.legs?.[0];
                const meters = leg?.distance?.value;
                if (!meters) return err('Google Maps החזיר מסלול בלי מרחק — נסה כתובת מלאה יותר.');

                const oneWayKm = meters / 1000;
                const totalKm = roundTrip ? oneWayKm * 2 : oneWayKm;
                const freeFlowMin = Math.round((leg.duration?.value || 0) / 60);
                const trafficMin = leg.duration_in_traffic?.value ? Math.round(leg.duration_in_traffic.value / 60) : null;

                let heavy: boolean;
                let trafficSource: 'user' | 'live' | 'unavailable';
                if (trafficArg === 'live') {
                    if (trafficMin !== null && freeFlowMin > 0) {
                        heavy = trafficMin / freeFlowMin >= HEAVY_TRAFFIC_RATIO;
                        trafficSource = 'live';
                    } else {
                        heavy = false;
                        trafficSource = 'unavailable';
                    }
                } else {
                    heavy = trafficArg === 'heavy';
                    trafficSource = 'user';
                }
                const trafficPenalty = heavy ? HEAVY_TRAFFIC_PENALTY : 0;

                const multiplier = 1 + ac.penalty + trafficPenalty;
                const liters = (totalKm / kmPerL) * multiplier;
                const fuel: FuelPrice = overridePrice !== null
                    ? { price: overridePrice, source: 'user', as_of: null, live: false }
                    : fetchedPrice!;
                const cost = liters * fuel.price;

                const priceNote = fuel.source === 'user'
                    ? 'לפי המחיר שציינת'
                    : fuel.live
                        ? (fuelType === '95' ? `מחיר מפוקח, בתוקף מ-${fuel.as_of}` : 'מחיר משוער — סולר אינו בפיקוח')
                        : 'ברירת מחדל — לא הצלחתי לאמת את המחיר העדכני';
                const assumptions = [
                    `מרחק: ${round(oneWayKm, 1)} ק"מ לכיוון${roundTrip ? ` × 2 (הלוך-חזור) = ${round(totalKm, 1)} ק"מ` : ' אחד'}`,
                    `צריכה בסיסית: ${kmPerL} ק"מ/ליטר → בפועל ${round(kmPerL / multiplier, 1)} ק"מ/ליטר`,
                    `מזגן: דרגה ${ac.level} (${AC_HE[ac.level]})${ac.source === 'auto' ? ' לפי העונה' : ''} → +${Math.round(ac.penalty * 100)}%`,
                    trafficSource === 'unavailable'
                        ? 'עומס תנועה: אין נתון חי, חושב כתנועה רגילה → +0%'
                        : `עומס תנועה: ${heavy ? 'כבד' : 'רגיל'}${trafficSource === 'live' ? ` (לפי התנועה עכשיו: ${trafficMin} דק' לעומת ${freeFlowMin} בכביש פנוי)` : ''} → +${Math.round(trafficPenalty * 100)}%`,
                    `מחיר ${FUEL_HE[fuelType]}: ${fuel.price.toFixed(2)} ₪ לליטר (${priceNote})`,
                ];

                return {
                    status: 'success',
                    origin: leg.start_address || origin,
                    destination: leg.end_address || destination,
                    round_trip: roundTrip,
                    distance_km_one_way: round(oneWayKm, 1),
                    total_distance_km: round(totalKm, 1),
                    drive_minutes_one_way: trafficMin ?? freeFlowMin,
                    traffic: { level: heavy ? 'heavy' : 'normal', source: trafficSource, penalty_pct: Math.round(trafficPenalty * 100) },
                    ac: { level: ac.level, source: ac.source, penalty_pct: Math.round(ac.penalty * 100) },
                    consumption: { base_km_per_l: kmPerL, effective_km_per_l: round(kmPerL / multiplier, 2) },
                    liters: round(liters, 2),
                    fuel: { type: fuelType, price_per_liter: fuel.price, source: fuel.source, as_of: fuel.as_of, verified_live: fuel.live || fuel.source === 'user' },
                    total_cost_ils: round(cost, 2),
                    summary: `⛽ ${round(cost, 0)} ₪ — ${round(totalKm, 1)} ק"מ, כ-${round(liters, 1)} ליטר ${FUEL_HE[fuelType]}`,
                    assumptions,
                };
            } catch (e: any) {
                console.error('[TripCost] calculate_trip_cost failed:', e?.message);
                return err('שגיאה בחישוב עלות הנסיעה.', e?.message);
            }
        },
    },
};
