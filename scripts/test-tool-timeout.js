#!/usr/bin/env node
/**
 * Tool time-limit test (tools/tool-timeout.ts, used by every MCP tool call).
 *
 *   npm run build && npm run test:tool-timeout      (~31s: it waits out the real 30s limit)
 *
 * A tool stalled for 60s must come back as a timeout error at ~30s, other calls must
 * keep working while it hangs, and the timeout must reach the user as the Hebrew notice.
 */
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const { executeWithTimeout, toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS } = require(path.join(DIST, 'tool-timeout.js'));
const { failureNoticeText } = require(path.join(DIST, 'failure-notice.js'));

let pass = 0, fail = 0;
const ok = (c, name, got) => { if (c) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`); } };

const hanging = { name: 'manage_tasks', execute: () => new Promise((r) => setTimeout(() => r({ status: 'success', late: true }), 60_000)) };
const fast = { name: 'manage_notes', execute: async (a) => ({ status: 'success', echo: a.x }) };
const throwing = { name: 'manage_habits', execute: async () => { throw new Error('boom'); } };

(async () => {
    console.log('limits');
    ok(DEFAULT_TOOL_TIMEOUT_MS === 30_000, 'default limit is 30s');
    ok(toolTimeoutMs('manage_tasks') === 30_000, 'ordinary tool → 30s');
    ok(toolTimeoutMs('manage_email') === 90_000, 'manage_email → 90s (IMAP + Gmail + Gemini)');
    ok(toolTimeoutMs('run_claude_code') === null, 'run_claude_code → its own limit');

    console.log('\nnormal calls');
    ok((await executeWithTimeout(fast, { x: 7 })).echo === 7, 'a fast tool returns its result');
    let threw = false;
    try { await executeWithTimeout(throwing, {}); } catch (e) { threw = e.message === 'boom'; }
    ok(threw, 'a tool that throws still throws (MCP reports it as isError)');

    console.log('\na tool stalled for 60s (waiting out the real 30s limit)…');
    const t0 = Date.now();
    const hung = executeWithTimeout(hanging, {});
    // While it hangs, other calls must not be blocked.
    const t1 = Date.now();
    const during = await executeWithTimeout(fast, { x: 'during' });
    ok(during.echo === 'during' && Date.now() - t1 < 1000, 'other tool calls run normally while one hangs');
    const res = await hung;
    const elapsed = (Date.now() - t0) / 1000;
    ok(res.status === 'error' && res.timed_out === true, 'stalled tool comes back as a timeout error', res);
    ok(elapsed >= 29.5 && elapsed < 32, `returned at the limit (${elapsed.toFixed(1)}s), not after 60s`);
    ok(/did not finish within 30 seconds/.test(res.error), 'error is readable for the model');
    const after = await executeWithTimeout(fast, { x: 'after' });
    ok(after.echo === 'after', 'the next call works normally afterwards');

    console.log('\nwhat the user sees when a whole turn is cut off');
    const n = failureNoticeText('Agent run timed out after 300000ms');
    ok(n.startsWith('⚠️ הפעולה לקחה יותר מדי זמן ונעצרה כדי לא לתקוע את המערכת — אפשר לנסות שוב.'), 'turn timeout → Hebrew notice', n);
    ok(failureNoticeText('Request was aborted').includes('ונעצרה'), 'aborted run → same notice');
    ok(failureNoticeText('429 RESOURCE_EXHAUSTED').includes('מכסת'), 'quota errors keep their own notice');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0); // the stalled 60s timer is still pending; don't wait for it
})().catch((e) => { console.error(e); process.exit(1); });
