# Help / Capabilities Skill

## When to Activate
Activate when the user wants to know what Astra can do. Triggers:
- The command **`/tools`**
- The command **`/help`**
- Natural phrases: **"what can you do?"**, "what can you do", "list your tools", "what tools do you have", "show me your capabilities", "help", "what are your features"

## Tool to Use
- `assistant_utils(action="help")` — returns the full, up-to-date capabilities list (built live from the tool registry).

## Rules
1. On any trigger above, call `assistant_utils(action="help")` **first** — do not try to list the tools from memory.
2. Send the returned `message` text to the user **verbatim** — do not summarize, reformat, translate, shorten, or add tools of your own. It is already formatted for chat.
3. You may add at most one short friendly line before or after it (e.g. "Here's everything I can do:"), but never alter the list itself.
4. This is the single source of truth for capabilities — if the user asks "can you do X?", you may still call this to check what's available.

## Examples
- "/tools" → `assistant_utils(action="help")` → send the result verbatim
- "/help" → `assistant_utils(action="help")` → send the result verbatim
- "what can you do?" → `assistant_utils(action="help")` → send the result verbatim
