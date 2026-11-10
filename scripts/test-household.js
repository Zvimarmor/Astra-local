#!/usr/bin/env node
/**
 * Household tests: balance maths, alert and approval thresholds, shopping-list parsing,
 * the identity rules, the scheduler jobs, and the roommate profile's isolation.
 *
 *   npm run build && npm run test:household
 *
 * Runs against a throwaway SQLite file, never data/memory.db, and sends nothing: the
 * outbox is only inspected.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-household-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.HOUSEHOLD_ENABLED = 'true';
process.env.HOUSEHOLD_BALANCE_ALERT = '400';
process.env.HOUSEHOLD_APPROVAL_THRESHOLD = '500';
process.env.HOUSEHOLD_BILL_MONTHS_ELECTRICITY = '1,3,5,7,9,11';
process.env.HOUSEHOLD_BILL_MONTHS_WATER = '1,3,5,7,9,11';
process.env.HOUSEHOLD_BILL_MONTHS_ARNONA = '2,4,6,8,10,12';
process.env.HOUSEHOLD_BILL_CHECK_DAY = '15';
process.env.HOUSEHOLD_BILL_MONTHS_INTERNET = '';

const DIST = path.join(__dirname, '..', 'dist');
const origLog = console.log;
console.log = () => {}; // config.js prints the DB path on load
const hh = require(path.join(DIST, 'household.js'));
const { makeHouseholdTool } = require(path.join(DIST, 'household-tools.js'));
console.log = origLog;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ''}`); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, a);
const section = (t) => console.log(`\n${t}`);

(async () => {
    // ─── Pure balance maths ─────────────────────────────────────────
    section('computeBalance (positive = Michal owes Zvi, 50/50 split)');
    const E = (payer, amount, status = 'approved') => ({ payer, amount, status });
    eq(hh.computeBalance([], []), 0, 'empty → 0');
    eq(hh.computeBalance([E('zvi', 100)], []), 50, 'Zvi paid 100 → Michal owes 50');
    eq(hh.computeBalance([E('michal', 300)], []), -150, 'Michal paid 300 → Zvi owes 150');
    eq(hh.computeBalance([E('zvi', 1000), E('michal', 200)], []), 400, 'Zvi 1000, Michal 200 → 400');
    eq(hh.computeBalance([E('zvi', 1000, 'pending_approval')], []), 0, 'pending expenses do not count');
    eq(hh.computeBalance([E('zvi', 1000, 'rejected')], []), 0, 'rejected expenses do not count');
    eq(hh.computeBalance([E('zvi', 1000)], [{ from_person: 'michal', to_person: 'zvi', amount: 500 }]), 0, 'Michal settles 500 → even');
    eq(hh.computeBalance([E('michal', 200)], [{ from_person: 'zvi', to_person: 'michal', amount: 100 }]), 0, 'Zvi settles 100 → even');
    eq(hh.computeBalance([E('zvi', 33.33)], []), 16.67, 'rounds to agorot');

    section('shouldAlertBalance (threshold 400)');
    ok(!hh.shouldAlertBalance(0, 400, 400), 'exactly 400 → no alert');
    ok(hh.shouldAlertBalance(390, 401, 400), 'crossing above 400 → alert');
    ok(hh.shouldAlertBalance(-390, -450, 400), 'crossing in the other direction → alert');
    ok(!hh.shouldAlertBalance(450, 520, 400), 'growing while above (same step) → no repeat alert');
    ok(hh.shouldAlertBalance(790, 810, 400), 'growing past the next step (800) → alert');
    ok(hh.shouldAlertBalance(450, -450, 400), 'flipping direction while above → alert');
    ok(!hh.shouldAlertBalance(450, 300, 400), 'dropping below → no alert');

    section('needsApproval (threshold 500)');
    ok(!hh.needsApproval(500, 'קניות', false, 500), '₪500 exactly → approved directly');
    ok(hh.needsApproval(500.01, 'מקרר', false, 500), 'over ₪500 → pending');
    ok(hh.needsApproval(200, 'אינסטלטור לכיור', false, 500), 'plumber keyword → pending');
    ok(hh.needsApproval(120, 'Plumber visit', false, 500), 'English plumber → pending');
    ok(hh.needsApproval(150, 'משהו', true, 500), 'major_repair flag → pending');

    section('category / bill detection');
    eq(hh.detectBillType('חשבון חשמל'), 'electricity', 'חשמל → electricity');
    eq(hh.detectBillType('חשבון מים לחודשיים'), 'water', 'מים → water');
    eq(hh.detectBillType('ארנונה'), 'arnona', 'ארנונה → arnona');
    eq(hh.detectBillType('ממים'), null, 'no false match inside a word');
    eq(hh.detectBillType('וייפיי פרטנר'), 'internet', 'וייפיי פרטנר → internet');
    eq(hh.detectBillType('Partner wifi'), 'internet', 'Partner wifi → internet');
    eq(hh.inferCategory('קניות בשופרסל', null), 'groceries', 'שופרסל → groceries');
    eq(hh.inferCategory('תיקון מזגן', null), 'maintenance', 'תיקון → maintenance');
    ok(hh.isSupermarketExpense('other', 'רמי לוי'), 'רמי לוי counts as a supermarket run');

    section('shopping-list parsing');
    const P = (s) => hh.parseShoppingItem(s);
    eq(P('חלב'), { name: 'חלב', quantity: null }, '"חלב" → no quantity (ask)');
    eq(P('2 חלב 3%'), { name: 'חלב 3%', quantity: '2' }, '"2 חלב 3%"');
    eq(P('חלב 3%'), { name: 'חלב 3%', quantity: null }, '"חלב 3%" → the 3 is not a quantity');
    eq(P('12 ביצים L'), { name: 'ביצים L', quantity: '12' }, '"12 ביצים L"');
    eq(P('שתי קופסאות טונה'), { name: 'טונה', quantity: '2 קופסאות' }, 'Hebrew number word + unit');
    eq(P('קרטון ביצים'), { name: 'ביצים', quantity: '1 קרטון' }, 'unit alone → 1 unit');
    eq(P('חבילת פסטה'), { name: 'פסטה', quantity: '1 חבילה' }, 'construct form normalised');
    eq(P('500 גרם גבינה צהובה'), { name: 'גבינה צהובה', quantity: '500 גרם' }, 'number + unit');
    eq(P('במבה x3'), { name: 'במבה', quantity: '3' }, 'trailing x3');
    eq(P('עגבניות 2 ק"ג'), { name: 'עגבניות', quantity: '2 ק"ג' }, 'trailing number + unit');
    eq(hh.parseShoppingItems('2 חלב 3%, לחם\n 6 יוגורט ;  ').length, 3, 'splits on commas, newlines, semicolons');

    // ─── Store + identity rules, through the real tool ─────────────
    const D = '2026-11-05'; // fixed, so the digest test doesn't depend on today
    const zvi = makeHouseholdTool('zvi');
    const michal = makeHouseholdTool('michal');
    const outbox = () => hh.getPendingOutbox();
    const clearOutbox = () => outbox().forEach(r => hh.markOutbox(r.id, 'sent'));

    section('expenses, approvals and alerts (tool level)');
    let r = await zvi.execute({ action: 'add_expense', amount: 300, description: 'קניות בשופרסל', date: D });
    eq([r.status, r.expense.status, r.expense.created_by, r.expense.category, r.balance], ['success', 'approved', 'zvi', 'groceries', 150], 'Zvi logs ₪300 groceries → approved, Michal owes 150');
    eq(outbox().length, 0, 'no alert below the threshold');

    r = await zvi.execute({ action: 'add_expense', amount: 400, description: 'חשבון חשמל', payer: 'zvi', date: D });
    eq([r.expense.bill_type, r.expense.category, r.balance, r.balance_alert_sent_to_both], ['electricity', 'utilities', 350, false], 'electricity bill → 350, still under');
    r = await zvi.execute({ action: 'add_expense', amount: 200, description: 'מים', date: D });
    eq([r.balance, r.balance_alert_sent_to_both], [450, true], 'crosses ₪400 → alert queued');
    eq(outbox().map(o => o.recipient).sort(), ['michal', 'zvi'], 'alert goes to BOTH');
    ok(outbox()[0].text.includes('מיכל חייבת לצבי ₪450'), 'alert says who owes whom', outbox()[0].text);
    clearOutbox();

    r = await michal.execute({ action: 'add_expense', amount: 650, description: 'מקרר יד שנייה', date: D });
    eq([r.pending_approval, r.expense.status, r.expense.created_by, r.balance], [true, 'pending_approval', 'michal', 450], 'Michal logs ₪650 → pending, balance unchanged');
    eq(outbox().map(o => [o.recipient, o.kind]), [['zvi', 'approval_request']], 'approval request goes only to Zvi');
    const pendingId = r.expense.id;
    clearOutbox();

    r = await michal.execute({ action: 'approve', expense_id: pendingId });
    ok(r.status === 'error' && /only צבי/.test(r.error), 'Michal cannot approve her own expense', r);
    r = await zvi.execute({ action: 'pending' });
    eq([r.waiting_for_you.length, r.waiting_for_other.length], [1, 0], 'Zvi sees it waiting for him');
    r = await zvi.execute({ action: 'approve', expense_id: pendingId });
    eq([r.status, r.expense.status, r.balance], ['success', 'approved', 125], 'Zvi approves → counts (450 − 325)');
    eq(outbox().map(o => [o.recipient, o.kind]), [['michal', 'approval_result']], 'Michal is told it was approved; no balance alert (dropped below)');
    clearOutbox();

    r = await zvi.execute({ action: 'add_expense', amount: 180, description: 'אינסטלטור', date: D });
    eq([r.expense.status, r.approval_requested_from], ['pending_approval', 'מיכל'], 'plumber ₪180 → pending, Michal asked');
    const plumberId = r.expense.id;
    clearOutbox();
    r = await michal.execute({ action: 'reject', expense_id: plumberId, note: 'סוכם שבעל הבית משלם' });
    eq([r.expense.status, r.balance], ['rejected', 125], 'Michal rejects → never counts');
    clearOutbox();

    r = await michal.execute({ action: 'delete_expense', expense_id: 1 });
    ok(r.status === 'error', 'Michal cannot delete Zvi\'s expense');

    r = await michal.execute({ action: 'settle', amount: 125 });
    eq([r.settlement.from, r.settlement.to, r.balance], ['michal', 'zvi', 0], 'Michal settles ₪125 (default: speaker paid) → even');
    eq(outbox().map(o => [o.recipient, o.kind]), [['zvi', 'settlement']], 'Zvi is told about the transfer');
    clearOutbox();

    section('shopping list (tool level)');
    r = await michal.execute({ action: 'add_items', items: 'חלב, 2 לחם אחיד, 12 ביצים L' });
    eq([r.status, r.added.length, r.needs_clarification], ['success', 2, ['חלב']], '"חלב" without quantity is refused and asked about');
    r = await zvi.execute({ action: 'add_items', items: 'חלב' });
    eq(r.status, 'needs_clarification', 'only-ambiguous input → needs_clarification');
    r = await zvi.execute({ action: 'add_items', items: '2 לחם אחיד, 1 חלב 3%' });
    eq([r.added.map(x => x.item), r.already_on_list.map(x => x.item)], [['חלב 3%'], ['לחם אחיד']], 'duplicates are not re-added');
    r = await zvi.execute({ action: 'list_items' });
    eq(r.count, 3, 'three open items');

    r = await zvi.execute({ action: 'add_expense', amount: 240, description: 'קניות ברמי לוי', date: D });
    ok(Array.isArray(r.shopping_list_open_items) && r.shopping_list_open_items.length === 3 && !!r.suggestion, 'supermarket expense → offers the open list');
    clearOutbox();
    r = await zvi.execute({ action: 'mark_purchased', names: 'ביצים, לחם' });
    eq([r.marked_purchased.sort(), r.still_open.map(x => x.item)], [['ביצים L', 'לחם אחיד'].sort(), ['חלב 3%']], 'mark by name');
    r = await zvi.execute({ action: 'mark_purchased', all: true });
    eq(r.still_open.length, 0, 'mark all');

    section('scheduler jobs');
    // Balance is now 120 (Zvi paid 240 after the settlement).
    let res = hh.runMonthlyDigestJob('2026-12-01');
    eq(res, 'queued', 'digest on the 1st → queued');
    const digest = outbox().filter(o => o.kind === 'monthly_digest');
    eq(digest.map(o => o.recipient).sort(), ['michal', 'zvi'], 'digest goes to both');
    const dt = digest[0].text;
    ok(/נובמבר 2026/.test(dt) && dt.includes('₪1,790') && dt.includes('מכולת וסופר: ₪540') && dt.includes('חשבונות: ₪600')
        && dt.includes('צבי: ₪1,140') && dt.includes('מיכל: ₪650') && dt.includes('מיכל חייבת לצבי ₪120'), 'digest content is right', dt);
    eq(hh.runMonthlyDigestJob('2026-12-02'), 'skipped', 'not twice in a month');
    eq(hh.runMonthlyDigestJob('2027-01-09'), 'skipped', 'not after the 7th (missed month stays missed)');
    clearOutbox();

    eq(hh.runBillCheckJob('2027-01-14'), 'skipped', 'bill check waits for the 15th');
    eq(hh.runBillCheckJob('2027-01-15'), 'queued', 'Jan 15 with no bills logged → reminder');
    const bill = outbox().filter(o => o.kind === 'bill_reminder');
    eq(bill.map(o => o.recipient).sort(), ['michal', 'zvi'], 'reminder goes to both');
    eq(bill[0].text, '🏠 לא נרשם תשלום חשמל/מים החודש, תרצו שאזין סכום?', 'reminder wording (arnona not expected in January)');
    eq(hh.runBillCheckJob('2027-01-20'), 'skipped', 'once per month');
    clearOutbox();
    await zvi.execute({ action: 'add_expense', amount: 300, description: 'ארנונה', date: '2027-02-03' });
    clearOutbox();
    eq(hh.runBillCheckJob('2027-02-16'), 'skipped', 'February: arnona logged, nothing else expected → silent');

    section('roommate profile isolation');
    const probe = `
        const { toolRegistry } = require('./dist/registry/index.js');
        const mods = Object.keys(require.cache).filter(p => p.includes('/dist/')).map(p => p.split('/dist/')[1]).sort();
        process.stdout.write('@@' + JSON.stringify({ tools: Object.keys(toolRegistry), mods }));`;
    const run = (profile) => JSON.parse(String(execFileSync(process.execPath, ['-e', probe], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ASTRA_PROFILE: profile },
        stdio: ['ignore', 'pipe', 'ignore'],
    })).split('@@').pop()); // dotenv prints to stdout first
    const h = run('household');
    eq(h.tools, ['manage_household'], 'household profile serves only manage_household');
    eq(h.mods, ['config.js', 'household-tools.js', 'household.js', 'registry/household-profile.js', 'registry/index.js'], 'household profile loads no owner module');
    const bad = run('househld');
    eq(bad.tools, [], 'a mistyped profile serves no tools (fails closed)');
    const desc = (await (async () => makeHouseholdTool('michal').description)());
    ok(desc.includes('You are talking to מיכל'), 'roommate tool is pinned to Michal');

    console.log(`\n${pass} passed, ${fail} failed`);
    hh.closeHouseholdDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
