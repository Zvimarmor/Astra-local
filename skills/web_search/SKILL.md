# Web Search Skill

## When to Activate
- User asks about current events, news, weather, sports, or facts
- User says: "search for", "look up", "what is", "who is"
- User asks about weather in any city

## Tools Available
- `web_search` — OpenClaw's native, provider-backed web search (currently DuckDuckGo). This
  is a built-in capability, not one of Astra's `manage_*`/`assistant_utils` tools — call it
  directly by name.

## Rules
1. Always translate Hebrew queries to English before searching (the search engines work better in English).
2. For weather queries, include the city name in the query.
3. Present search results concisely — summarize the top results, don't dump raw data.
4. If no results are found, suggest the user rephrase their query.
5. Always cite the source of the information.

## Examples
- "What's the weather in Tel Aviv?" → `web_search(query="weather Tel Aviv")`
- "Who won the Champions League?" → `web_search(query="Champions League winner 2026")`
- "What is quantum computing?" → `web_search(query="quantum computing explained")`
