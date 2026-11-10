import type { SubagentRunner } from '../../subagents';
import type { ToolDefinition } from '../types';

/**
 * Subagent control tools, adapted from deepseek `dsh-tool-subagent-control`:
 * discovery (`list_agents`), follow-up messaging (`send_message`), and
 * interruption (`interrupt_agent`). `wait_agent` is covered by the inbox +
 * jobs completion notices, so only these three are registered.
 */
export function createSubagentControlTools(runner: SubagentRunner): ToolDefinition[] {
  const listAgents: ToolDefinition = {
    name: 'list_agents',
    description: 'List the root agent and all continuable subagent descendants with status.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, ctx): Promise<unknown> {
      const tree = runner.listTree(ctx.sessionId);
      const rows = [
        `lead [inactive] — root agent`,
        ...tree.map((entry) => `${entry.childSessionId} [${entry.status}] — ${entry.task.slice(0, 80)}`),
      ];
      return { text: rows.join('\n'), agents: [{ name: 'lead', status: 'inactive' }, ...tree] };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'List agents', risk: 'low' },
  };

  const sendMessage: ToolDefinition = {
    name: 'send_message',
    description:
      'Send a follow-up message to a subagent child (a session id from list_agents) in the same '
      + 'tree. A working target receives it at its next step; an inactive target starts a new turn. '
      + 'Success returns only acceptance; replies are collected via list/output, not this call.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Child session id from list_agents.' },
        message: { type: 'string', description: 'Follow-up instruction for the child.' },
      },
      required: ['agent', 'message'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args as { agent?: unknown; message?: unknown } | null | undefined) ?? {};
      if (typeof input.agent !== 'string' || input.agent.trim() === '') throw new Error('send_message: "agent" must be a non-empty string');
      if (typeof input.message !== 'string' || input.message.trim() === '') throw new Error('send_message: "message" must be a non-empty string');
      const result = await runner.followup(ctx.sessionId, input.agent.trim(), input.message.trim());
      return { delivered: true, agent: input.agent.trim(), childSessionId: result.childSessionId, summary: result.summary };
    },
    isConcurrencySafe: false,
    approval: 'auto',
    presentation: { label: 'Message subagent', risk: 'low' },
  };

  const interruptAgent: ToolDefinition = {
    name: 'interrupt_agent',
    description:
      'Interrupt a descendant\'s current turn (child session id from list_agents). Queued work '
      + 'stays parked for a later send_message; descendants keep running. Interrupting a finished '
      + 'agent is a no-op.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Child session id from list_agents.' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args as { agent?: unknown } | null | undefined) ?? {};
      if (typeof input.agent !== 'string' || input.agent.trim() === '') throw new Error('interrupt_agent: "agent" must be a non-empty string');
      const agentId = input.agent.trim();
      // Authorization: only descendants of the caller may be interrupted.
      const tree = runner.listTree(ctx.sessionId);
      if (!tree.some((entry) => entry.childSessionId === agentId)) {
        throw new Error(`interrupt_agent: "${agentId}" is not a descendant of this session`);
      }
      const interrupted = runner.interrupt(agentId);
      return { accepted: true, agent: agentId, interrupted };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Interrupt subagent', risk: 'low' },
  };

  return [listAgents, sendMessage, interruptAgent];
}
