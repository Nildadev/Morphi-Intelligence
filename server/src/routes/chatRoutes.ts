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

  // SSE headers already sent...
  let currentSessionId = sessionId;
  let rawHistory: any[] = [];
  let fullResponse = '';
  let thoughtResponse = '';
  let steps: any[] = [];

  try {
    // 1. Get History
    let session = memoryService.getSession(sessionId);
    if (!session) {
      const projectId = req.body.projectId || memoryService.getDefaultProject().id;
      session = memoryService.createSession(projectId, message.substring(0, 50));
    }

    currentSessionId = session.id;

    // Save User Message
    memoryService.addToHistory('user', message, currentSessionId);

    // Fetch updated history
    rawHistory = memoryService.getHistory(currentSessionId) || [];

    const messages = rawHistory.map((m: any) => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.parts[0]?.text || '',
      thought: m.thought,
      calls: m.calls
    }));

    // Start Stream
    const stream = llmManager.chat(messages, targetModel, { extendedThinking });

    let toolCalls: any[] = [];

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (chunk.type === 'content') {
        fullResponse += chunk.content;
        const lastStep = steps[steps.length - 1];
        if (lastStep?.type === 'text') {
          lastStep.content += chunk.content;
        } else {
          steps.push({ type: 'text', content: chunk.content });
        }
      } else if (chunk.type === 'thought') {
        thoughtResponse += chunk.content;
      } else if (chunk.type === 'call') {
        // Collect tool calls for history
        if (chunk.call) {
          const existingIdx = toolCalls.findIndex(c => c.name === chunk.call?.name && !c.result);
          if (existingIdx > -1 && chunk.call.result) {
            toolCalls[existingIdx].result = chunk.call.result;
            // Also update the step
            const stepIdx = [...steps].reverse().findIndex(s => s.type === 'call' && s.name === chunk.call?.name);
            if (stepIdx > -1) {
              const realIdx = steps.length - 1 - stepIdx;
              steps[realIdx].result = chunk.call.result;
            }
          } else if (!chunk.call.result) {
            toolCalls.push({ ...chunk.call });
            steps.push({ type: 'call', ...chunk.call });
          }
        }
      }
    }

    // Save Assistant Response with Tool Calls
    if (fullResponse || thoughtResponse || toolCalls.length > 0) {
      if (!memoryService.getSession(currentSessionId)) {
        console.warn(`[ChatStream] Session ${currentSessionId} was deleted during the stream. Cannot save assistant message.`);
      } else {
        memoryService.addToHistory('model', fullResponse.trim(), currentSessionId, toolCalls, thoughtResponse || undefined, steps);
      }
    }

  } catch (error: any) {
    console.error('Chat stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', content: error.message || String(error) })}\n\n`);
  }

  res.end();

  // Auto-generate title for new chats (Truly backgrounded after response ends)
  if (rawHistory.length === 1 && (fullResponse || thoughtResponse)) {
    setTimeout(async () => {
      try {
        const prompt = `Generate a short, concise title (max 4-5 words) for this message: "${message}". Return ONLY the title text, no quotes or intro.`;
        const titleModel = 'gemini-1.5-flash';
        const titleStream = llmManager.chat([{ role: 'user', content: prompt }], titleModel);
        let generatedTitle = '';
        for await (const chunk of titleStream) {
          if (chunk.type === 'content') generatedTitle += chunk.content;
        }
        generatedTitle = generatedTitle.trim().replace(/^["']|["']$/g, '');
        if (generatedTitle) {
          memoryService.updateSessionTitle(currentSessionId, generatedTitle);
        }
      } catch (e) {
        console.error('[ChatStream] Title generation failed:', e);
      }
    }, 500);
  }
});

export default router;