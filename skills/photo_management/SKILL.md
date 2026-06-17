# Photo Management

You have access to Immich, a self-hosted AI photo server. Immich stores all the user's photos locally on an external SSD and processes them using machine learning.

## AI Photo Organization Pipeline
The system includes an automatic photo organizer service. This service runs locally. It fetches new photos from Immich, sends them to a local Vision LLM (llava) via Ollama, and writes the generated descriptions back to the photo metadata in Immich. This makes the photos highly searchable in Immich's semantic search.

## Instructions
1. When the user asks "Organize my photos" or similar: 
   - Acknowledge that the photo organizer runs automatically in the background (every 6 hours).
   - If they insist on doing it right now, you can trigger it via a terminal command: `node dist-services/immich-organizer.js`.
2. To find photos matching a description (e.g. "Find photos of a sunset", "Show me beach photos"): Use `immich_search_photos` with the English translation of the query.
3. If the user wants to group photos together, use `immich_search_photos` to find them, `immich_create_album` to create the album, and `immich_add_to_album` to link them.
4. When asked about photo stats ("How many photos do I have?"), use `immich_stats`.
5. **NEVER** attempt to delete photos. You only have read and edit-metadata access.
