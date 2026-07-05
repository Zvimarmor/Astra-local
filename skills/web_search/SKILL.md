# Web Search Skill

## When to Activate
- User asks about current events, news, weather, sports, or facts
- User says: "search for", "look up", "what is", "who is"
- User asks about weather in any city

## Tools Available
- `web_search` — OpenClaw's native, provider-backed web search (currently DuckDuckGo). This
  is a built-in capability, not one of Astra's `manage_*`/`assistant_utils` tools — call it
  directly by name.
- `web_fetch` — fetch the actual content of a URL. `web_search` alone only returns titles and
  short link blurbs (e.g. "AccuWeather hourly forecast for Tel Aviv") — it usually does NOT
  contain the actual answer (a number, a score, a current fact).

## Rules
1. Always translate Hebrew queries to English before searching (the search engines work better in English).
2. For weather queries, include the city name in the query.
3. **`web_search` result snippets are almost never enough on their own for real-time facts
   (weather, scores, prices, "what's happening now").** If the snippets don't contain the
   literal answer, immediately call `web_fetch` on the most relevant result URL to pull the
   real page content, then answer from that. Do this automatically — never tell the user
   "here are some sites, check them yourself" instead of just fetching the page for them.
4. Present results concisely — summarize, don't dump raw data.
5. If both search and fetch come up empty, say so plainly and suggest a rephrase.
6. Always cite the source of the information.

## Examples
- "What's the weather in Tel Aviv?" → `web_search(query="weather Tel Aviv")`
- "Who won the Champions League?" → `web_search(query="Champions League winner 2026")`
- "What is quantum computing?" → `web_search(query="quantum computing explained")`
