import { config } from './config';

/**
 * Immich API Client
 * 
 * Provides read-light write capabilities for the local Immich photo server.
 * Can create albums and update descriptions, but NEVER deletes photos.
 */

async function immichFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    if (!config.immichApiKey) {
        throw new Error('IMMICH_API_KEY is not configured in .env');
    }

    const url = `${config.immichBaseUrl}/api${endpoint}`;
    const headers = {
        'Accept': 'application/json',
        'x-api-key': config.immichApiKey,
        ...(options.headers || {})
    };

    const res = await fetch(url, { ...options, headers });
    
    // Immich can return 204 No Content for some operations
    if (res.status === 204) return null;
    
    if (!res.ok) {
        let errorMsg = `HTTP ${res.status} ${res.statusText}`;
        try {
            const errBody = await res.json() as any;
            if (errBody.message) errorMsg += `: ${errBody.message}`;
        } catch { /* ignore */ }
        throw new Error(`Immich API Error: ${errorMsg}`);
    }

    return await res.json();
}

export const immichTools = {
    immich_stats: {
        name: "immich_stats",
        description: "Get general statistics about the Immich photo library (total photos, videos, storage used).",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const stats = await immichFetch('/server/statistics');
                return {
                    status: "success",
                    photos: stats.photos || 0,
                    videos: stats.videos || 0,
                    usageBytes: stats.usage || 0,
                    usageGB: Math.round((stats.usage || 0) / 1024 / 1024 / 1024 * 10) / 10
                };
            } catch (err: any) {
                return { status: "error", error: err.message };
            }
        }
    },

    immich_search_photos: {
        name: "immich_search_photos",
        description: "Perform a smart semantic search of photos using natural language (e.g. 'sunset at the beach', 'cat sleeping'). Powered by local CLIP model. Use English queries.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query (in English)" },
                limit: { type: "number", description: "Max results to return (default: 10, max: 50)" }
            },
            required: ["query"]
        },
        execute: async (args: any) => {
            try {
                const limit = Math.min(args.limit || 10, 50);
                const query = args.query;
                
                // POST to /search/smart
                const results = await immichFetch('/search/smart', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, clip: true, size: limit })
                });

                if (!results?.assets?.items?.length) {
                    return { status: "success", count: 0, message: "No photos matched the search query." };
                }

                const assets = results.assets.items.map((a: any) => ({
                    id: a.id,
                    type: a.type,
                    date: a.fileCreatedAt,
                    description: a.exifInfo?.description || null,
                    location: a.exifInfo?.city ? `${a.exifInfo.city}, ${a.exifInfo.country}` : null,
                    score: a.score // ML confidence score
                }));

                return {
                    status: "success",
                    count: assets.length,
                    results: assets
                };
            } catch (err: any) {
                return { status: "error", error: err.message };
            }
        }
    },

    immich_list_albums: {
        name: "immich_list_albums",
        description: "List all photo albums.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const albums = await immichFetch('/albums');
                return {
                    status: "success",
                    count: albums.length,
                    albums: albums.map((a: any) => ({
                        id: a.id,
                        name: a.albumName,
                        assetCount: a.assetCount,
                        createdAt: a.createdAt
                    }))
                };
            } catch (err: any) {
                return { status: "error", error: err.message };
            }
        }
    },

    immich_create_album: {
        name: "immich_create_album",
        description: "Create a new photo album. Returns the new album ID.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the new album" },
                description: { type: "string", description: "Optional description for the album" }
            },
            required: ["name"]
        },
        execute: async (args: any) => {
            try {
                const newAlbum = await immichFetch('/albums', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ albumName: args.name, description: args.description || '' })
                });

                return {
                    status: "success",
                    albumId: newAlbum.id,
                    name: newAlbum.albumName,
                    message: `Album '${newAlbum.albumName}' created successfully.`
                };
            } catch (err: any) {
                return { status: "error", error: err.message };
            }
        }
    },

    immich_add_to_album: {
        name: "immich_add_to_album",
        description: "Add multiple photos (assets) to a specific album by their IDs.",
        parameters: {
            type: "object",
            properties: {
                albumId: { type: "string", description: "The ID of the album" },
                assetIds: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "List of asset IDs to add to the album"
                }
            },
            required: ["albumId", "assetIds"]
        },
        execute: async (args: any) => {
            if (!args.assetIds || args.assetIds.length === 0) {
                return { status: "error", error: "No asset IDs provided." };
            }

            try {
                const result = await immichFetch(`/albums/${args.albumId}/assets`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assetIds: args.assetIds })
                });

                return {
                    status: "success",
                    added: result.length,
                    message: `Added ${result.length} photos to the album.`
                };
            } catch (err: any) {
                return { status: "error", error: err.message };
            }
        }
    }
};
