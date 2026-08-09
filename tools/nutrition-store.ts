import Database from 'better-sqlite3';
import { config } from './config';

/**
 * Nutrition store — calorie & macro tracking for a GUEST user.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHY THIS IS NOT IN storage.ts                                    │
 * │                                                                    │
 * │  This module is the ONLY storage the guest tool profile imports    │
 * │  (see registry/guest-tools.ts). storage.ts opens the owner's whole │
 * │  world — tasks, expenses, budgets, schedules — and seeds rows on   │
 * │  import. Keeping nutrition on its own connection means the guest   │
 * │  MCP process never loads that module at all, so there is no code   │
 * │  path from her session to the owner's data even if the gateway's   │
 * │  tool policy were misconfigured. The isolation is structural, not  │
 * │  a policy string.                                                  │
 * │                                                                    │
 * │  Same file (data/memory.db), separate handle. SQLite in WAL mode   │
 * │  handles concurrent readers/writers across handles and processes,  │
 * │  which this DB already relies on (scheduler + MCP + dashboard).    │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Every table is keyed by `user_id` so a second tracked person costs nothing.
 */

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS nutrition_profile (
        user_id TEXT PRIMARY KEY,
        sex TEXT NOT NULL,
        height_cm REAL NOT NULL,
        weight_kg REAL NOT NULL,
        age INTEGER NOT NULL,
        activity_level TEXT NOT NULL DEFAULT 'sedentary',
        goal TEXT NOT NULL DEFAULT 'maintain',
        goal_rate_kg_week REAL NOT NULL DEFAULT 0,
        target_override REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nutrition_food (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        meal TEXT,
        description TEXT NOT NULL,
        calories REAL NOT NULL,
        protein_g REAL NOT NULL DEFAULT 0,
        carbs_g REAL NOT NULL DEFAULT 0,
        fat_g REAL NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nutrition_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        minutes REAL,
        calories_burned REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nutrition_weight (
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        weight_kg REAL NOT NULL,
        PRIMARY KEY (user_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_nutrition_food_day ON nutrition_food(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_nutrition_activity_day ON nutrition_activity(user_id, date);
`);

// ─── Types ────────────────────────────────────────────────────────────

export type Sex = 'female' | 'male';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type Goal = 'maintain' | 'lose' | 'gain';

export interface NutritionProfile {
    user_id: string;
    sex: Sex;
    height_cm: number;
    weight_kg: number;
    age: number;
    activity_level: ActivityLevel;
    goal: Goal;
    goal_rate_kg_week: number;
    target_override: number | null;
}

export interface DerivedTargets {
    bmr: number;
    /** Baseline burn from BMR × activity factor, EXCLUDING logged workouts. */
    base_tdee: number;
    /** Calorie delta applied for the goal (negative = deficit). */
    goal_adjustment: number;
    /** base_tdee + goal_adjustment, floored for safety. Workouts are added on top per-day. */
    daily_target: number;
    /** True when the safety floor raised daily_target above the requested figure. */
    floored: boolean;
}

export interface FoodEntry {
    id: number; date: string; meal: string | null; description: string;
    calories: number; protein_g: number; carbs_g: number; fat_g: number;
}

export interface ActivityEntry {
    id: number; date: string; description: string; minutes: number | null; calories_burned: number;
}

export interface DayTotals {
    date: string;
    eaten: number;
    burned_exercise: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    food_count: number;
    activity_count: number;
}

export interface DayStatus {
    date: string;
    profile: NutritionProfile;
    targets: DerivedTargets;
    totals: DayTotals;
    /** daily_target + exercise burned − eaten. Negative = over budget. */
    remaining: number;
    /** Total burn for the day = base_tdee + exercise. */
    total_burn: number;
}

// ─── Calorie maths ────────────────────────────────────────────────────

/**
 * Activity multipliers applied to BMR.
 *
 * IMPORTANT: because she logs workouts explicitly and we ADD those calories to
 * the day's allowance, this multiplier must describe only NON-exercise daily
 * movement (walking, standing, chores). Picking "active" here as well would
 * double-count every workout. Default is `sedentary` for that reason, and the
 * skill tells the agent to explain the choice in those terms.
 */
const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
};

/** ~7700 kcal per kg of body mass — the standard planning figure. */
const KCAL_PER_KG = 7700;

/**
 * Safety floor on the daily target. Very low intake is a medical matter, not
 * something an assistant should quietly recommend, so an aggressive goal rate
 * gets clamped here and the clamp is reported (never silent).
 */
const MIN_TARGET: Record<Sex, number> = { female: 1200, male: 1500 };

/** Mifflin-St Jeor basal metabolic rate. */
export function calcBMR(sex: Sex, weightKg: number, heightCm: number, age: number): number {
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    return sex === 'male' ? base + 5 : base - 161;
}

export function deriveTargets(p: NutritionProfile): DerivedTargets {
    const bmr = calcBMR(p.sex, p.weight_kg, p.height_cm, p.age);
    const base_tdee = bmr * (ACTIVITY_FACTORS[p.activity_level] ?? 1.2);

    let goal_adjustment = 0;
    if (p.goal === 'lose') goal_adjustment = -(p.goal_rate_kg_week * KCAL_PER_KG) / 7;
    if (p.goal === 'gain') goal_adjustment = (p.goal_rate_kg_week * KCAL_PER_KG) / 7;

    let daily_target = p.target_override ?? base_tdee + goal_adjustment;
    const floor = MIN_TARGET[p.sex] ?? 1200;
    const floored = daily_target < floor;
    if (floored) daily_target = floor;

    return {
        bmr: Math.round(bmr),
        base_tdee: Math.round(base_tdee),
        goal_adjustment: Math.round(goal_adjustment),
        daily_target: Math.round(daily_target),
        floored,
    };
}

// ─── Dates (always in the configured timezone, never the process TZ) ──

export function todayStr(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
}

export function localHour(): number {
    return parseInt(new Date().toLocaleTimeString('en-GB', {
        timeZone: config.timezone, hour12: false, hour: '2-digit',
    }), 10);
}

export function daysAgoStr(days: number): string {
    const d = new Date(Date.now() - days * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: config.timezone });
}

// ─── Profile ──────────────────────────────────────────────────────────

export function getProfile(userId: string): NutritionProfile | null {
    return (db.prepare('SELECT * FROM nutrition_profile WHERE user_id = ?').get(userId) as NutritionProfile) || null;
}

export function upsertProfile(userId: string, p: Omit<NutritionProfile, 'user_id'>): NutritionProfile {
    db.prepare(`
        INSERT INTO nutrition_profile (user_id, sex, height_cm, weight_kg, age, activity_level, goal, goal_rate_kg_week, target_override)
        VALUES (@user_id, @sex, @height_cm, @weight_kg, @age, @activity_level, @goal, @goal_rate_kg_week, @target_override)
        ON CONFLICT(user_id) DO UPDATE SET
            sex = excluded.sex, height_cm = excluded.height_cm, weight_kg = excluded.weight_kg,
            age = excluded.age, activity_level = excluded.activity_level, goal = excluded.goal,
            goal_rate_kg_week = excluded.goal_rate_kg_week, target_override = excluded.target_override,
            updated_at = CURRENT_TIMESTAMP
    `).run({ user_id: userId, ...p });
    // A profile write is also a weigh-in — keeps the weight trend honest.
    logWeight(userId, p.weight_kg);
    return getProfile(userId)!;
}

export function logWeight(userId: string, weightKg: number, date?: string): void {
    const d = date || todayStr();
    db.prepare('INSERT INTO nutrition_weight (user_id, date, weight_kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg = excluded.weight_kg')
        .run(userId, d, weightKg);
    db.prepare('UPDATE nutrition_profile SET weight_kg = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
        .run(weightKg, userId);
}

export function getWeightTrend(userId: string, days: number = 30): { date: string; weight_kg: number }[] {
    return db.prepare('SELECT date, weight_kg FROM nutrition_weight WHERE user_id = ? AND date >= ? ORDER BY date')
        .all(userId, daysAgoStr(days)) as { date: string; weight_kg: number }[];
}

// ─── Logging ──────────────────────────────────────────────────────────

export function logFood(
    userId: string,
    e: { description: string; calories: number; protein_g?: number; carbs_g?: number; fat_g?: number; meal?: string; date?: string },
): number {
    const info = db.prepare(`
        INSERT INTO nutrition_food (user_id, date, meal, description, calories, protein_g, carbs_g, fat_g)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, e.date || todayStr(), e.meal || null, e.description, e.calories,
        e.protein_g || 0, e.carbs_g || 0, e.fat_g || 0);
    return Number(info.lastInsertRowid);
}

export function logActivity(
    userId: string,
    e: { description: string; calories_burned: number; minutes?: number; date?: string },
): number {
    const info = db.prepare(`
        INSERT INTO nutrition_activity (user_id, date, description, minutes, calories_burned)
        VALUES (?, ?, ?, ?, ?)
    `).run(userId, e.date || todayStr(), e.description, e.minutes ?? null, e.calories_burned);
    return Number(info.lastInsertRowid);
}

export function getFood(userId: string, date: string): FoodEntry[] {
    return db.prepare('SELECT id, date, meal, description, calories, protein_g, carbs_g, fat_g FROM nutrition_food WHERE user_id = ? AND date = ? ORDER BY id')
        .all(userId, date) as FoodEntry[];
}

export function getActivity(userId: string, date: string): ActivityEntry[] {
    return db.prepare('SELECT id, date, description, minutes, calories_burned FROM nutrition_activity WHERE user_id = ? AND date = ? ORDER BY id')
        .all(userId, date) as ActivityEntry[];
}

/** Delete one entry. `kind` guards against an id from the wrong table. */
export function deleteEntry(userId: string, kind: 'food' | 'activity', id: number): boolean {
    const table = kind === 'food' ? 'nutrition_food' : 'nutrition_activity';
    return db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`).run(userId, id).changes > 0;
}

/** Delete the most recent entry of a kind on a date — "no wait, scratch that". */
export function deleteLast(userId: string, kind: 'food' | 'activity', date: string): FoodEntry | ActivityEntry | null {
    const table = kind === 'food' ? 'nutrition_food' : 'nutrition_activity';
    const row = db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1`)
        .get(userId, date) as any;
    if (!row) return null;
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    return row;
}

// ─── Aggregation ──────────────────────────────────────────────────────

export function getDayTotals(userId: string, date: string): DayTotals {
    const f = db.prepare(`
        SELECT COALESCE(SUM(calories), 0) AS eaten, COALESCE(SUM(protein_g), 0) AS protein_g,
               COALESCE(SUM(carbs_g), 0) AS carbs_g, COALESCE(SUM(fat_g), 0) AS fat_g,
               COUNT(*) AS food_count
        FROM nutrition_food WHERE user_id = ? AND date = ?
    `).get(userId, date) as any;
    const a = db.prepare(`
        SELECT COALESCE(SUM(calories_burned), 0) AS burned, COUNT(*) AS activity_count
        FROM nutrition_activity WHERE user_id = ? AND date = ?
    `).get(userId, date) as any;

    return {
        date,
        eaten: Math.round(f.eaten),
        burned_exercise: Math.round(a.burned),
        protein_g: Math.round(f.protein_g),
        carbs_g: Math.round(f.carbs_g),
        fat_g: Math.round(f.fat_g),
        food_count: f.food_count,
        activity_count: a.activity_count,
    };
}

/**
 * The single source of truth for "how many calories does she have left".
 *
 * remaining = daily_target + exercise burned today − eaten today
 *
 * Exercise is added rather than baked into the multiplier — see ACTIVITY_FACTORS.
 * Returns null when there is no profile yet (the caller must onboard first).
 */
export function getDayStatus(userId: string, date?: string): DayStatus | null {
    const profile = getProfile(userId);
    if (!profile) return null;
    const d = date || todayStr();
    const targets = deriveTargets(profile);
    const totals = getDayTotals(userId, d);
    return {
        date: d,
        profile,
        targets,
        totals,
        remaining: Math.round(targets.daily_target + totals.burned_exercise - totals.eaten),
        total_burn: Math.round(targets.base_tdee + totals.burned_exercise),
    };
}

export function getHistory(userId: string, days: number = 7): (DayTotals & { remaining: number })[] {
    const profile = getProfile(userId);
    if (!profile) return [];
    const target = deriveTargets(profile).daily_target;
    const out: (DayTotals & { remaining: number })[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = daysAgoStr(i);
        const t = getDayTotals(userId, d);
        if (t.food_count === 0 && t.activity_count === 0) continue;
        out.push({ ...t, remaining: Math.round(target + t.burned_exercise - t.eaten) });
    }
    return out;
}

// ─── Hebrew report builders (deterministic — no LLM) ──────────────────
//
// These live here, not in the scheduler, so the 21:00 job and the chat tool
// produce the SAME text. The scheduler require()s the compiled dist copy.

const HE_MEALS: Record<string, string> = {
    breakfast: 'ארוחת בוקר', lunch: 'ארוחת צהריים', dinner: 'ארוחת ערב', snack: 'נשנוש',
};

function macroLine(t: DayTotals): string {
    // Percent of calories from each macro (4/4/9 kcal per gram).
    const kcal = t.protein_g * 4 + t.carbs_g * 4 + t.fat_g * 9;
    const pct = (g: number, k: number) => (kcal > 0 ? ` (${Math.round((g * k * 100) / kcal)}%)` : '');
    return `🥩 חלבון: ${t.protein_g} ג׳${pct(t.protein_g, 4)}\n` +
        `🍞 פחמימות: ${t.carbs_g} ג׳${pct(t.carbs_g, 4)}\n` +
        `🥑 שומן: ${t.fat_g} ג׳${pct(t.fat_g, 9)}`;
}

/** The end-of-day summary. Returns null if there is no profile yet. */
export function buildDailyReportHe(userId: string, date?: string): string | null {
    const s = getDayStatus(userId, date);
    if (!s) return null;
    const { totals: t, targets } = s;

    const lines: string[] = [`📊 *סיכום יומי — ${s.date}*`, ''];

    if (t.food_count === 0 && t.activity_count === 0) {
        lines.push('לא רשמת היום כלום 🤷‍♀️', '', `היעד היומי שלך הוא ${targets.daily_target} קלוריות.`,
            'מחר נתחיל מחדש — פשוט תשלחי לי מה אכלת ומה עשית.');
        return lines.join('\n');
    }

    lines.push(
        `🔥 שרפת: ${s.total_burn} קלוריות`,
        `   • חילוף חומרים בסיסי: ${targets.base_tdee}`,
        `   • אימונים ופעילות: ${t.burned_exercise}`,
        '',
        `🍽️ אכלת: ${t.eaten} קלוריות`,
        `🎯 היעד היומי: ${targets.daily_target} קלוריות (+ מה ששרפת באימון)`,
        '',
        macroLine(t),
        '',
    );

    if (s.remaining > 0) {
        lines.push(`✅ נשארו לך ${s.remaining} קלוריות מתחת ליעד.`);
    } else if (s.remaining === 0) {
        lines.push('🎯 בדיוק על היעד. מושלם!');
    } else {
        lines.push(`⚠️ עברת את היעד ב-${Math.abs(s.remaining)} קלוריות.`);
    }

    const food = getFood(userId, s.date);
    if (food.length) {
        lines.push('', '*מה שאכלת:*');
        for (const f of food) {
            const meal = f.meal ? `${HE_MEALS[f.meal] || f.meal}: ` : '';
            lines.push(`• ${meal}${f.description} — ${Math.round(f.calories)} קק״ל`);
        }
    }

    const acts = getActivity(userId, s.date);
    if (acts.length) {
        lines.push('', '*פעילות:*');
        for (const a of acts) {
            const mins = a.minutes ? ` (${Math.round(a.minutes)} דק׳)` : '';
            lines.push(`• ${a.description}${mins} — ${Math.round(a.calories_burned)} קק״ל`);
        }
    }

    return lines.join('\n');
}

/**
 * The 18:00 nudge. Deliberately returns null unless there is something worth
 * saying, so a quiet day stays quiet (same "silent unless it matters" contract
 * as budget_check / email_digest).
 */
export function buildEveningNudgeHe(userId: string, thresholdKcal: number = 700): string | null {
    const s = getDayStatus(userId);
    if (!s) return null;
    if (s.remaining <= thresholdKcal) return null;

    const lines = [
        `🌇 *עדכון ערב*`,
        '',
        `נשארו לך עוד *${s.remaining} קלוריות* להיום.`,
    ];
    if (s.totals.food_count === 0) {
        lines.push('', 'עוד לא רשמת שום דבר היום — שכחת, או שבאמת עוד לא אכלת?');
    } else {
        lines.push('', 'זה די הרבה — כדאי לאכול ארוחת ערב נורמלית ולא ללכת לישון ברעב 🙂');
        if (s.totals.protein_g < 60) {
            lines.push(`שווה לכוון לחלבון: עד עכשיו ${s.totals.protein_g} ג׳ בלבד.`);
        }
    }
    return lines.join('\n');
}

/**
 * Live warning after a food entry — "your calories are about to run out".
 * Returned as a field on log_food so it reaches her in the same reply, with no
 * scheduler round-trip. Null when there is nothing to warn about.
 */
export function buildIntakeWarningHe(s: DayStatus, lowThreshold: number = 200): string | null {
    if (s.remaining < 0) {
        return `⚠️ עברת את היעד היומי ב-${Math.abs(s.remaining)} קלוריות.`;
    }
    if (s.remaining <= lowThreshold) {
        return `⏳ נשארו לך רק ${s.remaining} קלוריות להיום — שימי לב למה שאת אוכלת מכאן.`;
    }
    return null;
}
