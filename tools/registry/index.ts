import { config } from '../config';
import { taskTools } from '../tasks';
import { expenseTools } from '../expenses';
import { calendarTools } from '../calendar';
import { habitTools } from '../habits';
import { searchTools } from '../search';
import { dailyStatusTools } from '../daily-status';
import { memoryTools } from '../memory';
import { whatsappMediaTools } from '../whatsapp-media';
import { emailTools } from '../email';

/**
 * Tool Registry — OpenClaw Integration
 *
 * This module collects all custom tools and exports them in a format
 * compatible with OpenClaw's tool registration system.
 *
 * In the AWS version, this used Gemini-specific SchemaType enums.
 * Now uses standard JSON Schema (OpenAI-compatible, which OpenClaw expects).
 */

export interface Tool {
    name: string;
    description: string;
    parameters: any;
    execute: (args: any) => Promise<Record<string, any>>;
}

export const toolRegistry: Record<string, Tool> = {
    // ─── Time ────────────────────────────────────────────────────
    get_current_time: {
        name: "get_current_time",
        description: "Returns the current date and time in Israel (Asia/Jerusalem timezone)",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            const timeInIsrael = new Date().toLocaleString('en-IL', { timeZone: config.timezone });
            return { current_time: timeInIsrael };
        }
    },

    // ─── Tasks ───────────────────────────────────────────────────
    ...taskTools,

    // ─── Expenses ────────────────────────────────────────────────
    ...expenseTools,

    // ─── Calendar ────────────────────────────────────────────────
    ...calendarTools,

    // ─── Habits ──────────────────────────────────────────────────
    ...habitTools,

    // ─── Search ──────────────────────────────────────────────────
    ...searchTools,

    // ─── Daily Status ────────────────────────────────────────────
    ...dailyStatusTools,

    // ─── Memory ──────────────────────────────────────────────────
    ...memoryTools,

    // ─── WhatsApp Media (Read-Only) ───────────────────────────────────
    ...whatsappMediaTools,

    // ─── Email (Read-Only IMAP) ───────────────────────────────────────
    ...emailTools,
};

/**
 * Returns all tools as an array of OpenAI-compatible function declarations.
 * This is the format OpenClaw expects when registering custom tools.
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
    console.log(`[Registry] Registered ${tools.length} tools: ${tools.map(t => t.function.name).join(', ')}`);
    return tools;
}
