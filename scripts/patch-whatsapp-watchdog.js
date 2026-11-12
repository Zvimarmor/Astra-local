#!/usr/bin/env node
/**
 * Patch the installed @openclaw/whatsapp plugin so a quiet chat doesn't force a reconnect
 * every 2 hours.
 *
 * WHY (investigated 2026-11-12)
 * -----------------------------
 * The plugin's connection watchdog closes the socket (status 499, "app-silent") whenever no
 * incoming message has been handled for `messageTimeoutMs × 4` = 2 hours, and for only
 * 30 minutes right after a reconnect of a recently active session. Neither is configurable.
 * On a personal bot that's quiet all night, that is ~9 forced reconnects a day.
 * Every WhatsApp logout so far (5 between July and November) was a
 * `401 … (conflict)` in the early morning shortly after such a reconnect, and the
 * reconnect count has been rising month over month.
 *
 * This raises both windows to 8 hours. The separate TRANSPORT check (no frames at all for
 * 5 minutes → reconnect) is untouched, so a genuinely dead socket is still replaced
 * within minutes.
 *
 * Same contract as the other patch scripts: idempotent, keeps a backup, refuses to force
 * a patch onto changed plugin internals.
 *
 *   node scripts/patch-whatsapp-watchdog.js            # apply (idempotent)
 *   node scripts/patch-whatsapp-watchdog.js --check    # report status only
 *   node scripts/patch-whatsapp-watchdog.js --revert   # restore the backup
 *
 * Re-run after every `openclaw plugins update` (npm run patch:whatsapp runs all patches),
 * then restart the gateway.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'ASTRA-WATCHDOG-WINDOW';
const WINDOW_EXPR = '8 * 60 * 60 * 1e3';
const PLUGIN_GLOB_ROOT = path.join(os.homedir(), '.openclaw', 'npm', 'projects');

/** Locate the plugin's connection-controller bundle. Its hash suffix changes per release. */
function findControllerFile() {
    if (!fs.existsSync(PLUGIN_GLOB_ROOT)) return null;
    for (const project of fs.readdirSync(PLUGIN_GLOB_ROOT)) {
        if (!project.startsWith('openclaw-whatsapp-')) continue;
        const dist = path.join(PLUGIN_GLOB_ROOT, project, 'node_modules', '@openclaw', 'whatsapp', 'dist');
        if (!fs.existsSync(dist)) continue;
        for (const file of fs.readdirSync(dist)) {
            if (!/^connection-controller-.*\.js$/.test(file)) continue;
            const full = path.join(dist, file);
            if (fs.readFileSync(full, 'utf8').includes('appSilenceTimeoutMs')) return full;
        }
    }
    return null;
}

const HUNKS = [
    {
        original: '\t\tthis.appSilenceTimeoutMs = Math.max(params.messageTimeoutMs, params.messageTimeoutMs * 4);',
        patched: `\t\t// ${MARKER}: 8h instead of messageTimeoutMs × 4 (2h); see Astra scripts/patch-whatsapp-watchdog.js\n` +
            `\t\tthis.appSilenceTimeoutMs = Math.max(params.messageTimeoutMs * 4, ${WINDOW_EXPR});`,
    },
    {
        original: '\t\t\tconst appSilenceTimeoutMs = connection.openedAfterRecentInbound ? this.messageTimeoutMs : this.appSilenceTimeoutMs;',
        patched: `\t\t\t// ${MARKER}: no shorter 30-minute window after a reconnect.\n` +
            '\t\t\tconst appSilenceTimeoutMs = this.appSilenceTimeoutMs;',
    },
];

const backupPathFor = target => `${target}.astra-orig`;

function apply(target) {
    const src = fs.readFileSync(target, 'utf8');
    if (src.includes(MARKER)) {
        console.log(`✓ already patched: ${target}`);
        return 0;
    }
    const missing = HUNKS.filter(h => !src.includes(h.original));
    if (missing.length) {
        console.error(`✗ ${missing.length} expected hunk(s) not found in:\n  ${target}`);
        console.error('  The plugin internals changed. Re-read the file and update HUNKS');
        console.error('  before retrying — do NOT force this patch.');
        return 1;
    }
    const backup = backupPathFor(target);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, src);
    let out = src;
    for (const h of HUNKS) out = out.replace(h.original, h.patched);
    fs.writeFileSync(target, out);
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
    const target = findControllerFile();
    if (!target) {
        console.error('✗ could not find the installed @openclaw/whatsapp connection-controller bundle under');
        console.error(`  ${PLUGIN_GLOB_ROOT}`);
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
