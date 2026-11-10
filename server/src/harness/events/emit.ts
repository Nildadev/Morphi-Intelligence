import type { LiveEvent } from '../shared/types';
import type { EventStore } from './store';
import type { Emit, NewSessionEvent, SessionEvent } from './types';

/**
 * Sink for everything the harness streams to open clients: persisted event rows
 * (from `durable`) and ephemeral frames (from `live`). Task 16 wires this to SSE.
 */
export type EmitSink = (event: SessionEvent | LiveEvent) => void;

export function createEmit(store: EventStore, sessionId: string, onEvent?: EmitSink): Emit {
  return {
    durable(event: NewSessionEvent): void {
      const [persisted] = store.append(sessionId, [event]);
      if (onEvent && persisted) onEvent(persisted);
    },
    live(event: LiveEvent): void {
      if (onEvent) onEvent(event);
    },
  };
}
