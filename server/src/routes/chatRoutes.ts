import { Router } from 'express';
import { llmManager } from '../services/LLMManager';
import { memoryService } from '../services/MemoryService';

const router = Router();

router.post('/stream', async (req, res) => {
  const { message, sessionId, model, extendedThinking } = req.body;
  const targetModel = model || 'gemini-1.5-flash';

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Setup SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    // 1. Get History
    let session = memoryService.getSession(sessionId);
    if (!session) {
        const projectId = req.body.projectId || memoryService.getDefaultProject().id;
        session = memoryService.createSession(projectId, message.substring(0, 50));
    }
    
    const currentSessionId = session.id;

    // Save User Message
    memoryService.addToHistory('user', message, currentSessionId);

    // Fetch updated history
    const rawHistory = memoryService.getHistory(currentSessionId) || [];
    const messages = rawHistory.map((m: any) => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.parts[0]?.text || ''
    }));

    // Start Stream
    const stream = llmManager.chat(messages, targetModel, { extendedThinking });
    
    let fullResponse = '';
    let toolCalls: any[] = [];

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (chunk.type === 'content') {
        fullResponse += chunk.content;
      } else if (chunk.type === 'call') {
        // Collect tool calls for history
        if (chunk.call) {
            const existingIdx = toolCalls.findIndex(c => c.name === chunk.call?.name && !c.result);
            if (existingIdx > -1 && chunk.call.result) {
                toolCalls[existingIdx].result = chunk.call.result;
            } else if (!chunk.call.result) {
                toolCalls.push({ ...chunk.call });
            }
        }
      }
    }

    // Save Assistant Response with Tool Calls
    if (fullResponse || toolCalls.length > 0) {
        memoryService.addToHistory('model', fullResponse, currentSessionId, toolCalls);
    }

  } catch (error: any) {
    console.error('Chat stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', content: error.message || String(error) })}\n\n`);
  }

  res.end();
});

export default router;