import { execFile } from 'child_process';
import path from 'path';
import { config } from './config';

/**
 * Channel health probe — is the PRIMARY WhatsApp channel actually linked & live?
 *
 * Runs `openclaw channels status --json` and reads `channels.whatsapp`, which is
 * the gateway's own source of truth (linked / connected / healthState). The
 * scheduler watchdog polls this to catch the silent-unlink failure mode that took
 * the primary channel down for 17 days (Jul 2026): WhatsApp Web kept going stale,
 * OpenClaw wiped its stored creds, and every restart looped "not linked" with
 * nobody watching. See tools/alert.ts for the notification side.
 */

const PROBE_TIMEOUT_MS = 15000;

// Same PATH fix as whatsapp-send.ts: under launchd the inherited PATH omits
// /opt/homebrew/bin, so `openclaw` (a `#!/usr/bin/env node` script) can't find node.
const PROBE_PATH = [path.dirname(process.execPath), process.env.PATH || '']
    .filter(Boolean)
    .join(path.delimiter);

export interface ChannelHealth {
    ok: boolean;            // true = linked AND (connected or healthState 'running')
    linked: boolean;
    connected: boolean;
    healthState: string;    // e.g. 'running', 'not-running'
    statusState: string;    // e.g. 'linked', 'not-linked'
    lastError: string | null;
    probeError?: string;    // set when the probe itself failed → cannot conclude
}

function fail(probeError: string): ChannelHealth {
    return {
        ok: false, linked: false, connected: false,
        healthState: 'unknown', statusState: 'unknown',
        lastError: null, probeError,
    };
}

/** Probe the WhatsApp channel's health via the OpenClaw CLI. Never rejects. */
export function checkWhatsAppHealth(): Promise<ChannelHealth> {
    return new Promise((resolve) => {
        execFile(
            config.whatsapp.openclawBin,
            ['channels', 'status', '--json'],
            { timeout: PROBE_TIMEOUT_MS, env: { ...process.env, PATH: PROBE_PATH }, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => {
                if (err) {
                    resolve(fail(String(err.message || err).slice(0, 200)));
                    return;
                }
                try {
                    const wa = (JSON.parse(stdout)?.channels?.whatsapp) || {};
                    const linked = wa.linked === true;
                    const connected = wa.connected === true;
                    const healthState = String(wa.healthState || 'unknown');
                    resolve({
                        ok: linked && (connected || healthState === 'running'),
                        linked,
                        connected,
                        healthState,
                        statusState: String(wa.statusState || 'unknown'),
                        lastError: wa.lastError ?? null,
                    });
                } catch (e: any) {
                    resolve(fail('parse: ' + String(e?.message || e).slice(0, 150)));
                }
            },
        );
    });
}
