import OpenAI from 'openai';
import { Message, StreamChunk } from '../types/llm';
import { BaseProvider } from './BaseProvider';
import { SYSTEM_PROMPT } from '../services/SystemPrompt';

export interface OpenAICompatibleOptions {
    apiKey: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
}

/**
 * Shared streaming + tool-call loop for any OpenAI-compatible endpoint.
 * Pass an OpenAI client and let this generator handle the full agentic loop.
 */
export async function* runOpenAICompatibleChat(
    provider: BaseProvider,
    client: OpenAI,
    messages: Message[],
    modelId: string,
    options?: any
): AsyncGenerator<StreamChunk> {
    const mcpTools = await provider.getTools();
    const tools =
        mcpTools.length > 0
            ? mcpTools.map((t) => ({
                type: 'function' as const,
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                },
            }))
            : undefined;

    const maxTokens = options?.extendedThinking ? 16384 : 4096;
    const temperature = options?.temperature ?? 0.7;

    let currentMessages: any[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
    ];

    let shouldContinue = true;
    const MAX_TOOL_ROUNDS = 10; // Safety limit for agentic loops
    let toolRound = 0;

    try {
        while (shouldContinue && toolRound < MAX_TOOL_ROUNDS) {
            shouldContinue = false;

            const stream = await client.chat.completions.create({
                model: modelId,
                messages: currentMessages,
                stream: true,
                tools: tools as any,
                max_tokens: maxTokens,
                temperature,
            });

            const toolCallsBuffer: Record<
                number,
                { id: string; function: { name: string; arguments: string }; type: string }
            > = {};
            let hasContent = false;

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;

                // Accumulate tool call deltas
                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (!toolCallsBuffer[tc.index]) {
                            toolCallsBuffer[tc.index] = {
                                id: tc.id ?? '',
                                function: { name: '', arguments: '' },
                                type: 'function',
                            };
                        }
                        if (tc.id) toolCallsBuffer[tc.index].id = tc.id;
                        if (tc.function?.name) toolCallsBuffer[tc.index].function.name += tc.function.name;
                        if (tc.function?.arguments)
                            toolCallsBuffer[tc.index].function.arguments += tc.function.arguments;
                    }
                }

                // Stream text content
                if (delta?.content) {
                    hasContent = true;
                    yield { type: 'content', content: delta.content };
                }
            }

            const toolCalls = Object.values(toolCallsBuffer);

            if (toolCalls.length > 0) {
                toolRound++;
                // Append the assistant turn with tool_calls
                currentMessages.push({
                    role: 'assistant',
                    content: null,
                    tool_calls: toolCalls,
                });

                for (const tc of toolCalls) {
                    const fnName = tc.function.name;
                    let fnArgs: any = {};
                    try {
                        fnArgs = JSON.parse(tc.function.arguments || '{}');
                    } catch {
                        fnArgs = {};
                    }

                    // Emit call start to frontend
                    yield { type: 'call', call: { name: fnName, args: fnArgs } };

                    let result = '';
                    try {
                        result = await provider.executeTool(fnName, fnArgs);
                    } catch (e: any) {
                        result = `Error executing ${fnName}: ${e.message}`;
                    }

                    // Emit call result to frontend
                    yield { type: 'call', call: { name: fnName, args: fnArgs, result } };

                    currentMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: result,
                    });
                }

                shouldContinue = true;
            }
        }

        if (toolRound >= MAX_TOOL_ROUNDS) {
            yield { type: 'content', content: '\n\n*(Reached max tool-call rounds)*' };
        }

        yield { type: 'done' };
    } catch (error: any) {
        yield { type: 'error', content: error.message ?? 'Unknown error' };
    }
}
