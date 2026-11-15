#!/usr/bin/env node
/**
 * Email invitation tests: parsing, the triage pass (invite asked, not double-alerted,
 * held in quiet hours), and the stored-invite lifecycle. Throwaway DB, fake model,
 * nothing sent, no calendar call.   npm run build:all && npm run test:email-invites
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-invites-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const log = console.log; console.log = () => {};
const storage = require(path.join(__dirname, '..', 'dist', 'storage.js'));
const t = require(path.join(__dirname, '..', 'dist-services', 'email-triage.js'));
const { emailInviteTools } = require(path.join(__dirname, '..', 'dist', 'email-invites.js'));
console.log = log;
let pass = 0, fail = 0;
const ok = (c, n, g) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${g !== undefined ? ` — got ${JSON.stringify(g)}` : ''}`); } };

(async () => {
    console.log('parsing');
    ok(JSON.stringify(t.parseInvitation({ title: 'סמינר מחלקה', date: '2026-11-20', start: '14:00', end: '15:30', location: 'חדר 202' })) ===
        JSON.stringify({ title: 'סמינר מחלקה', date: '2026-11-20', start: '14:00', end: '15:30', location: 'חדר 202' }), 'full invitation');
    ok(t.parseInvitation({ title: 'x', date: '20/11/2026' }) === null, 'non-ISO date → none');
    ok(t.parseInvitation({ title: '', date: '2026-11-20' }) === null, 'no title → none');
    ok(t.parseInvitation(null) === null, 'null → none');
    const r = t.parseInvitation({ title: 'ערב', date: '2026-11-20', start: '25:00', end: '10:00' });
    ok(r && r.start === null && r.end === null, 'bad time → all-day, no end', r);
    ok(t.parseInvitation({ title: 'a', date: '2026-11-20', start: '15:00', end: '14:00' }).end === null, 'end before start dropped');
    ok(t.isUpcomingInvitation({ date: '2026-11-15' }, '2026-11-15') && !t.isUpcomingInvitation({ date: '2026-11-14' }, '2026-11-15')
        && !t.isUpcomingInvitation({ date: '2028-01-01' }, '2026-11-15'), 'today..+1y only');

    console.log('\ntriage pass');
    const now = new Date('2026-11-15T09:00:00Z');
    const emails = [
        { account: 'personal', messageKey: 'm1', from: 'דנה <dana@x.com>', subject: 'מוזמן ליום הולדת', date: now.toISOString(), body: 'יום שישי 20.11 ב-20:00 אצלי' },
        { account: 'university', messageKey: 'm2', from: 'Dean', subject: 'Exam moved', date: now.toISOString(), body: 'tomorrow 9am' },
        { account: 'personal', messageKey: 'm3', from: 'Shop', subject: 'Webinar!', date: now.toISOString(), body: 'buy' },
    ];
    const sent = [];
    let quiet = true;
    const deps = {
        fetchUnread: async () => [{ account: 'personal', status: 'ok', emails: [emails[0], emails[2]] }, { account: 'university', status: 'ok', emails: [emails[1]] }],
        generate: async () => '[]', // replaced below
        getTriagedKeys: storage.getTriagedEmailKeys, record: storage.recordEmailTriage,
        getPendingAlerts: storage.getPendingEmailAlerts, markAlertsSent: storage.markEmailAlertsSent,
        getSetting: storage.getSetting, setSetting: storage.setSetting,
        notify: async (subj, text) => { sent.push({ subj, text }); return { delivered: true }; },
        quiet: () => quiet, now: () => now, timezone: 'Asia/Jerusalem', windowHours: 24, batchSize: 10, failureNoticeAfter: 12,
        recordInvite: storage.recordEmailInvite, getPendingInvites: storage.getPendingEmailInvites, markInvitesAsked: storage.markEmailInvitesAsked,
    };
    // fetch order is [m1, m3, m2] → model ids 0,1,2 must match that order
    deps.generate = async (sys) => { ok(/invitation:/.test(sys), 'prompt asks for invitations'); return JSON.stringify([
        { id: 0, needs_action: false, event_soon: false, event_time: '', summary: 'הזמנה', proposed_action: '', invitation: { title: 'יום הולדת של דנה', date: '2026-11-20', start: '20:00', end: '', location: '' } },
        { id: 1, needs_action: false, event_soon: false, event_time: '', summary: '', proposed_action: '', invitation: null },
        { id: 2, needs_action: true, event_soon: true, event_time: 'מחר 9:00', summary: 'מבחן הוזז', proposed_action: 'לבדוק', invitation: null },
    ]); };
    let res = await t.runEmailTriagePass(deps);
    ok(sent.length === 0 && res.held === 1, 'quiet hours: nothing sent, urgent held', res);
    ok(storage.getPendingEmailInvites('2026-11-15').length === 1, 'invitation stored as pending');
    quiet = false;
    res = await t.runEmailTriagePass(deps);
    const inviteMsg = sent.find(m => /invitation/.test(m.subj));
    const alertMsg = sent.find(m => /urgent/.test(m.subj));
    ok(inviteMsg && inviteMsg.text.includes('תרצה שנוסיף את האירוע הזה ליומן') && inviteMsg.text.includes('יום הולדת של דנה') && inviteMsg.text.includes('20:00'), 'invitation question sent with details', inviteMsg && inviteMsg.text);
    ok(alertMsg && alertMsg.text.includes('מבחן הוזז') && !alertMsg.text.includes('יום הולדת'), 'urgent alert separate; invitation not repeated in it');
    ok(res.invites === 1, 'pass reports 1 invite');
    sent.length = 0;
    await t.runEmailTriagePass(deps);
    ok(sent.length === 0, 'asked only once');

    console.log('\nchat side');
    let l = await emailInviteTools.list_invites.execute();
    ok(l.count === 1 && l.invites[0].title === 'יום הולדת של דנה' && l.invites[0].start === '20:00', 'invites lists the asked one');
    const id = l.invites[0].invite_id;
    let d = await emailInviteTools.add_invite.execute({ invite_id: 999 });
    ok(d.status === 'error', 'unknown id refused');
    d = await emailInviteTools.decline_invite.execute({ invite_id: id });
    ok(d.status === 'success', 'decline');
    l = await emailInviteTools.list_invites.execute();
    ok(l.count === 0, 'declined invitation no longer open');
    storage.recordEmailInvite({ account: 'personal', message_key: 'old', sender: 'x', subject: 'y', title: 'עבר', event_date: '2020-01-01', start_time: null, end_time: null, location: null });
    ok(storage.getPendingEmailInvites('2026-11-15').length === 0, 'past invitation expires instead of being asked');

    console.log(`\n${pass} passed, ${fail} failed`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
