import type { Emit } from '../events/types';
import { createId } from '../shared/id';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../shared/types';

export const APPROVAL_TIMEOUT_MS = 120_000;

export type ApprovalRisk = 'low' | 'medium' | 'high';
export type ApprovalDecision = 'allow' | 'deny' | 'expired';
export type ApprovalScope = 'once' | 'session';

export interface ApprovalRequestInput {
  sessionId: string;
  callId: string;
  name: string;
  args: unknown;
  risk: ApprovalRisk;
  approval: 'auto' | 'ask' | 'ask-once';
  turnId?: string;
  signal?: AbortSignal;
}

export interface ApprovalOutcome {
  allowed: boolean;
  decision: ApprovalDecision;
  scope: ApprovalScope;
}

interface PendingApproval {
  input: ApprovalRequestInput;
  emit: Emit;
  resolve: (outcome: ApprovalOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

function allow(scope: ApprovalScope): ApprovalOutcome {
  return { allowed: true, decision: 'allow', scope };
}

function refusal(decision: 'deny' | 'expired'): ApprovalOutcome {
  return { allowed: false, decision, scope: 'once' };
}

function sessionKey(sessionId: string, name: string): string {
  return `${sessionId}\u0000${name}`;
}

export class ApprovalService {
  private pending = new Map<string, PendingApproval>();
  private sessionApprovals = new Set<string>();

  /**
   * Resolves once the call may run. `ask`, `ask-once` and every high-risk call record an
   * `approval/request` through the passed emit so the open SSE stream shows the modal
   * without a reload; `auto` and remembered session allows record nothing.
   */
  request(input: ApprovalRequestInput, emit: Emit, mode: PermissionMode = DEFAULT_PERMISSION_MODE): Promise<ApprovalOutcome> {
    // Full access bypasses the gate entirely — no modal, no risk check, nothing recorded.
    if (mode === 'full') return Promise.resolve(allow('once'));
    // The effective approval requirement after the global mode is applied: `ask` forces every tool
    // to prompt, `balanced` keeps each tool's own declaration.
    const effectiveApproval: ApprovalRequestInput['approval'] = mode === 'ask' ? 'ask' : input.approval;
    // High risk is never auto-approved, whatever the tool declares (spec: always ask).
    if (input.risk !== 'high' && effectiveApproval === 'auto') return Promise.resolve(allow('once'));
    // Answered before any request is recorded: a dead turn must not leave a modal row.
    if (input.signal?.aborted) return Promise.resolve(refusal('expired'));
    if (this.isSessionApproved(input)) return Promise.resolve(allow('session'));

    const approvalId = createId('approval');
    emit.durable({
      type: 'approval/request',
      payload: { approvalId, callId: input.callId, name: input.name, args: input.args, risk: input.risk },
    });
    emit.live({
      type: 'agent/status',
      payload: { state: 'waiting_approval', ...(input.turnId ? { turnId: input.turnId } : {}) },
    });

    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = { input, emit, resolve };
      this.pending.set(approvalId, entry);
      entry.timer = setTimeout(() => this.expire(approvalId), APPROVAL_TIMEOUT_MS);
      entry.timer.unref?.();
      if (input.signal) {
        entry.onAbort = () => this.expire(approvalId);
        input.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
    });
  }

  decide(approvalId: string, decision: 'allow' | 'deny', scope: ApprovalScope): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.close(approvalId, entry);
    entry.emit.durable({ type: 'approval/decision', payload: { approvalId, decision, scope } });
    if (decision === 'allow' && scope === 'session') {
      this.sessionApprovals.add(sessionKey(entry.input.sessionId, entry.input.name));
    }
    entry.resolve({ allowed: decision === 'allow', decision, scope });
    return true;
  }

  /**
   * A session allow suppresses later `ask` *and* `ask-once` requests for that tool name,
   * because the approval modal offers "Cho phép trong phiên" for both. High risk always
   * asks, and only a real allow decision is ever remembered.
   */
  private isSessionApproved(input: ApprovalRequestInput): boolean {
    return input.approval !== 'auto' && input.risk !== 'high'
      && this.sessionApprovals.has(sessionKey(input.sessionId, input.name));
  }

  private expire(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.close(approvalId, entry);
    entry.emit.durable({ type: 'approval/decision', payload: { approvalId, decision: 'expired', scope: 'once' } });
    entry.resolve(refusal('expired'));
  }

  private close(approvalId: string, entry: PendingApproval): void {
    this.pending.delete(approvalId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.onAbort && entry.input.signal) entry.input.signal.removeEventListener('abort', entry.onAbort);
  }
}
