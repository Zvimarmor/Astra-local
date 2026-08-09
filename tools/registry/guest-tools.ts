import { nutritionTools } from '../nutrition';

/**
 * Guest tool surface — everything a non-owner session is allowed to reach.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  THE ISOLATION RULE                                               │
 * │                                                                    │
 * │  This file must NEVER import ../registry/mega-tools, ../storage,   │
 * │  or any owner domain module (tasks, calendar, expenses, notes,     │
 * │  email, spotify, private/*). The guest MCP process is spawned with │
 * │  ASTRA_PROFILE=guest and registry/index.ts then builds its tool    │
 * │  map from THIS object alone — so the owner's tools are not merely  │
 * │  hidden from the model, they are never constructed in that process │
 * │  at all, and `tools/private/` (which carries run_claude_code) is   │
 * │  never even loaded.                                                │
 * │                                                                    │
 * │  Anything added here is visible to the guest. Add deliberately.    │
 * └──────────────────────────────────────────────────────────────────┘
 */

type DomainTool = { execute: (args: any) => Promise<Record<string, any>> };
type DomainMap = Record<string, DomainTool>;

async function call(map: DomainMap, name: string, args: Record<string, any>): Promise<Record<string, any>> {
    const tool = map[name];
    if (!tool) return { status: 'error', error: `Internal routing error: ${name} not found` };
    return tool.execute(args);
}

function badAction(action: string, valid: string[]): Record<string, any> {
    return { status: 'error', error: `Unknown action "${action}". Valid actions: ${valid.join(', ')}.` };
}

const ACTIONS = [
    'get_profile', 'set_profile', 'log_food', 'log_activity',
    'today', 'report', 'history', 'log_weight', 'delete_entry',
];

export const guestTools = {
    track_nutrition: {
        name: 'track_nutrition',
        description:
            'Track daily calories in/out and macros. Choose action: ' +
            "'get_profile' (returns status=\"needs_onboarding\" until the body profile exists — ask for the details first), " +
            "'set_profile' (needs sex, height_cm, weight_kg, age; optional activity_level, goal, goal_rate_kg_week), " +
            "'log_food' (needs description + calories; also pass protein_g, carbs_g, fat_g and meal — YOU estimate them), " +
            "'log_activity' (needs description + calories_burned; optional minutes — YOU estimate the burn), " +
            "'today' (current budget: target, eaten, burned, remaining), " +
            "'report' (full end-of-day Hebrew summary, pre-formatted), " +
            "'history' (optional days, default 7), " +
            "'log_weight' (needs weight_kg), " +
            "'delete_entry' (needs kind food|activity; optional entry_id — omit to remove the most recent). " +
            'Calories burned in a workout are ADDED to the day\'s allowance. All dates are YYYY-MM-DD and default to today.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ACTIONS, description: 'Which nutrition operation to perform' },
                sex: { type: 'string', enum: ['female', 'male'], description: 'For set_profile' },
                height_cm: { type: 'number', description: 'Height in cm (set_profile)' },
                weight_kg: { type: 'number', description: 'Weight in kg (set_profile / log_weight)' },
                age: { type: 'number', description: 'Age in years (set_profile)' },
                activity_level: {
                    type: 'string',
                    enum: ['sedentary', 'light', 'moderate', 'active', 'very_active'],
                    description: 'NON-exercise daily movement only — workouts are logged separately and added on top. Default sedentary.',
                },
                goal: { type: 'string', enum: ['maintain', 'lose', 'gain'], description: 'Weight goal (set_profile)' },
                goal_rate_kg_week: { type: 'number', description: 'Desired kg per week for lose/gain (default 0.25, capped at 1)' },
                description: { type: 'string', description: 'What she ate, or what activity she did' },
                calories: { type: 'number', description: 'Your estimate of the calories in the food (log_food)' },
                protein_g: { type: 'number', description: 'Estimated protein in grams (log_food)' },
                carbs_g: { type: 'number', description: 'Estimated carbs in grams (log_food)' },
                fat_g: { type: 'number', description: 'Estimated fat in grams (log_food)' },
                meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'], description: 'Which meal (log_food)' },
                calories_burned: { type: 'number', description: 'Your estimate of the calories burned (log_activity)' },
                minutes: { type: 'number', description: 'How long the activity lasted (log_activity)' },
                days: { type: 'number', description: 'How many days back (history, default 7)' },
                kind: { type: 'string', enum: ['food', 'activity'], description: 'Which log to remove from (delete_entry)' },
                entry_id: { type: 'number', description: 'Entry id to remove; omit for the most recent (delete_entry)' },
                date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
            },
            required: ['action'],
        },
        execute: async (a: any = {}) => {
            const t = nutritionTools as unknown as DomainMap;
            switch (a.action) {
                case 'get_profile': return call(t, 'get_nutrition_profile', {});
                case 'set_profile': return call(t, 'set_nutrition_profile', {
                    sex: a.sex, height_cm: a.height_cm, weight_kg: a.weight_kg, age: a.age,
                    activity_level: a.activity_level, goal: a.goal, goal_rate_kg_week: a.goal_rate_kg_week,
                });
                case 'log_food': return call(t, 'log_food_entry', {
                    description: a.description, calories: a.calories, protein_g: a.protein_g,
                    carbs_g: a.carbs_g, fat_g: a.fat_g, meal: a.meal, date: a.date,
                });
                case 'log_activity': return call(t, 'log_activity_entry', {
                    description: a.description, calories_burned: a.calories_burned, minutes: a.minutes, date: a.date,
                });
                case 'today': return call(t, 'nutrition_today', { date: a.date });
                case 'report': return call(t, 'nutrition_report', { date: a.date });
                case 'history': return call(t, 'nutrition_history', { days: a.days });
                case 'log_weight': return call(t, 'log_weight_entry', { weight_kg: a.weight_kg, date: a.date });
                case 'delete_entry': return call(t, 'delete_nutrition_entry', { kind: a.kind, entry_id: a.entry_id, date: a.date });
                default: return badAction(a.action, ACTIONS);
            }
        },
    },
};
