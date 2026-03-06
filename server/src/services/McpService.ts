import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

export class McpService {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;

    constructor() { }

    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            console.log("[MCP] Starting Roblox Studio MCP Server...");

            const isWindows = process.platform === 'win32';
            this.transport = new StdioClientTransport({
                command: isWindows ? "npx.cmd" : "npx",
                args: ["-y", "robloxstudio-mcp@latest", "--install-plugin"],
                stderr: "inherit" // Share stderr with backend log for better visibility
            });

            this.client = new Client(
                { name: "Morphi-Backend", version: "1.0.0" },
                { capabilities: {} }
            );

            await this.client.connect(this.transport);
            this.isConnected = true;
            console.log("[MCP] Connected to Roblox Studio MCP Server.");

            try {
                const tools = await this.listTools();
                console.log(`[MCP] ${tools?.tools?.length ?? 0} tool(s) available.`);
            } catch {
                console.warn("[MCP] Connected but could not list tools immediately.");
            }

        } catch (error) {
            console.error("[MCP] Failed to connect:", error);
            this.isConnected = false;
            this.client = null;
            this.transport = null;
        } finally {
            this.isConnecting = false;
        }
    }

    /** Attempt to reconnect if not currently connected. */
    async reconnect() {
        if (this.isConnected) return;
        await this.close();
        await this.connect();
    }

    get connected(): boolean {
        return this.isConnected;
    }

    async listTools(): Promise<ListToolsResult> {
        if (!this.isConnected || !this.client) {
            throw new Error("MCP Client is not connected.");
        }
        // @ts-ignore
        return await this.client.listTools();
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.isConnected || !this.client) {
            throw new Error("MCP Client is not connected.");
        }
        return await this.client.callTool({ name, arguments: args });
    }

    async close() {
        try {
            if (this.transport) await this.transport.close();
        } catch { /* ignore close errors */ }
        this.isConnected = false;
        this.isConnecting = false;
        this.client = null;
        this.transport = null;
    }
}

export const mcpService = new McpService();
