import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { mcpService } from './services/McpService';
import { llmManager } from './services/LLMManager';
import path from 'path';
import modelRoutes from './routes/modelRoutes';
import chatRoutes from './routes/chatRoutes';
import sessionRoutes from './routes/sessionRoutes';
import projectRoutes from './routes/projectRoutes';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve Frontend Static Files
const clientDistPath = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDistPath));

// Request Logger
app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

// ── Settings ────────────────────────────────────────────────────────────────
app.post('/api/settings', (req: Request, res: Response) => {
    const { providerId, apiKey } = req.body;
    if (!providerId || apiKey === undefined) {
        return res.status(400).json({ error: 'providerId and apiKey are required' });
    }
    try {
        // "gemini" is exposed as "gemini" in the UI but stored as "google" internally
        const targetProvider = providerId === 'gemini' ? 'google' : providerId;
        llmManager.updateKey(targetProvider, apiKey);
        console.log(`[Settings] API key updated for "${targetProvider}"`);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ error: error.message || String(error) });
    }
});

// ── MCP Tools ────────────────────────────────────────────────────────────────
app.get('/api/tools', async (_req: Request, res: Response) => {
    try {
        if (!mcpService.connected) {
            return res.json({ connected: false, tools: [] });
        }
        const result = await mcpService.listTools();
        res.json({ connected: true, tools: result.tools ?? [] });
    } catch (error: any) {
        res.json({ connected: false, tools: [], error: error.message });
    }
});

// ── MCP Reconnect ────────────────────────────────────────────────────────────
app.post('/api/mcp/reconnect', async (_req: Request, res: Response) => {
    try {
        await mcpService.reconnect();
        res.json({ connected: mcpService.connected });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ── Domain Routes ────────────────────────────────────────────────────────────
app.use('/api/projects', projectRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api', sessionRoutes);

// ── SPA Fallback ─────────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
    if (req.url.startsWith('/api')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Server] Unhandled error:', err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
    try {
        console.log("[Boot] Initializing services...");
        await mcpService.connect();
        // Warm model cache in background
        llmManager.getModels().then((m) =>
            console.log(`[Boot] Pre-fetched ${m.length} model(s)`)
        ).catch((e) => console.warn("[Boot] Model pre-fetch failed:", e));
        console.log("[Boot] Services ready.");
    } catch (error) {
        console.error("[Boot] Failed to initialize:", error);
    }
})();

app.listen(PORT, () => {
    console.log(`Morphi Server → http://localhost:${PORT}`);
});

process.on('uncaughtException', (err) => {
    console.error('[Backend] Uncaught Exception:', err);
    process.exit(1); // Exit to prevent corrupted state
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Backend] Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1); // Exit to prevent corrupted state
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
    console.log(`[Shutdown] Received ${signal}, cleaning up...`);
    try {
        await mcpService.close();
        console.log("[Shutdown] MCP Service closed.");
    } catch (e) {
        console.error("[Shutdown] Error during close:", e);
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));