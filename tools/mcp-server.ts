import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolRegistry } from "./registry/index.js";

const server = new Server(
    {
        name: "astra-tools",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: Object.values(toolRegistry).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
        })),
    };
});

// Execute tools
server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    try {
        const tool = toolRegistry[request.params.name];
        if (!tool) {
            throw new Error(`Tool not found: ${request.params.name}`);
        }
        
        const result = await tool.execute(request.params.arguments);
        
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error executing tool: ${error?.message || String(error)}`,
                },
            ],
            isError: true,
        };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Astra MCP Server running on stdio");
}

main().catch((err) => {
    console.error("Fatal error running MCP server:", err);
    process.exit(1);
});
