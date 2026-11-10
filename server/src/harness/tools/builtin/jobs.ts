import type { JobRegistry } from '../../jobs/registry';
import type { SubagentRunner } from '../../subagents';
import type { ToolDefinition } from '../types';

/**
 * Model-facing background-job controls, adapted from deepseek `dsh-tool-jobs`:
 * `job_output`, `job_list`, `job_kill`, plus `job_start` for a background subagent.
 * Completion notices are delivered by the harness subscription, not by polling.
 */

export function createJobTools(deps: {
  jobs: JobRegistry;
  subagents: SubagentRunner;
}): ToolDefinition[] {
  const { jobs, subagents } = deps;

  const jobStart: ToolDefinition = {
    name: 'job_start',
    description:
      'Start a background subagent for a self-contained task and keep working. The job id is '
      + 'returned immediately; collect its result later with job_output (wait: true only when '
      + 'genuinely blocked). Do not duplicate a running job\'s work.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'A self-contained task for the background subagent.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const task = (args as { task?: unknown } | null | undefined)?.task;
      if (typeof task !== 'string' || task.trim() === '') {
        throw new Error('job_start: "task" must be a non-empty string');
      }
      const job = jobs.start({
        kind: 'subagent',
        label: task.trim().slice(0, 80),
        sessionId: ctx.sessionId,
        run: async (handle) => {
          handle.setProgress('subagent running');
          const result = await subagents.run(ctx.sessionId, task.trim());
          handle.push(result.summary);
          return result;
        },
      });
      return { job };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Start background job', risk: 'low' },
  };

  const jobList: ToolDefinition = {
    name: 'job_list',
    description: 'List your background jobs with ids, kinds and statuses, one per line.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, ctx): Promise<unknown> {
      const list = jobs.list(ctx.sessionId);
      return {
        text: list.length === 0
          ? '(no background jobs)'
          : list.map((job) => `${job.id} [${job.kind}] ${job.status} — ${job.label}`).join('\n'),
        jobs: list,
      };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'List background jobs', risk: 'low' },
  };

  const jobOutput: ToolDefinition = {
    name: 'job_output',
    description:
      'Read a job\'s output since the previous read. Ends with a [status: ...] line. Set wait: true '
      + 'to block up to timeout_ms (default 30s) until the job settles; a timeout returns the '
      + 'running state and never cancels the job.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job id from job_start.' },
        wait: { type: 'boolean', description: 'Block until settlement or timeout.' },
        timeout_ms: { type: 'integer', description: 'Wait budget when wait is true.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args as { job_id?: unknown; wait?: unknown; timeout_ms?: unknown } | null | undefined) ?? {};
      if (typeof input.job_id !== 'string' || input.job_id.trim() === '') {
        throw new Error('job_output: "job_id" must be a non-empty string');
      }
      const jobId = input.job_id.trim();
      if (input.wait === true) {
        const timeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : 30_000;
        await jobs.wait(jobId, ctx.sessionId, timeout);
      }
      const read = jobs.read(jobId, ctx.sessionId);
      if (!read) throw new Error(`job_output: job "${jobId}" not found`);
      const job = jobs.get(jobId, ctx.sessionId);
      return {
        text: `${read.text}\n[status: ${read.status}${read.detail ? `, ${read.detail}` : ''}]`,
        job,
        ...(read.result !== undefined ? { result: read.result } : {}),
      };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Read job output', risk: 'low' },
  };

  const jobKill: ToolDefinition = {
    name: 'job_kill',
    description: 'Request cancellation of a running job. It settles as killed once work stops.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job id to cancel.' },
        reason: { type: 'string', description: 'Why this job stopped mattering.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args as { job_id?: unknown; reason?: unknown } | null | undefined) ?? {};
      if (typeof input.job_id !== 'string' || input.job_id.trim() === '') {
        throw new Error('job_kill: "job_id" must be a non-empty string');
      }
      const job = jobs.kill(
        input.job_id.trim(),
        ctx.sessionId,
        typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : undefined,
      );
      if (!job) throw new Error(`job_kill: job "${input.job_id.trim()}" not found`);
      const terminal = job.status === 'completed' || job.status === 'killed' || job.status === 'failed';
      return {
        outcome: terminal ? 'already-finished' as const : 'cancellation-requested' as const,
        job,
      };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Cancel background job', risk: 'low' },
  };

  return [jobStart, jobList, jobOutput, jobKill];
}
