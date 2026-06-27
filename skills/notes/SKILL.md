# Notes / Second Brain Skill

## When to Activate
- User wants to save a thought, idea, fact, or note: "save a note", "remember this in my notes", "write this down", "add to my second brain", "תכתבי לי הערה", "תשמרי ל..."
- User asks what they've noted before: "what notes do I have about…", "find my note on…", "what do I know about…", "מה כתבתי על…"
- User wants to connect ideas: "link this note to…", "connect X and Y"

## Tools Available
- `manage_notes(action="add", title, content, tags?)` — Save a note to the Obsidian vault. Auto-suggests `[[wikilinks]]` to related existing notes.
- `manage_notes(action="find", query)` — Search notes by title, tags, and body.
- `manage_notes(action="list")` — List all note titles.
- `manage_notes(action="link", from_title, to_title)` — Manually link two existing notes.
- `manage_notes(action="delete", title)` — Permanently delete a note. **Ask the user to confirm before calling this.**

## Rules
1. Give every note a short, descriptive `title` — it becomes the filename AND the `[[link]]` text, so keep it clean and reusable (e.g. "Marathon training plan", not "note about the thing").
2. Put the user's actual words in `content`. Don't over-summarize; this is their brain, not yours.
3. Hebrew is fine in title, content, and tags — the vault is Hebrew-aware.
4. After `add`, tell the user the title you saved and which notes it linked to (the tool returns `linked_to`). If nothing was linked, that's normal for a new topic.
5. To answer "what do I know about X", call `find` and summarize the returned snippets — never dump full note bodies.
6. Don't invent links. Only use `link` when the user explicitly asks to connect two notes that both exist.
7. **Delete is permanent.** Before calling `delete`, confirm the exact title with the user (e.g. "Delete the note 'Espresso ratio'? This can't be undone."). Never delete more than the one note they named.

## Examples
- "Save a note: the new espresso ratio is 1:2 in 28s" → `manage_notes(action="add", title="Espresso ratio", content="New espresso ratio is 1:2 in 28s", tags="coffee")`
- "What have I written about my thesis?" → `manage_notes(action="find", query="thesis")`
- "List my notes" → `manage_notes(action="list")`
- "Link 'Espresso ratio' to 'Coffee gear'" → `manage_notes(action="link", from_title="Espresso ratio", to_title="Coffee gear")`

## Notes
- The vault is a folder of Markdown files (`vault/`). Open it directly in the Obsidian app to see the graph and backlinks — no export needed.
- Linking is keyword-based for now; semantic (embedding) linking is a planned upgrade.
