import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

export class McpService {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;
    private isStudioLinked: boolean = false;

    constructor() { }

    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            console.log("[MCP] Starting Roblox Studio MCP Server...");

            const isWindows = process.platform === 'win32';
            let commandStr = "npx";

            if (isWindows) {
                try {
                    const execSync = require('child_process').execSync;
                    const npxPath = execSync('where npx').toString().split('\n').filter(Boolean)[0].trim();
                    commandStr = npxPath || "npx.cmd";
                } catch (e) {
                    console.log("[MCP] Failed to resolve npx path using 'where', falling back to npx.cmd");
                    commandStr = "npx.cmd";
                }
            }

            console.log("[MCP] Environment check:", {
                platform: process.platform,
                commandStr
            });

            this.transport = new StdioClientTransport({
                command: commandStr,
                args: ["-y", "robloxstudio-mcp@latest"],
                // Pipe stderr so we can parse connection status from the bridge
                stderr: "pipe"
            });

            // Handle stderr logs to detect Studio link status
            if (this.transport.stderr) {
                this.transport.stderr.on('data', (data: Buffer) => {
                    const line = data.toString();
                    process.stderr.write(data); // Still show in our console

                    if (line.includes("Waiting for Studio plugin")) {
                        this.isStudioLinked = false;
                    } else if (line.includes("Connected to Roblox Studio") || line.includes("Studio plugin connected")) {
                        this.isStudioLinked = true;
                    }
                });
            }

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

    get studioLinked(): boolean {
        return this.isStudioLinked;
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
