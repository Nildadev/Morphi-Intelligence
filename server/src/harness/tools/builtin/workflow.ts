import { createId } from '../../shared/id';
import type { EventStore } from '../../events/store';
import type { JobRegistry } from '../../jobs/registry';
import type { SubagentRunner } from '../../subagents';
import type { ToolDefinition } from '../types';

/**
 * Workflow fan-out, simplified from deepseek `dsh-tool-workflow`: the model declares
 * parallel subtasks, the harness fans them out across real subagent sessions (max 3
 * concurrent), and returns the structured result. Background runs register as owned
 * `workflow` jobs so `job_output`/`job_kill` can observe them.
 */

export interface WorkflowTask {
  title: string;
  task: string;
}

const MAX_TASKS = 8;
const CONCURRENCY = 3;

export function createWorkflowTool(deps: {
  events: EventStore;
  subagents: SubagentRunner;
  jobs: JobRegistry;
}): ToolDefinition {
  const { events, subagents, jobs } = deps;

  async function runFanout(
    sessionId: string,
    workflowId: string,
    tasks: WorkflowTask[],
    signal: AbortSignal,
  ): Promise<{ results: Array<{ title: string; status: string; summary: string; childSessionId: string }> }> {
    // Pool of 3: the runner already enforces max 3 concurrent, so queue beyond that.
    // A semaphore keeps the fan-out from throwing SubagentBusyError for tasks 4+.
    let permits = CONCURRENCY;
    const waiters: Array<() => void> = [];
    const acquire = (): Promise<void> => new Promise((resolve) => {
      if (permits > 0) { permits -= 1; resolve(); return; }
      waiters.push(() => { permits -= 1; resolve(); });
    });
    const release = (): void => {
      permits += 1;
      const next = waiters.shift();
      if (next) next();
    };

    const phases = tasks.map((task) => task.title);
    events.append(sessionId, [{ type: 'workflow/start', payload: { workflowId, name: 'fanout', phases } }]);

    const results = await Promise.all(tasks.map(async (task) => {
      await acquire();
      if (signal.aborted) {
        release();
        return { title: task.title, status: 'cancelled', summary: 'cancelled', childSessionId: '' };
      }
      events.append(sessionId, [{ type: 'workflow/phase', payload: { workflowId, phase: task.title, status: 'started' } }]);
      try {
        const outcome = await subagents.run(sessionId, task.task);
        events.append(sessionId, [{ type: 'workflow/phase', payload: { workflowId, phase: task.title, status: outcome.status === 'done' ? 'completed' : 'failed' } }]);
        return { title: task.title, status: outcome.status, summary: outcome.summary, childSessionId: outcome.childSessionId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.append(sessionId, [{ type: 'workflow/phase', payload: { workflowId, phase: task.title, status: 'failed' } }]);
        return { title: task.title, status: 'error', summary: message, childSessionId: '' };
      } finally {
        release();
      }
    }));

    const anyFailed = results.some((result) => result.status === 'error');
    events.append(sessionId, [{ type: 'workflow/end', payload: { workflowId, status: anyFailed ? 'failed' : 'completed' } }]);
    return { results };
  }

  return {
    name: 'workflow',
    description:
      'Run a workflow: fan out parallel subtasks across subagents and return structured results. '
      + 'Use ONLY when the user explicitly requests a workflow or large multi-agent orchestration; '
      + 'for 1-2 delegations prefer plain subagent calls. At most 8 tasks, at most 3 concurrently.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name (for example "audit").' },
        tasks: {
          type: 'array',
          description: 'Parallel subtasks, each with a title and a self-contained task.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              task: { type: 'string' },
            },
            required: ['title', 'task'],
            additionalProperties: false,
          },
        },
        run_in_background: { type: 'boolean', description: 'Start as an owned workflow job and return immediately.' },
      },
      required: ['name', 'tasks'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args as { name?: unknown; tasks?: unknown; run_in_background?: unknown } | null | undefined) ?? {};
      if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error('workflow: "name" must be a non-empty string');
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error('workflow: "tasks" must be a non-empty array');
      if (input.tasks.length > MAX_TASKS) throw new Error(`workflow: at most ${MAX_TASKS} tasks`);
      const tasks: WorkflowTask[] = input.tasks.map((entry, index) => {
        if (entry === null || typeof entry !== 'object') throw new Error(`workflow: tasks[${index}] must be an object`);
        const item = entry as { title?: unknown; task?: unknown };
        if (typeof item.title !== 'string' || item.title.trim() === '') throw new Error(`workflow: tasks[${index}].title must be a non-empty string`);
        if (typeof item.task !== 'string' || item.task.trim() === '') throw new Error(`workflow: tasks[${index}].task must be a non-empty string`);
        return { title: item.title.trim(), task: item.task.trim() };
      });
      if (ctx.signal.aborted) throw new Error('workflow run was cancelled');

      const workflowId = createId('wf');
      const name = input.name.trim();

      if (input.run_in_background === true) {
        const job = jobs.start({
          kind: 'workflow',
          label: name,
          sessionId: ctx.sessionId,
          run: async (handle) => {
            handle.setProgress('workflow running');
            const fanout = await runFanout(ctx.sessionId, workflowId, tasks, handle.signal);
            return { kind: 'background', runId: workflowId, agentsStarted: tasks.length, result: fanout };
          },
        });
        return { kind: 'background', jobId: job.id, runId: workflowId };
      }

      const fanout = await runFanout(ctx.sessionId, workflowId, tasks, ctx.signal);
      const completed = fanout.results.filter((result) => result.status === 'done').length;
      return {
        kind: 'foreground',
        runId: workflowId,
        agentsStarted: tasks.length,
        result: fanout,
        text: `workflow "${name}" completed (${completed} of ${tasks.length} agents done).`,
      };
    },
    isConcurrencySafe: false,
    approval: 'auto',
    presentation: { label: 'Run workflow', risk: 'low' },
  };
}
