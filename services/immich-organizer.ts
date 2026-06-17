/**
 * Astra AI Photo Organizer — Immich integration
 * 
 * This service runs periodically (via OpenClaw heartbeat) or manually.
 * It fetches unprocessed photos from Immich, sends them to the local
 * Ollama vision model (llava) to generate a semantic description,
 * and updates the photo's EXIF description in Immich so it becomes
 * searchable via Immich's Smart Search.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const config = {
    immichApiKey: process.env.IMMICH_API_KEY || '',
    immichBaseUrl: process.env.IMMICH_BASE_URL || 'http://localhost:2283',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
};

const BATCH_SIZE = 10;
const VISION_MODEL = 'llava';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'memory.db');

// Ensure tracking table exists
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS immich_processed (
        asset_id TEXT PRIMARY KEY,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL
    );
`);

async function immichFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    if (!config.immichApiKey) throw new Error('IMMICH_API_KEY is not configured');
    
    const url = `${config.immichBaseUrl}/api${endpoint}`;
    const headers: any = {
        'x-api-key': config.immichApiKey,
        ...(options.headers || {})
    };
    
    // Don't set Content-Type if we're sending FormData
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        headers['Accept'] = 'application/json';
    }

    const res = await fetch(url, { ...options, headers });
    
    if (res.status === 204) return null;
    
    if (!res.ok) {
        throw new Error(`Immich HTTP ${res.status}: ${res.statusText}`);
    }
    
    // If it's returning an image buffer
    const contentType = res.headers.get('content-type') || '';
    if (contentType.startsWith('image/')) {
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    return await res.json();
}

async function analyzeImage(imageBuffer: Buffer): Promise<string> {
    const base64Image = imageBuffer.toString('base64');
    
    const res = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: VISION_MODEL,
            prompt: "Describe this photo in 1-3 sentences. Focus on: setting, people count, activities, and prominent objects. Be concise.",
            images: [base64Image],
            stream: false
        })
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json() as any;
    return data.response.trim();
}

async function runOrganizer(dryRun: boolean = false) {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Astra AI Photo Organizer                       ║');
    console.log('╚══════════════════════════════════════════════════╝');

    try {
        // 1. Get recent assets
        console.log('[Organizer] Fetching recent assets from Immich...');
        // We fetch a larger batch, then filter out already processed ones
        const recentAssets = await immichFetch('/search/metadata', {
            method: 'POST',
            body: JSON.stringify({ type: 'IMAGE', withExif: true, size: 50 })
        });

        if (!recentAssets?.assets?.items?.length) {
            console.log('[Organizer] No assets found.');
            return;
        }

        const assets = recentAssets.assets.items;
        
        // 2. Filter unprocessed
        const unprocessed = assets.filter((a: any) => {
            // Check if already processed in our DB
            const row = db.prepare('SELECT status FROM immich_processed WHERE asset_id = ?').get(a.id);
            if (row) return false;
            
            // Also skip if it already has a long description
            if (a.exifInfo?.description && a.exifInfo.description.length > 20) {
                // Mark as processed so we don't check again
                db.prepare('INSERT OR IGNORE INTO immich_processed (asset_id, status) VALUES (?, ?)').run(a.id, 'skipped_has_desc');
                return false;
            }
            
            return true;
        }).slice(0, BATCH_SIZE);

        console.log(`[Organizer] Found ${unprocessed.length} unprocessed photos (batch size max ${BATCH_SIZE}).`);

        if (unprocessed.length === 0) return;

        // Check Ollama model
        try {
            const tagsRes = await fetch(`${config.ollamaBaseUrl}/api/tags`);
            const tagsData = await tagsRes.json() as any;
            const hasLlava = tagsData.models?.some((m: any) => m.name.startsWith(VISION_MODEL));
            
            if (!hasLlava) {
                console.warn(`[Organizer] ⚠ Vision model '${VISION_MODEL}' not found in Ollama.`);
                console.warn(`[Organizer] Please run: curl ${config.ollamaBaseUrl}/api/pull -d '{"name":"${VISION_MODEL}"}'`);
                return;
            }
        } catch (e: any) {
            console.error('[Organizer] Cannot connect to Ollama:', e.message);
            return;
        }

        // 3. Process each photo
        for (let i = 0; i < unprocessed.length; i++) {
            const asset = unprocessed[i];
            console.log(`\n[Organizer] Processing ${i+1}/${unprocessed.length}: ${asset.id}`);
            
            try {
                // Fetch thumbnail (faster than original, sufficient for LLM)
                // We use the thumbnail endpoint (isWeb=true gives reasonable quality)
                const imageBuffer = await immichFetch(`/assets/${asset.id}/thumbnail?size=large`);
                
                console.log(`[Organizer] Downloaded thumbnail (${Math.round(imageBuffer.length / 1024)} KB). Analyzing with ${VISION_MODEL}...`);
                
                const description = await analyzeImage(imageBuffer);
                console.log(`[Organizer] ✨ AI Description: "${description}"`);
                
                if (!dryRun) {
                    // Update EXIF description in Immich
                    await immichFetch(`/assets/${asset.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ description })
                    });
                    
                    // Mark as processed
                    db.prepare('INSERT INTO immich_processed (asset_id, status) VALUES (?, ?)').run(asset.id, 'success');
                    console.log(`[Organizer] Saved to Immich and marked as processed.`);
                } else {
                    console.log(`[Organizer] (Dry Run) Would save to Immich.`);
                }
                
            } catch (err: any) {
                console.error(`[Organizer] ❌ Error processing ${asset.id}:`, err.message);
                if (!dryRun) {
                    db.prepare('INSERT INTO immich_processed (asset_id, status) VALUES (?, ?)').run(asset.id, 'error');
                }
            }
        }
        
        console.log('\n[Organizer] Batch complete.');

    } catch (err: any) {
        console.error('[Organizer] Fatal error:', err.message);
    } finally {
        db.close();
    }
}

// Check if run directly
if (require.main === module) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    runOrganizer(dryRun).then(() => process.exit(0));
}

export { runOrganizer };
