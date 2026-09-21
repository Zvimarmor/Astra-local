#!/usr/bin/env node
/**
 * Patch the installed @openclaw/whatsapp plugin so unapproved senders get
 * Astra's polite Hebrew redirect instead of OpenClaw's pairing-code block.
 *
 * WHY A PATCH SCRIPT LIVES IN THIS REPO
 * -------------------------------------
 * OpenClaw refuses unauthorized DMs inside the WhatsApp ingress gate
 * (checkInboundAccessControl -> `if (!access.allowed) return null`), which runs
 * BEFORE dispatch. No hook, no agent and no MCP tool ever sees those messages,
 * and no config key customizes the pairing text. So the only place the reply
 * can be swapped is inside the plugin itself — which lives outside this repo,
 * under ~/.openclaw/npm/projects/, and is overwritten by any plugin
 * reinstall/upgrade. Hence: a tracked, idempotent, re-runnable patcher.
 *
 *   node scripts/patch-whatsapp-notice.js            # apply (idempotent)
 *   node scripts/patch-whatsapp-notice.js --check    # report status only
 *   node scripts/patch-whatsapp-notice.js --revert   # restore the backup
 *
 * Re-run after every `openclaw plugins update`, then restart the gateway.
 * See docs/WHATSAPP-UNAUTHORIZED-NOTICE.md.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'ASTRA-UNAUTHORIZED-NOTICE';
const NOTICE_MODULE = path.join(__dirname, '..', 'dist', 'unauthorized-notice.js');
const PLUGIN_GLOB_ROOT = path.join(os.homedir(), '.openclaw', 'npm', 'projects');

/** Locate the plugin's access-control bundle. Its hash suffix changes per release. */
function findAccessControlFile() {
    if (!fs.existsSync(PLUGIN_GLOB_ROOT)) return null;
    for (const project of fs.readdirSync(PLUGIN_GLOB_ROOT)) {
        if (!project.startsWith('openclaw-whatsapp-')) continue;
        const dist = path.join(PLUGIN_GLOB_ROOT, project, 'node_modules', '@openclaw', 'whatsapp', 'dist');
        if (!fs.existsSync(dist)) continue;
        for (const file of fs.readdirSync(dist)) {
            if (!/^access-control-.*\.js$/.test(file)) continue;
            const full = path.join(dist, file);
            if (fs.readFileSync(full, 'utf8').includes('checkInboundAccessControl')) return full;
        }
    }
    return null;
}

// ── The two hunks ───────────────────────────────────────────────────────────

// The plugin is ESM and our build is CommonJS, so the bridge is createRequire.
// It is lazy: a missing or broken dist/ must not take the gateway down at
// import time, it must only mean "no redirect gets sent".
const PREAMBLE = `// ${MARKER}: bridge to Astra's cooldown ledger (lazy; CJS from ESM).
import { createRequire as __astraCreateRequire } from "node:module";
const __astraRequire = __astraCreateRequire(import.meta.url);
let __astraNoticeCache = null;
function __astraNotice() {
\tif (!__astraNoticeCache) __astraNoticeCache = __astraRequire(${JSON.stringify(NOTICE_MODULE)});
\treturn __astraNoticeCache;
}
`;

// Note `_text` is discarded on purpose: that argument IS OpenClaw's
// pairing-code block, and dropping it is what suppresses the default message.
// The pairing request itself is still upserted by the surrounding call, so
// `openclaw pairing list/approve whatsapp` still works for admitting a real
// person.
const ORIGINAL_HUNK = `\t\t\t\tsendPairingReply: async (text) => {
\t\t\t\t\tawait params.sock.sendMessage(params.remoteJid, { text });
\t\t\t\t},`;

const PATCHED_HUNK = `\t\t\t\tsendPairingReply: async (_text) => {
\t\t\t\t\t// ${MARKER}: replace the pairing-code block with Astra's Hebrew
\t\t\t\t\t// redirect, at most once per sender per 7 days. Fails closed.
\t\t\t\t\tlet __astraMsg = null;
\t\t\t\t\ttry {
\t\t\t\t\t\t__astraMsg = __astraNotice().claimUnauthorizedNotice(candidate);
\t\t\t\t\t} catch (err) {
\t\t\t\t\t\tconsole.error("[${MARKER}] unavailable, staying silent:", String(err).slice(0, 200));
\t\t\t\t\t}
\t\t\t\t\tif (!__astraMsg) return;
\t\t\t\t\tawait params.sock.sendMessage(params.remoteJid, { text: __astraMsg });
\t\t\t\t},`;

// ── Actions ─────────────────────────────────────────────────────────────────

function backupPathFor(target) {
    return `${target}.astra-orig`;
}

function apply(target) {
    const src = fs.readFileSync(target, 'utf8');

    if (src.includes(MARKER)) {
        console.log(`✓ already patched: ${target}`);
        return 0;
    }
    if (!src.includes(ORIGINAL_HUNK)) {
        console.error(`✗ the expected sendPairingReply hunk was not found in:\n  ${target}`);
        console.error('  The plugin internals changed. Re-read the file and update ORIGINAL_HUNK');
        console.error('  before retrying — do NOT force this patch.');
        return 1;
    }

    const backup = backupPathFor(target);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, src);

    const patched = PREAMBLE + src.replace(ORIGINAL_HUNK, PATCHED_HUNK);
    fs.writeFileSync(target, patched);

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
    const target = findAccessControlFile();
    if (!target) {
        console.error('✗ could not find the installed @openclaw/whatsapp access-control bundle under');
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
