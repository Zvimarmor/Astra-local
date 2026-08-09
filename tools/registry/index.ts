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

export type AstraProfile = 'owner' | 'guest';

/** Anything not exactly "guest" is the owner profile — fail closed is not the
 *  right default here (a typo must not silently strip the owner's tools), but a
 *  typo in the GUEST direction must not silently GRANT them either, which is why
 *  the guest server pins the value explicitly and start-up logs what it chose. */
export const astraProfile: AstraProfile =
    String(process.env.ASTRA_PROFILE || '').trim().toLowerCase() === 'guest' ? 'guest' : 'owner';

function buildRegistry(): Record<string, Tool> {
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
