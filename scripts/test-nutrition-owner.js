#!/usr/bin/env node
/**
 * Owner nutrition tests (manage_nutrition): saved foods, servings, manual values, and
 * separation from the guest's data. Throwaway DB; sends nothing.
 *   npm run build && npm run test:nutrition
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-nutrition-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const log = console.log; console.log = () => {};
const DIST = path.join(__dirname, '..', 'dist');
const { megaTools } = require(path.join(DIST, 'registry', 'mega-tools.js'));
const { guestTools } = require(path.join(DIST, 'registry', 'guest-tools.js'));
console.log = log;
let pass = 0, fail = 0;
const ok = (c, n, g) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${g !== undefined ? ` — got ${JSON.stringify(g)}` : ''}`); } };
const me = (a) => megaTools.manage_nutrition.execute(a);
const her = (a) => guestTools.track_nutrition.execute(a);

(async () => {
    let r = await me({ action: 'log_food', description: 'טוסט', calories: 300 });
    ok(r.status === 'needs_onboarding', 'asks for a profile first');
    r = await me({ action: 'set_profile', sex: 'male', height_cm: 178, weight_kg: 75, age: 27 });
    ok(r.status === 'success' && r.targets.daily_target > 1500, 'profile saved, target computed');

    r = await me({ action: 'log_food', description: 'שייק חלבון', calories: 220, protein_g: 30, carbs_g: 10, fat_g: 4 });
    ok(r.status === 'success' && r.eaten === 220 && r.protein_g === 30, 'manual values logged exactly');

    r = await me({ action: 'save_food', name: 'כריך סביח ארומה', calories: 574, protein_g: 22, carbs_g: 60, fat_g: 26, serving: 'כריך שלם', source: 'aroma.co.il' });
    ok(r.status === 'success', 'save_food');
    await me({ action: 'save_food', name: 'כריך טונה ארומה', calories: 480, protein_g: 30 });
    r = await me({ action: 'log_food', saved_food: 'כריך סביח ארומה', servings: 0.5 });
    ok(r.status === 'success' && Math.round(r.eaten) === 507 && r.protein_g === 41, 'half a saved sandwich: 287 kcal, 11g protein', r);
    ok(/saved food/.test(r.source), 'reply says the values came from a saved food');
    r = await me({ action: 'log_food', saved_food: 'כריך ארומה' });
    ok(r.status === 'error' && /several/.test(r.error), 'ambiguous name → asks which one', r);
    r = await me({ action: 'log_food', saved_food: 'פיצה' });
    ok(r.status === 'error' && /No saved food/.test(r.error), 'unknown saved food → estimate or ask');
    r = await me({ action: 'log_food', saved_food: '  כריך  סביח, ארומה ', calories: 600 });
    ok(r.status === 'success' && Math.round(r.eaten) === 1107, 'user-given calories override the saved value');
    r = await me({ action: 'list_foods' });
    ok(r.count === 2, 'list_foods');
    r = await me({ action: 'today' });
    ok(r.food.length === 3 && r.carbs_g > 0, 'today shows entries and macros');
    r = await me({ action: 'report' });
    ok(/תשלח|נשארו|אכלת/.test(r.report) && !/תשלחי|שימי/.test(r.report), 'report wording is masculine');

    r = await her({ action: 'get_profile' });
    ok(r.status === 'needs_onboarding', "guest has no profile — owner's data didn't leak into hers");
    ok(!guestTools.track_nutrition.parameters.properties.action.enum.includes('save_food'), 'guest surface unchanged');
    r = await me({ action: 'delete_food', name: 'כריך טונה ארומה' });
    ok(r.status === 'success', 'delete_food');

    const probe = `const {toolRegistry}=require('./dist/registry/index.js');const m=Object.keys(require.cache).filter(p=>p.includes('/dist/')).map(p=>p.split('/dist/')[1]).sort();process.stdout.write('@@'+JSON.stringify({t:Object.keys(toolRegistry),m}));`;
    const g = JSON.parse(String(execFileSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), env: { ...process.env, ASTRA_PROFILE: 'guest' }, stdio: ['ignore', 'pipe', 'ignore'] })).split('@@').pop());
    ok(JSON.stringify(g.t) === '["track_nutrition"]' && JSON.stringify(g.m) === '["config.js","nutrition-store.js","nutrition.js","registry/guest-tools.js","registry/index.js"]', 'guest process still loads only its 5 modules', g);

    console.log(`\n${pass} passed, ${fail} failed`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
