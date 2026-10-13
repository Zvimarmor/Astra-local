#!/usr/bin/env node
/**
 * Patch the installed @openclaw/whatsapp plugin so a failed chat turn sends a
 * short Hebrew notice instead of silence.
 *
 * WHY
 * ---
 * When every model in the chain fails (e.g. Google 503 "overloaded" on both
 * Gemini models, 2026-10-13), OpenClaw builds an error reply and marks it
 * `isError`. The WhatsApp plugin's auto-reply path then drops it outright:
 *
 *     function resolveWhatsAppDeliverablePayload(payload, info) {
 *         ...
 *         if (payload.isError === true) return null;
 *
 * so the user sees "typing…" and then nothing, with no config key to change it.
 * This rewrites that one line: a FINAL error payload becomes a plain reply whose
 * text comes from dist/failure-notice.js. Tool/block error payloads keep being
 * dropped exactly as before (they are progress noise, not the turn's answer).
 *
 * Same contract as scripts/patch-whatsapp-notice.js: idempotent, keeps a
 * backup, refuses to force a patch onto changed plugin internals, and the
 * bridge is lazy + fail-closed (a broken dist/ means "stay silent", never
 * "gateway down").
 *
 *   node scripts/patch-whatsapp-failure-notice.js            # apply (idempotent)
 *   node scripts/patch-whatsapp-failure-notice.js --check    # report status only
 *   node scripts/patch-whatsapp-failure-notice.js --revert   # restore the backup
 *
 * Re-run after every `openclaw plugins update` (npm run patch:whatsapp runs
 * both patches), then restart the gateway.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'ASTRA-FAILURE-NOTICE';
const NOTICE_MODULE = path.join(__dirname, '..', 'dist', 'failure-notice.js');
const PLUGIN_GLOB_ROOT = path.join(os.homedir(), '.openclaw', 'npm', 'projects');

/** Locate the plugin's monitor bundle. Its hash suffix changes per release. */
function findMonitorFile() {
    if (!fs.existsSync(PLUGIN_GLOB_ROOT)) return null;
    for (const project of fs.readdirSync(PLUGIN_GLOB_ROOT)) {
        if (!project.startsWith('openclaw-whatsapp-')) continue;
        const dist = path.join(PLUGIN_GLOB_ROOT, project, 'node_modules', '@openclaw', 'whatsapp', 'dist');
        if (!fs.existsSync(dist)) continue;
        for (const file of fs.readdirSync(dist)) {
            if (!/^monitor-.*\.js$/.test(file)) continue;
            const full = path.join(dist, file);
            if (fs.readFileSync(full, 'utf8').includes('function resolveWhatsAppDeliverablePayload')) return full;
        }
    }
    return null;
}

// ── The two hunks ───────────────────────────────────────────────────────────

const PREAMBLE = `// ${MARKER}: bridge to Astra's Hebrew failure notice (lazy; CJS from ESM).
import { createRequire as __astraFailCreateRequire } from "node:module";
const __astraFailRequire = __astraFailCreateRequire(import.meta.url);
let __astraFailCache = null;
function __astraFailureNotice() {
\tif (!__astraFailCache) __astraFailCache = __astraFailRequire(${JSON.stringify(NOTICE_MODULE)});
\treturn __astraFailCache;
}
`;

const ORIGINAL_HUNK = `function resolveWhatsAppDeliverablePayload(payload, info) {
\tif (payload.isReasoning === true || payload.isCompactionNotice === true) return null;
\tif (payload.isError === true) return null;`;

const PATCHED_HUNK = `function resolveWhatsAppDeliverablePayload(payload, info) {
\tif (payload.isReasoning === true || payload.isCompactionNotice === true) return null;
\tif (payload.isError === true) {
\t\t// ${MARKER}: a failed turn's FINAL reply becomes a short Hebrew notice
\t\t// instead of being dropped. Anything else marked isError stays dropped.
\t\tif (info?.kind !== "final") return null;
\t\ttry {
\t\t\tconst { isError: _drop, ...rest } = payload;
\t\t\treturn { ...rest, text: __astraFailureNotice().failureNoticeText(payload.text) };
\t\t} catch (err) {
\t\t\tconsole.error("[${MARKER}] unavailable, staying silent:", String(err).slice(0, 200));
\t\t\treturn null;
\t\t}
\t}`;

// ── Actions ─────────────────────────────────────────────────────────────────

const backupPathFor = target => `${target}.astra-orig`;

function apply(target) {
    const src = fs.readFileSync(target, 'utf8');
    if (src.includes(MARKER)) {
        console.log(`✓ already patched: ${target}`);
        return 0;
    }
    if (!src.includes(ORIGINAL_HUNK)) {
        console.error(`✗ the expected resolveWhatsAppDeliverablePayload hunk was not found in:\n  ${target}`);
        console.error('  The plugin internals changed. Re-read the file and update ORIGINAL_HUNK');
        console.error('  before retrying — do NOT force this patch.');
        return 1;
    }
    const backup = backupPathFor(target);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, src);
    fs.writeFileSync(target, PREAMBLE + src.replace(ORIGINAL_HUNK, PATCHED_HUNK));
    console.log(`✓ patched: ${target}`);
    console.log(`  backup:  ${backup}`);
    console.log('  now run: openclaw gateway restart');
    return 0;
}

function revert(target) {
    const backup = backupPathFor(target);
    if (!fs.existsSync(backup)) {
        console.error(`✗ no backup at ${backup} — reinstall the plugin instead.`);
        return 1;
    }
    fs.writeFileSync(target, fs.readFileSync(backup, 'utf8'));
    console.log(`✓ reverted: ${target}`);
    console.log('  now run: openclaw gateway restart');
    return 0;
}

function check(target) {
    const patched = fs.readFileSync(target, 'utf8').includes(MARKER);
    console.log(`${patched ? '✓ patched' : '✗ NOT patched'}: ${target}`);
    return patched ? 0 : 1;
}

function main() {
    const target = findMonitorFile();
    if (!target) {
        console.error('✗ could not find the installed @openclaw/whatsapp monitor bundle under');
        console.error(`  ${PLUGIN_GLOB_ROOT}`);
        process.exit(1);
    }
    if (!fs.existsSync(NOTICE_MODULE)) {
        console.error(`✗ ${NOTICE_MODULE} is missing — run \`npm run build\` first.`);
        process.exit(1);
    }
    const mode = process.argv[2];
    if (mode === '--check') process.exit(check(target));
    if (mode === '--revert') process.exit(revert(target));
    if (mode && mode !== '--apply') {
        console.error(`unknown option: ${mode} (expected --apply, --check or --revert)`);
        process.exit(1);
    }
    process.exit(apply(target));
}

main();
