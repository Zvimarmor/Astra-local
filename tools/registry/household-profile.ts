import { makeHouseholdTool } from '../household-tools';

/**
 * Roommate tool surface (ASTRA_PROFILE=household) — the household tool acting as Michal,
 * and nothing else. Same isolation rule as guest-tools.ts: never import mega-tools,
 * storage, or any owner module from here. See docs/HOUSEHOLD.md.
 */
export const householdProfileTools = {
    manage_household: makeHouseholdTool('michal'),
};
