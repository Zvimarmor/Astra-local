/**
 * Central time limit for every MCP tool call (tools/mcp-server.ts).
 *
 * A tool that stalls (a dead socket, an API that never answers) must not hold the chat
 * turn open. After the limit the call returns a structured, readable error to the model
 * and the MCP server is free for the next call.
 *
 * JavaScript can't kill a running promise, so the stalled work keeps going in the
 * background until its own socket/HTTP timeouts end it. That's why every external call
 * in tools/ also carries its own timeout. This guard is the backstop that bounds what the
 * MCP client waits for.
 *
 * Imports nothing, so it's safe in every profile (owner, guest, household).
 */

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Per-tool limits. null = no guard (the tool enforces its own, longer limit). */
export const TOOL_TIMEOUT_OVERRIDES: Record<string, number | null> = {
    // digest = IMAP + Gmail API + one Gemini summary call (which alone may take up to 60s).
    manage_email: 90_000,
    // Runs Claude Code on this machine, with its own 10-minute timeout (tools/private).
    run_claude_code: null,
};

export function toolTimeoutMs(name: string): number | null {
    return Object.prototype.hasOwnProperty.call(TOOL_TIMEOUT_OVERRIDES, name)
        ? TOOL_TIMEOUT_OVERRIDES[name]
        : DEFAULT_TOOL_TIMEOUT_MS;
}

export interface TimedTool {
    name: string;
    execute: (args: any) => Promise<Record<string, any>>;
}

/**
 * Run a tool with its time limit. Never throws for a timeout: returns
 * `{ status: 'error', timed_out: true, error }` instead, so the model can tell the user.
 * Other exceptions propagate unchanged (the MCP layer reports them as isError).
 */
export async function executeWithTimeout(tool: TimedTool, args: any, limitMs: number | null = toolTimeoutMs(tool.name)): Promise<Record<string, any>> {
    if (!limitMs || limitMs <= 0) return tool.execute(args);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Record<string, any>>((resolve) => {
        timer = setTimeout(() => {
            console.error(`[ToolTimeout] ${tool.name} exceeded ${limitMs}ms — returning a timeout error`);
            resolve({
                status: 'error',
                timed_out: true,
                error: `The ${tool.name} tool did not finish within ${Math.round(limitMs / 1000)} seconds and was stopped ` +
                    '(an external service is probably slow or not responding). Tell the user it timed out and that ' +
                    'they can try again in a moment. Do not retry it yourself in this turn.',
            });
        }, limitMs);
    });
    try {
        return await Promise.race([tool.execute(args), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
