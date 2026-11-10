import { createId } from '../../shared/id';
import type { EventStore } from '../../events/store';
import type { SessionStore } from '../../session/store';
import type { SkillLoader } from '../../skills/loader';
import type { SubagentRunner } from '../../subagents';
import type { ToolDefinition } from '../types';

/**
 * Model-facing harness controls (the agent's own hands, not the user's): load any skill by name
 * or list the catalog, read/set the durable session goal, and spawn a detached subagent. The
 * human `/` side already exists (`/goal`, `/subagent` routes, skill palette); these tools are the
 * same capabilities from the model's side, on the same durable events.
 */

export function createSkillTool(deps: { loader: SkillLoader }): ToolDefinition {
  const { loader } = deps;
  return {
    name: 'skill',
    description:
      'Load the full instructions for a skill by its exact name from the available-skills catalog. '
      + 'Call it before acting on any task that names a skill or plainly matches a catalog description. '
      + 'Omit name to list the catalog.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name from the available skills list.' },
      },
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const name = (args as { name?: unknown } | null | undefined)?.name;
      if (name === undefined) {
        return {
          skills: loader.list().map((skill) => ({ name: skill.name, description: skill.description })),
        };
      }
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('skill: "name" must be a non-empty string');
      }
      const skill = loader.get(name);
      if (!skill) throw new Error(`skill "${name}" is unknown or no longer available`);
      // Persist the activation for later turns, mirroring the UI-side skill toggle.
      const active = loader.active(ctx.sessionId);
      if (!active.includes(name)) loader.setActive(ctx.sessionId, [...active, name].sort());
      return { name: skill.name, provider: skill.source, content: skill.body };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Load skill', risk: 'low' },
  };
}

type GoalStatus = 'active' | 'done' | 'blocked';

function latestGoal(events: EventStore, sessionId: string): { goalId: string; status: GoalStatus; objective: string } | null {
  let current: { goalId: string; status: GoalStatus; objective: string } | null = null;
  for (const event of events.list(sessionId)) {
    if (event.type !== 'goal/changed') continue;
    const payload = event.payload as { goalId: string; status: GoalStatus; objective: string };
    current = { goalId: payload.goalId, status: payload.status, objective: payload.objective };
  }
  return current;
}

function writeGoal(
  deps: { events: EventStore; sessions: SessionStore },
  sessionId: string,
  goalId: string,
  status: GoalStatus,
  objective: string,
): { id: string; goalId: string; status: GoalStatus; objective: string } {
  deps.events.append(sessionId, [{ type: 'goal/changed', payload: { goalId, status, objective } }]);
  deps.sessions.setGoalCache(sessionId, status === 'active' ? goalId : null);
  return { id: sessionId, goalId, status, objective };
}

export function createGoalTools(deps: { events: EventStore; sessions: SessionStore }): ToolDefinition[] {
  const { events, sessions } = deps;

  const getGoal: ToolDefinition = {
    name: 'get_goal',
    description: 'Read the current session goal (objective and status), if any.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, ctx): Promise<unknown> {
      const goal = latestGoal(events, ctx.sessionId);
      return { goal: goal === null ? null : { id: goal.goalId, objective: goal.objective, status: goal.status } };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Read goal', risk: 'low' },
  };

  const setGoal: ToolDefinition = {
    name: 'set_goal',
    description:
      'Set (or replace) this session objective, or end the current goal. The harness keeps '
      + 'working toward an active goal until it is done or blocked.',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The concrete completion objective. Required to start a new goal.',
        },
        status: {
          type: 'string',
          enum: ['active', 'done', 'blocked'],
          description: 'Goal state. Defaults to active; done/blocked ends the current goal.',
        },
      },
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args ?? {}) as { objective?: unknown; status?: unknown };
      const status = (input.status ?? 'active') as GoalStatus;
      const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
      const current = latestGoal(events, ctx.sessionId);

      if (status === 'active') {
        if (objective === '') throw new Error('set_goal: "objective" is required to start a goal');
        const goalId = createId('goal');
        return writeGoal(deps, ctx.sessionId, goalId, 'active', objective);
      }
      if (current === null) throw new Error(`set_goal: no current goal to mark ${status}`);
      return writeGoal(
        deps,
        ctx.sessionId,
        current.goalId,
        status,
        objective === '' ? current.objective : objective,
      );
    },
    isConcurrencySafe: false,
    approval: 'auto',
    presentation: { label: 'Set goal', risk: 'low' },
  };

  return [getGoal, setGoal];
}

export function createSubagentTool(runner: SubagentRunner): ToolDefinition {
  return {
    name: 'subagent',
    description:
      'Start a detached subagent for a self-contained task and return immediately. '
      + 'Use it for a well-scoped subtask that can run without your context (research, audit, '
      + 'a small implementation); max 2 levels of nesting. The subagent runs in its own session '
      + 'with approval-free tools only. Keep working while it runs; the completion notice arrives '
      + 'in-session — do not sleep or poll. Collect the result before your final answer.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A self-contained task description with every fact the subagent needs.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const task = (args as { task?: unknown } | null | undefined)?.task;
      if (typeof task !== 'string' || task.trim() === '') {
        throw new Error('subagent: "task" must be a non-empty string');
      }
      // Deepseek `started subagent <name>`: admission only, execution is owned by the runtime.
      const started = runner.start(ctx.sessionId, task.trim());
      return { started: true, childSessionId: started.childSessionId, status: 'running' as const };
    },
    isConcurrencySafe: false,
    approval: 'auto',
    presentation: { label: 'Spawn subagent', risk: 'low' },
  };
}
