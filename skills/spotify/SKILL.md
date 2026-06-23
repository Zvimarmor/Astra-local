# Spotify / Music Control Skill

## When to Activate
- User says: "play", "play music", "put on [song/artist]", "pause", "stop the music", "resume"
- User says: "next", "skip", "previous", "go back"
- User says: "turn it up/down", "set volume to X", "louder", "quieter"
- User asks: "what's playing?", "what song is this?"

## Tools Available

All music control goes through ONE tool: **`manage_music`**. Always pass an `action`. Playback happens on the Mac Mini's Spotify Connect device ("Astra_Mac_Mini") via spotifyd.

- `manage_music(action="play", query?, type?)` — Resume playback, or play something specific. `type` is one of `track` (default), `album`, `playlist`, `artist`, `podcast` — set it to match what the user asked for (a single song is `track`; an album/playlist/artist/podcast needs the matching `type`, otherwise only a single song plays).
- `manage_music(action="pause")` — Pause.
- `manage_music(action="next")` — Skip to next track.
- `manage_music(action="previous")` — Previous track.
- `manage_music(action="volume", volume_percent)` — Set volume (0-100).
- `manage_music(action="now_playing")` — Show what's currently playing.

## Rules
1. Requires Spotify Premium and configured credentials (SPOTIFY_CLIENT_ID/SECRET/REFRESH_TOKEN in .env). If the tool returns a "not configured" error, tell the user to run `scripts/spotify-auth.mjs`.
2. For "turn it up/down" without a number, nudge volume by ~15-20 points from a sensible value.
3. If the tool returns a `warning` that the device wasn't found, tell the user spotifyd may not be running/logged in.
4. Report exactly what the tool returns — never claim music is playing if the tool errored.
5. NEVER claim success without calling the tool first.

## Examples
- "Play some jazz" → `manage_music(action="play", query="jazz")`
- "Play Bohemian Rhapsody" → `manage_music(action="play", query="Bohemian Rhapsody Queen")`
- "Play the album Dark Side of the Moon" → `manage_music(action="play", query="Dark Side of the Moon", type="album")`
- "Play my Discover Weekly playlist" → `manage_music(action="play", query="Discover Weekly", type="playlist")`
- "Put on some Radiohead" → `manage_music(action="play", query="Radiohead", type="artist")`
- "Play the Daily podcast" → `manage_music(action="play", query="The Daily", type="podcast")`
- "Pause" → `manage_music(action="pause")`
- "Skip this song" → `manage_music(action="next")`
- "Set volume to 40" → `manage_music(action="volume", volume_percent=40)`
- "What's playing?" → `manage_music(action="now_playing")`
