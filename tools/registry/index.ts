/**
 * Tool Registry — OpenClaw Integration
 *
 * Exposes the consolidated "mega-tools" (see ./mega-tools.ts) to the MCP
 * server. The underlying domain tools (tasks.ts, expenses.ts, immich.ts, …)
 * are still the implementation — the mega-tools route to them — but only the
 * action-dispatched schemas are advertised to the model.
 *
 * ─── TWO PROFILES ────────────────────────────────────────────────────
 *
 * `ASTRA_PROFILE` selects which tool surface this process serves:
 *
 *   owner (default) — the full mega-tool set + optional tools/private/*
 *   guest           — ONLY ./guest-tools (nutrition tracking)
 *   household       — ONLY ./household-profile (the roommate's household tool)
 *   anything else   — no tools (fail closed)
 *
 * OpenClaw registers two MCP servers pointing at this same build, differing
 * only by that env var, and routes the guest's chat to an agent bound to the
 * guest server (see docs/GUEST-AGENT.md).
 *
 * The branch below uses require(), NOT a static import, and that is the whole
 * point: a static `import { megaTools }` would execute mega-tools.ts — and
 * through it storage.ts, tasks, calendar, expenses, notes — in EVERY process,
 * including the guest one. With require() inside the branch, the guest process
 * never loads a single owner module. The isolation is structural rather than a
 * policy string that can be mis-typed.
 *
 * To roll back to the flat tool surface, restore the previous version of this
 * file from git (it spread every `<domain>Tools` object directly).
 */

export interface Tool {
    name: string;
    description: string;
    parameters: any;
    execute: (args: any) => Promise<Record<string, any>>;
}

/**
 * Optional per-machine tools.
 *
 * `tools/private/` is gitignored, so deployments can carry local-only tools that
 * aren't part of the shared repo. Loaded with a guarded runtime require rather
 * than a static import for one reason: a fresh clone has no `tools/private/`, and
 * a static import would fail the build there. Absent directory = no extra tools,
 * no error.
 *
 * Spread OUTSIDE `megaTools` deliberately, so anything here stays out of the
 * `/tools` capability list that `buildHelp()` generates from the mega-tool set.
 * Each private module is expected to carry its own authorization check.
 */
function loadPrivateTools(): Record<string, Tool> {
    const modules = ['../private/index', '../private/claude-bridge'];
    const loaded: Record<string, Tool> = {};

    for (const spec of modules) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(spec);
            for (const value of Object.values(mod || {})) {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    for (const [name, tool] of Object.entries(value as Record<string, any>)) {
                        if (tool && typeof tool.execute === 'function') loaded[name] = tool as Tool;
                    }
                }
            }
        } catch (err: any) {
            // MODULE_NOT_FOUND is the normal case — stay quiet about it.
            if (err?.code !== 'MODULE_NOT_FOUND') {
                console.warn(`[Registry] ${spec} present but failed to load:`, err?.message);
            }
        }
    }

    if (Object.keys(loaded).length) {
        console.log('[Registry] Private tools loaded:', Object.keys(loaded).join(', '));
    }
    return loaded;
}

export type AstraProfile = 'owner' | 'guest' | 'household' | 'invalid';

/** Unset or "owner" → the owner profile. "guest" and "household" are the two isolated
 *  profiles. Any OTHER value fails closed (no tools at all): a typo in an isolated
 *  server's env must never fall through to the owner's tools. Start-up logs the choice. */
function resolveProfile(raw: string | undefined): AstraProfile {
    const v = String(raw || '').trim().toLowerCase();
    if (v === '' || v === 'owner') return 'owner';
    if (v === 'guest' || v === 'household') return v;
    return 'invalid';
}
export const astraProfile: AstraProfile = resolveProfile(process.env.ASTRA_PROFILE);

function buildRegistry(): Record<string, Tool> {
    if (astraProfile === 'invalid') {
        console.error(`[Registry] unknown ASTRA_PROFILE="${process.env.ASTRA_PROFILE}" — serving NO tools.`);
        return {};
    }
    if (astraProfile === 'household') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { householdProfileTools } = require('./household-profile');
        console.error('[Registry] profile=household — owner tools NOT loaded.');
        return { ...householdProfileTools };
    }
    if (astraProfile === 'guest') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { guestTools } = require('./guest-tools');
        console.error('[Registry] profile=guest — owner tools NOT loaded.');
        return { ...guestTools };
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { megaTools } = require('./mega-tools');
    return { ...megaTools, ...loadPrivateTools() };
}

export const toolRegistry: Record<string, Tool> = buildRegistry();

/**
 * Returns all tools as an array of OpenAI-compatible function declarations.
 */
export function getToolDeclarations() {
    const tools = Object.values(toolRegistry).map(t => ({
        type: "function" as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }
    }));
    console.log(`[Registry] Registered ${tools.length} mega-tools: ${tools.map(t => t.function.name).join(', ')}`);
    return tools;
}
