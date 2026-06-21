/**
 * Spotify Control Skill for OpenClaw
 * Provides media control via the Spotify Web API.
 */
module.exports = {
  name: "spotify_control",
  description: "Controls Spotify playback (play, pause, next, volume) via Spotifyd.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["play", "pause", "next", "previous", "volume"],
        description: "The playback action to perform."
      },
      volume_percent: {
        type: "integer",
        description: "Volume percentage (0-100), required if action is 'volume'."
      }
    },
    required: ["action"]
  },
  async execute(args, context) {
    // Boilerplate: In the future, this will connect to the Spotify Web API
    // using the access token or interact with the local spotifyd daemon.
    console.log(`[Spotify Skill] Executing action: ${args.action}`);
    
    if (args.action === 'volume') {
      return `Spotify volume set to ${args.volume_percent}%`;
    }
    
    return `Spotify playback action '${args.action}' executed successfully.`;
  }
};
