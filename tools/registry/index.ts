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

export const toolRegistry: Record<string, Tool> = {
    ...megaTools,
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
