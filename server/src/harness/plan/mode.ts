import type { EventStore } from '../events/store';
import type { EventPayloadMap } from '../events/types';

/**
 * Plan mode state, adapted from deepseek-harness `plan-mode`:
 * one log-only whole-value-replace event (`plan/mode`), last write wins.
 * Guidance is soft (a prompt section), never a capability filter — the
 * model keeps every tool and is told to explore/design before executing.
 */

export interface PlanState {
  active: boolean;
  plan?: string;
  updatedAt: number;
}

export function planStateOf(events: EventStore, sessionId: string): PlanState {
  let current: PlanState = { active: false, updatedAt: 0 };
  for (const event of events.list(sessionId)) {
    if (event.type !== 'plan/mode') continue;
    const payload = event.payload as EventPayloadMap['plan/mode'];
    current = {
      active: payload.active,
      ...(payload.plan !== undefined ? { plan: payload.plan } : {}),
      updatedAt: payload.updatedAt,
    };
  }
  return current;
}

export function planActiveOf(events: EventStore, sessionId: string): boolean {
  return planStateOf(events, sessionId).active;
}

export function setPlanMode(
  events: EventStore,
  sessionId: string,
  active: boolean,
  plan?: string,
): PlanState {
  const next: PlanState = {
    active,
    ...(plan !== undefined ? { plan } : {}),
    updatedAt: Date.now(),
  };
  events.append(sessionId, [{
    type: 'plan/mode',
    payload: {
      active: next.active,
      ...(next.plan !== undefined ? { plan: next.plan } : {}),
      updatedAt: next.updatedAt,
    },
  }]);
  return next;
}
