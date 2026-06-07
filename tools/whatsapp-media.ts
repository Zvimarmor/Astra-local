import { getRecentWhatsAppMedia } from './storage';

/**
 * WhatsApp Media Tools — Read-Only Query
 *
 * Queries the local SQLite database for media files downloaded by the
 * separate WhatsApp listener service. This module NEVER imports Baileys
 * or any WhatsApp library — it only reads from the local DB.
 *
 * Safety: There is no code path from this tool to sendMessage.
 */

export const whatsappMediaTools = {
    list_whatsapp_media: {
        name: "list_whatsapp_media",
        description: "List recently received WhatsApp media files (images, videos, documents). Returns metadata only — sender, type, caption, timestamp, and local file path. Read-only: cannot send messages.",
        parameters: {
            type: "object",
            properties: {
                count: {
                    type: "number",
                    description: "Number of recent media items to return (default: 10, max: 50)"
                },
                media_type: {
                    type: "string",
                    description: "Filter by media type",
                    enum: ["image", "video", "document"]
                }
            }
        },
        execute: async (args: any) => {
            try {
                const count = Math.min(args.count || 10, 50);
                const media = getRecentWhatsAppMedia(count, args.media_type);

                if (media.length === 0) {
                    return {
                        media: [],
                        count: 0,
                        message: "No media files found. The WhatsApp listener may not be running, or no media has been received yet."
                    };
                }

                return {
                    media: media.map(m => ({
                        id: m.id,
                        sender: m.sender,
                        type: m.media_type,
                        caption: m.caption || '(no caption)',
                        file_path: m.file_path,
                        size_kb: m.file_size ? Math.round(m.file_size / 1024) : null,
                        received: m.received_at
                    })),
                    count: media.length
                };
            } catch (err: any) {
                console.error("[WhatsAppMedia] Error listing media:", err.message);
                return { status: "error", error: err.message };
            }
        }
    }
};
