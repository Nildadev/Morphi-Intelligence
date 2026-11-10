import type { EventStore } from '../../events/store';
import { planActiveOf, setPlanMode } from '../../plan/mode';
import type { ToolDefinition } from '../types';

/**
 * Model-facing plan-mode exit, adapted from deepseek-harness `exit_plan_mode`.
 * The plan is markdown starting with a heading. The call runs through the normal
 * approval gate (`ask`), so the user reviews the exact plan before execution:
 * approving leaves plan mode, denying leaves it active for another revision.
 */

export function createExitPlanModeTool(deps: { events: EventStore }): ToolDefinition {
  const { events } = deps;
  return {
    name: 'exit_plan_mode',
    description:
      'Present the finished plan for review and leave plan mode. The plan is markdown and '
      + 'must start with a heading. The user approves to continue or asks for changes. '
      + 'Only call this when plan mode is active and the plan is complete.',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan as markdown, starting with a heading (for example "## Plan").',
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const plan = (args as { plan?: unknown } | null | undefined)?.plan;
      if (typeof plan !== 'string' || plan.trim() === '') {
        throw new Error('exit_plan_mode: "plan" must be a non-empty markdown string');
      }
      if (!/^#{1,6}\s+/.test(plan.trim())) {
        throw new Error('exit_plan_mode: "plan" must start with a markdown heading');
      }
      if (!planActiveOf(events, ctx.sessionId)) {
        throw new Error('exit_plan_mode: plan mode is not active');
      }
      setPlanMode(events, ctx.sessionId, false, plan.trim());
      return { approved: true, plan: plan.trim() };
    },
    isConcurrencySafe: false,
    approval: 'ask',
    presentation: { label: 'Submit plan', risk: 'low' },
  };
}
