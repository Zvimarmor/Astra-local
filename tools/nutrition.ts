import * as store from './nutrition-store';

/**
 * Nutrition tools — the guest profile's only capability.
 *
 * Calorie and macro figures are NOT looked up in a food database; the model
 * estimates them from the free-text description and passes them in. That is a
 * deliberate trade-off: it handles "חצי פיתה עם חומוס וסלט" and homemade food,
 * which no lookup table does, at the cost of being an estimate. The skill tells
 * the agent to say so, and every entry is editable/deletable afterwards.
 *
 * Exposed to the model as the single `track_nutrition` mega-tool — see
 * registry/guest-tools.ts.
 */

/** Guest user id. Every row is scoped by this, so a second person costs nothing. */
export const GUEST_USER = 'gf';

const SEXES = ['female', 'male'];
const LEVELS = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
const GOALS = ['maintain', 'lose', 'gain'];

function num(v: any): number | null {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Compact status block returned by most actions, so the model always knows the budget. */
function statusPayload(s: store.DayStatus) {
    return {
        date: s.date,
        daily_target: s.targets.daily_target,
        base_burn: s.targets.base_tdee,
        burned_exercise: s.totals.burned_exercise,
        total_burn: s.total_burn,
        eaten: s.totals.eaten,
        remaining: s.remaining,
        protein_g: s.totals.protein_g,
        carbs_g: s.totals.carbs_g,
        fat_g: s.totals.fat_g,
    };
}

const NEEDS_ONBOARDING = {
    status: 'needs_onboarding',
    message:
        'No profile yet. Ask her — in Hebrew — for height (cm), weight (kg), age, and whether ' +
        'she wants to lose / maintain / gain, then call action="set_profile". ' +
        'Do not log food or activity before the profile exists.',
    required: ['sex', 'height_cm', 'weight_kg', 'age'],
};

export const nutritionTools = {
    get_nutrition_profile: {
        name: 'get_nutrition_profile',
        description: 'Get the stored body profile and the derived calorie targets.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const p = store.getProfile(GUEST_USER);
                if (!p) return NEEDS_ONBOARDING;
                const t = store.deriveTargets(p);
                return {
                    status: 'success',
                    profile: {
                        sex: p.sex, height_cm: p.height_cm, weight_kg: p.weight_kg, age: p.age,
                        activity_level: p.activity_level, goal: p.goal, goal_rate_kg_week: p.goal_rate_kg_week,
                    },
                    targets: t,
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    set_nutrition_profile: {
        name: 'set_nutrition_profile',
        description: 'Create or update the body profile and recompute BMR / TDEE / daily target.',
        parameters: {
            type: 'object',
            properties: {
                sex: { type: 'string', enum: SEXES },
                height_cm: { type: 'number' },
                weight_kg: { type: 'number' },
                age: { type: 'number' },
                activity_level: { type: 'string', enum: LEVELS },
                goal: { type: 'string', enum: GOALS },
                goal_rate_kg_week: { type: 'number' },
                target_override: { type: 'number' },
            },
            required: ['sex', 'height_cm', 'weight_kg', 'age'],
        },
        execute: async (a: any = {}) => {
            try {
                const existing = store.getProfile(GUEST_USER);
                const sex = String(a.sex || existing?.sex || '').toLowerCase();
                if (!SEXES.includes(sex)) {
                    return { status: 'error', error: `sex must be one of: ${SEXES.join(', ')}` };
                }

                const height = num(a.height_cm) ?? existing?.height_cm ?? null;
                const weight = num(a.weight_kg) ?? existing?.weight_kg ?? null;
                const age = num(a.age) ?? existing?.age ?? null;
                if (height === null || weight === null || age === null) {
                    return { status: 'error', error: 'height_cm, weight_kg and age are all required the first time.' };
                }
                // Reject physically implausible input rather than computing a nonsense
                // target off a typo (e.g. 17 cm, or kg and cm swapped).
                if (height < 100 || height > 250) return { status: 'error', error: `height_cm ${height} is out of range (100–250). Re-ask.` };
                if (weight < 30 || weight > 300) return { status: 'error', error: `weight_kg ${weight} is out of range (30–300). Re-ask.` };
                if (age < 13 || age > 120) return { status: 'error', error: `age ${age} is out of range (13–120). Re-ask.` };

                const goal = String(a.goal || existing?.goal || 'maintain').toLowerCase();
                if (!GOALS.includes(goal)) return { status: 'error', error: `goal must be one of: ${GOALS.join(', ')}` };

                const level = String(a.activity_level || existing?.activity_level || 'sedentary').toLowerCase();
                if (!LEVELS.includes(level)) return { status: 'error', error: `activity_level must be one of: ${LEVELS.join(', ')}` };

                // A rate only means anything for lose/gain, and >1 kg/week is not a
                // target an assistant should hand out — clamp and say so.
                //
                // Default is 0.25 kg/week (~275 kcal/day), not the more familiar 0.5.
                // For a smaller sedentary person 0.5 puts the target UNDER the safety
                // floor — a 62 kg / 165 cm woman computes to 1082 kcal — so 0.5 as a
                // default would mean the floor fired on nearly every new profile. A
                // gentler default lands above the floor and workout calories are added
                // on top anyway; she can still ask for 0.5 explicitly.
                let rate = num(a.goal_rate_kg_week) ?? existing?.goal_rate_kg_week ?? 0;
                if (goal === 'maintain') rate = 0;
                else if (rate <= 0) rate = 0.25;
                const rateClamped = rate > 1;
                if (rateClamped) rate = 1;

                const p = store.upsertProfile(GUEST_USER, {
                    sex: sex as store.Sex,
                    height_cm: height,
                    weight_kg: weight,
                    age: Math.round(age),
                    activity_level: level as store.ActivityLevel,
                    goal: goal as store.Goal,
                    goal_rate_kg_week: rate,
                    target_override: num(a.target_override),
                });
                const t = store.deriveTargets(p);

                const notes: string[] = [];
                if (rateClamped) notes.push('Requested rate was above 1 kg/week and was capped at 1 kg/week.');
                if (t.floored) notes.push(`Target hit the ${p.sex === 'male' ? 1500 : 1200} kcal safety floor — tell her the goal was eased, and that a faster loss needs a dietitian, not an app.`);

                return {
                    status: 'success',
                    message: `Profile saved. BMR ${t.bmr}, base burn ${t.base_tdee}, daily target ${t.daily_target} kcal.`,
                    targets: t,
                    notes: notes.length ? notes : undefined,
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    log_food_entry: {
        name: 'log_food_entry',
        description: 'Record something she ate, with your best calorie and macro estimate.',
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string' },
                calories: { type: 'number' },
                protein_g: { type: 'number' },
                carbs_g: { type: 'number' },
                fat_g: { type: 'number' },
                meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
                date: { type: 'string' },
            },
            required: ['description', 'calories'],
        },
        execute: async (a: any = {}) => {
            try {
                if (!store.getProfile(GUEST_USER)) return NEEDS_ONBOARDING;
                const desc = String(a.description || '').trim();
                const cal = num(a.calories);
                if (!desc) return { status: 'error', error: 'description is required.' };
                if (cal === null || cal < 0) return { status: 'error', error: 'calories must be a non-negative number.' };

                const id = store.logFood(GUEST_USER, {
                    description: desc,
                    calories: cal,
                    protein_g: num(a.protein_g) ?? 0,
                    carbs_g: num(a.carbs_g) ?? 0,
                    fat_g: num(a.fat_g) ?? 0,
                    meal: a.meal,
                    date: a.date,
                });

                const s = store.getDayStatus(GUEST_USER, a.date)!;
                return {
                    status: 'success',
                    entry_id: id,
                    message: `Logged "${desc}" — ${Math.round(cal)} kcal.`,
                    ...statusPayload(s),
                    // Present only when it matters. The skill requires relaying it.
                    warning: store.buildIntakeWarningHe(s) || undefined,
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    log_activity_entry: {
        name: 'log_activity_entry',
        description: 'Record a workout or physical activity, with your best estimate of calories burned.',
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string' },
                calories_burned: { type: 'number' },
                minutes: { type: 'number' },
                date: { type: 'string' },
            },
            required: ['description', 'calories_burned'],
        },
        execute: async (a: any = {}) => {
            try {
                if (!store.getProfile(GUEST_USER)) return NEEDS_ONBOARDING;
                const desc = String(a.description || '').trim();
                const burned = num(a.calories_burned);
                if (!desc) return { status: 'error', error: 'description is required.' };
                if (burned === null || burned < 0) return { status: 'error', error: 'calories_burned must be a non-negative number.' };

                const id = store.logActivity(GUEST_USER, {
                    description: desc,
                    calories_burned: burned,
                    minutes: num(a.minutes) ?? undefined,
                    date: a.date,
                });

                const s = store.getDayStatus(GUEST_USER, a.date)!;
                return {
                    status: 'success',
                    entry_id: id,
                    message: `Logged "${desc}" — ${Math.round(burned)} kcal burned. That much is added to today's allowance.`,
                    ...statusPayload(s),
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    nutrition_today: {
        name: 'nutrition_today',
        description: "Current calorie budget: target, eaten, burned, and what's left.",
        parameters: { type: 'object', properties: { date: { type: 'string' } } },
        execute: async (a: any = {}) => {
            try {
                const s = store.getDayStatus(GUEST_USER, a.date);
                if (!s) return NEEDS_ONBOARDING;
                return {
                    status: 'success',
                    ...statusPayload(s),
                    food: store.getFood(GUEST_USER, s.date),
                    activity: store.getActivity(GUEST_USER, s.date),
                    warning: store.buildIntakeWarningHe(s) || undefined,
                };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    nutrition_report: {
        name: 'nutrition_report',
        description: 'The full end-of-day Hebrew summary — identical to the 21:00 automatic report.',
        parameters: { type: 'object', properties: { date: { type: 'string' } } },
        execute: async (a: any = {}) => {
            try {
                const report = store.buildDailyReportHe(GUEST_USER, a.date);
                if (!report) return NEEDS_ONBOARDING;
                // Pre-formatted Hebrew: the skill tells the model to send it as-is.
                return { status: 'success', report, send_verbatim: true };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    nutrition_history: {
        name: 'nutrition_history',
        description: 'Per-day totals for the last N days (default 7). Days with nothing logged are omitted.',
        parameters: { type: 'object', properties: { days: { type: 'number' } } },
        execute: async (a: any = {}) => {
            try {
                if (!store.getProfile(GUEST_USER)) return NEEDS_ONBOARDING;
                const days = Math.min(Math.max(Math.round(num(a.days) ?? 7), 1), 90);
                const history = store.getHistory(GUEST_USER, days);
                const weights = store.getWeightTrend(GUEST_USER, days);
                const avg = history.length
                    ? Math.round(history.reduce((s, d) => s + d.eaten, 0) / history.length)
                    : 0;
                return { status: 'success', days, logged_days: history.length, avg_eaten: avg, history, weights };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    log_weight_entry: {
        name: 'log_weight_entry',
        description: 'Record a weigh-in. Also updates the profile weight and recomputes the targets.',
        parameters: {
            type: 'object',
            properties: { weight_kg: { type: 'number' }, date: { type: 'string' } },
            required: ['weight_kg'],
        },
        execute: async (a: any = {}) => {
            try {
                const p = store.getProfile(GUEST_USER);
                if (!p) return NEEDS_ONBOARDING;
                const w = num(a.weight_kg);
                if (w === null || w < 30 || w > 300) return { status: 'error', error: 'weight_kg must be between 30 and 300.' };
                store.logWeight(GUEST_USER, w, a.date);
                const t = store.deriveTargets(store.getProfile(GUEST_USER)!);
                return { status: 'success', message: `Weight ${w} kg recorded.`, targets: t };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },

    delete_nutrition_entry: {
        name: 'delete_nutrition_entry',
        description: 'Remove a food or activity entry — by id, or the most recent one when no id is given.',
        parameters: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['food', 'activity'] },
                entry_id: { type: 'number' },
                date: { type: 'string' },
            },
            required: ['kind'],
        },
        execute: async (a: any = {}) => {
            try {
                if (!store.getProfile(GUEST_USER)) return NEEDS_ONBOARDING;
                const kind = a.kind === 'activity' ? 'activity' : 'food';
                const date = a.date || store.todayStr();

                const id = num(a.entry_id);
                if (id !== null) {
                    if (!store.deleteEntry(GUEST_USER, kind, Math.round(id)))
                        return { status: 'error', error: `No ${kind} entry with id ${id}.` };
                } else {
                    const removed = store.deleteLast(GUEST_USER, kind, date);
                    if (!removed) return { status: 'error', error: `Nothing logged as ${kind} on ${date}.` };
                }

                const s = store.getDayStatus(GUEST_USER, date)!;
                return { status: 'success', message: `Removed the ${kind} entry.`, ...statusPayload(s) };
            } catch (err: any) {
                return { status: 'error', error: err.message };
            }
        },
    },
};
