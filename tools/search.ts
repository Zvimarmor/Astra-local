/**
 * Web Search & Weather Tools
 *
 * Ported from the AWS WhatsApp Bot — identical functionality.
 * Already cloud-agnostic: uses SearXNG, DuckDuckGo, Wikipedia, and wttr.in.
 * No AWS or Google dependencies.
 */

// Weather keywords in Hebrew and English
const WEATHER_KEYWORDS = /weather|forecast|temperature|מזג\s*אוויר|תחזית|טמפרטורה/i;
const CITY_EXTRACT = /(?:weather|forecast|temperature|מזג\s*אוויר|תחזית)\s*(?:in|ב|של|עבור)?\s*(.+)/i;

const CITY_MAP: Record<string, string> = {
    'ירושלים': 'Jerusalem', 'תל אביב': 'Tel Aviv', 'חיפה': 'Haifa',
    'באר שבע': 'Beer Sheva', 'אילת': 'Eilat', 'נתניה': 'Netanya',
    'הרצליה': 'Herzliya', 'רמת גן': 'Ramat Gan', 'פתח תקווה': 'Petah Tikva',
    'ראשון לציון': 'Rishon LeZion', 'אשדוד': 'Ashdod', 'לונדון': 'London',
    'ניו יורק': 'New York', 'פריז': 'Paris', 'רומא': 'Rome',
};

function translateCity(raw: string): string {
    const trimmed = raw.trim().replace(/[?.!,]/g, '');
    return CITY_MAP[trimmed] || trimmed;
}

const SEARXNG_INSTANCES = [
    'https://search.sapti.me',
    'https://searx.be',
    'https://search.bus-hit.me',
    'https://paulgo.io',
    'https://searx.tiekoetter.com',
    'https://searxng.site',
];

export const searchTools = {
    web_search: {
        name: "web_search",
        description: "Search the web for real-time information like weather, news, sports scores, current events, or general queries.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query in English (translate from Hebrew if needed)" }
            },
            required: ["query"]
        },
        execute: async (args: any) => {
            const query = args.query || '';
            console.log(`[Search] Query: "${query}"`);

            try {
                // 1. Weather detection → route to wttr.in
                if (WEATHER_KEYWORDS.test(query)) {
                    const cityMatch = query.match(CITY_EXTRACT);
                    const rawCity = cityMatch?.[1] || query.replace(WEATHER_KEYWORDS, '').trim();
                    const city = translateCity(rawCity);
                    console.log(`[Search] Weather detected → wttr.in/${city}`);
                    return await fetchWeather(city);
                }

                // 2. SearXNG meta-search (tries multiple instances)
                const searxResults = await searxngSearch(query);
                if (searxResults.length > 0) {
                    return {
                        results: searxResults,
                        source: 'SearXNG',
                        summary: searxResults.map((r, i) => `${i + 1}. ${r.title}: ${r.snippet}`).join('\n')
                    };
                }

                // 3. DuckDuckGo Instant Answer API
                const instantAnswer = await duckDuckGoInstant(query);
                if (instantAnswer) return instantAnswer;

                // 4. Wikipedia
                const wikiResult = await wikipediaSearch(query);
                if (wikiResult) return wikiResult;

                return { answer: "No results found. Try rephrasing your query.", source: 'none' };
            } catch (err: any) {
                console.error('[Search] Failed:', err.message);
                return { status: 'error', error: err.message };
            }
        }
    }
};

// ─── Weather via wttr.in ─────────────────────────────────────────────

async function fetchWeather(city: string): Promise<Record<string, any>> {
    try {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'curl/7.68.0' }
        });
        if (!res.ok) return { answer: `Could not find weather for "${city}".`, source: 'wttr.in' };

        const data = await res.json() as any;
        const current = data.current_condition?.[0];
        const today = data.weather?.[0];
        if (!current) return { answer: `Could not find weather for "${city}".`, source: 'wttr.in' };

        return {
            source: 'wttr.in', city,
            current: {
                temp_c: current.temp_C, feels_like_c: current.FeelsLikeC,
                description: current.weatherDesc?.[0]?.value,
                humidity: current.humidity + '%', wind_kmph: current.windspeedKmph,
            },
            today: today ? {
                max_c: today.maxtempC, min_c: today.mintempC,
                sunrise: today.astronomy?.[0]?.sunrise, sunset: today.astronomy?.[0]?.sunset,
            } : null,
            summary: `${city}: ${current.temp_C}°C (feels like ${current.FeelsLikeC}°C), ${current.weatherDesc?.[0]?.value}, humidity ${current.humidity}%`
        };
    } catch (err: any) {
        console.error('[Weather] Error:', err.message);
        return { answer: `Error: ${err.message}`, source: 'wttr.in' };
    }
}

// ─── SearXNG Meta-Search ─────────────────────────────────────────────

async function searxngSearch(query: string): Promise<{ title: string; snippet: string; url: string }[]> {
    for (const instance of SEARXNG_INSTANCES) {
        try {
            const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo&language=en`;
            console.log(`[Search] Trying SearXNG: ${instance}`);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (compatible; AstraBot/2.0)',
                },
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!res.ok) {
                console.log(`[Search] ${instance} returned ${res.status}`);
                continue;
            }

            const data = await res.json() as any;
            const results = (data.results || []).slice(0, 5).map((r: any) => ({
                title: r.title || '',
                snippet: r.content || '',
                url: r.url || '',
            }));

            if (results.length > 0) {
                console.log(`[Search] SearXNG returned ${results.length} results from ${instance}`);
                return results;
            }
        } catch (err: any) {
            console.log(`[Search] ${instance} failed: ${err.message}`);
            continue;
        }
    }

    console.log('[Search] All SearXNG instances failed');
    return [];
}

// ─── DuckDuckGo Instant Answer ───────────────────────────────────────

async function duckDuckGoInstant(query: string): Promise<Record<string, any> | null> {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url);
        const data = await res.json() as any;

        const answer = data.AbstractText || data.Answer || '';
        if (answer) return { answer, source: data.AbstractSource || 'DuckDuckGo' };

        const topics = (data.RelatedTopics || []).slice(0, 5).map((t: any) => t.Text).filter(Boolean);
        if (topics.length > 0) return { results: topics, source: 'DuckDuckGo' };
        return null;
    } catch { return null; }
}

// ─── Wikipedia ───────────────────────────────────────────────────────

async function wikipediaSearch(query: string): Promise<Record<string, any> | null> {
    try {
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json() as any;
        if (data.extract) return { answer: data.extract, source: 'Wikipedia' };
        return null;
    } catch { return null; }
}
