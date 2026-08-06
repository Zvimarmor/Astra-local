import { megaTools } from './mega-tools';

/**
 * Tool Registry — OpenClaw Integration
 *
 * Exposes the consolidated 8 "mega-tools" (see ./mega-tools.ts) to the MCP
 * server. The 34 underlying domain tools (tasks.ts, expenses.ts, immich.ts, …)
 * are still the implementation — the mega-tools route to them — but only the 8
 * action-dispatched schemas are advertised to the model. This keeps the system
 * prompt small enough for the local 8B model to parse and call reliably.
 *
 * To roll back to the flat 34-tool surface, restore the previous version of
 * this file from git (it spread every `<domain>Tools` object directly).
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

export const toolRegistry: Record<string, Tool> = {
    ...megaTools,
    ...loadPrivateTools(),
};

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
