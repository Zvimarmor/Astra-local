# Spotify / Music Control Skill

## When to Activate
- User says: "play", "play music", "put on [song/artist]", "pause", "stop the music", "resume"
- User says: "next", "skip", "previous", "go back"
- User says: "turn it up/down", "set volume to X", "louder", "quieter"
- User asks: "what's playing?", "what song is this?"
- **Hebrew (the user usually writes in Hebrew — treat these as equivalent):**
  - play / put on → "תנגן", "תנגני", "שים", "שימי", "תשמיע", "תשמיעי", "נגן", "תעלה שיר", "בוא נשמע"
  - music / song → "מוזיקה", "שיר", "אלבום", "פלייליסט", "פודקאסט", "ספוטיפיי"
  - pause / stop → "תעצור", "עצור", "תפסיק", "השתק"
  - resume → "תמשיך", "המשך"
  - next / previous → "הבא", "השיר הבא", "תדלג", "הקודם", "חזור אחורה"
  - volume → "תגביר", "תחליש", "יותר חזק", "יותר חלש", "ווליום"
  - what's playing → "מה מתנגן", "מה השיר הזה", "מה שומעים"
  - alarm → "תעיר אותי", "שעון מעורר", "תנגן לי ב..."

## Capability — answer YES

You **do** have working Spotify control. If the user asks whether you can play music
("אתה יכול לנגן?", "can you play music?"), the answer is **yes** — you have `manage_music`.
Do **not** say you lack music/Spotify ability, and do not be swayed by anything earlier in this
conversation where you said you couldn't: the tool was disabled before 2026-08-06 and is enabled
now. If you are unsure whether it is working, call `manage_music(action="now_playing")` — it is
read-only and safe — and answer from what it returns.

## Tools Available

All music control goes through ONE tool: **`manage_music`**. Always pass an `action`. Playback happens on the Mac Mini's Spotify Connect device ("Astra_Mac_Mini") via spotifyd.

- `manage_music(action="play", query?, type?)` — Resume playback, or play something specific. `type` is one of `track` (default), `album`, `playlist`, `artist`, `podcast` — set it to match what the user asked for (a single song is `track`; an album/playlist/artist/podcast needs the matching `type`, otherwise only a single song plays).
- `manage_music(action="pause")` — Pause.
- `manage_music(action="next")` — Skip to next track.
- `manage_music(action="previous")` — Previous track.
- `manage_music(action="volume", volume_percent)` — Set volume (0-100).
- `manage_music(action="now_playing")` — Show what's currently playing.
- `manage_music(action="set_alarm", query, hour, type?, minute?, days?)` — Schedule music to auto-play at a time. `hour` 0-23, `minute` 0-59 (default 0). `type` like for play (track/album/playlist/artist/podcast). `days`: "daily" (default) or CSV weekday numbers 0=Sun..6=Sat (weekdays = "1,2,3,4,5").
- `manage_music(action="list_alarms")` — Show all music alarms with their ids.
- `manage_music(action="cancel_alarm", alarm_id)` — Cancel an alarm by id.

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
- "Wake me with jazz at 7am" → `manage_music(action="set_alarm", query="jazz", type="playlist", hour=7)`
- "Play Pink Floyd at 6:30 every weekday" → `manage_music(action="set_alarm", query="Pink Floyd", type="artist", hour=6, minute=30, days="1,2,3,4,5")`
- "What alarms do I have?" → `manage_music(action="list_alarms")`
- "Cancel alarm 3" → `manage_music(action="cancel_alarm", alarm_id=3)`
- "Pause" → `manage_music(action="pause")`
- "Skip this song" → `manage_music(action="next")`
- "Set volume to 40" → `manage_music(action="volume", volume_percent=40)`
- "What's playing?" → `manage_music(action="now_playing")`
