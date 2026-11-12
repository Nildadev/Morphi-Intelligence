import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, ShieldAlert, TriangleAlert } from '../icons';
import type { PendingApproval } from '../../lib/chatReducer';
import { vi } from '../../i18n/vi';
import { Markdown } from './Markdown';

export interface ApprovalModalProps {
    approval: PendingApproval;
    /** Exact wire mapping: allow/once, allow/session, deny/once. The server owns the session allow.
     * `feedback` rides along only for a plan rejection: the parent steers it as the revision request. */
    onDecision: (approvalId: string, decision: 'allow' | 'deny', scope: 'once' | 'session', feedback?: string) => void;
}

function riskLabel(risk: PendingApproval['risk']): string {
    return { low: vi.approval.riskLow, medium: vi.approval.riskMedium, high: vi.approval.riskHigh }[risk];
}

const RISK_CLASS: Record<PendingApproval['risk'], string> = {
    low: 'bg-success-bg text-success-text',
    medium: 'bg-warning-bg text-warning-text',
    high: 'bg-danger-bg text-danger-text',
};

const formatArgs = (args: unknown): string => {
    if (typeof args === 'string') return args;
    try {
        return JSON.stringify(args, null, 2) ?? String(args);
    } catch {
        return String(args);
    }
};

/**
 * Focus-trapped approval dialog (brief Step 4). It replaces the inline banner so
 * `chat.pendingApproval` has one rendering source. Exactly three buttons exist because the wire
 * only has `once`/`session`; "Luôn cho phép" would be a §6.6.2 lie.
 *
 * Initial focus is the deny button (first in DOM order), so Enter and Escape both resolve to the
 * safe action; Tab wraps inside the dialog and focus returns to the opener on unmount.
 */
export function ApprovalModal({ approval, onDecision }: ApprovalModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    // Plan review is a different surface (deepseek spec review): full markdown, one Approve and one
    // Reject that reveals a reason box. The reason is steered back as the revision request.
    const plan = approval.name === 'exit_plan_mode' && typeof (approval.args as { plan?: unknown } | null)?.plan === 'string'
        ? String((approval.args as { plan: string }).plan)
        : null;
    const planHeading = plan?.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const reasonRef = useRef<HTMLTextAreaElement>(null);
    const rejectingRef = useRef(false);
    useEffect(() => {
        rejectingRef.current = rejecting;
        if (rejecting) reasonRef.current?.focus();
    }, [rejecting]);
    // Escape phải gọi được onDecision HIỆN TẠI mà không đưa nó vào deps: deps `[approval.approvalId]`
    // là chủ ý, nếu thêm onDecision (ChatInterface truyền arrow mới mỗi render) thì effect chạy lại
    // từng lần re-render và `buttons()[0].focus()` giật focus về nút đầu khi user đang Tab.
    const decideRef = useRef(onDecision);
    // Ghi ref trong body là side-effect ở render phase (StrictMode double-render gán lại, và một render
    // bị bỏ có thể để lại callback chưa từng commit) — effect không deps chạy SAU mỗi render nên vẫn giữ
    // đúng tính chất "luôn là callback mới nhất" mà không touched render phase.
    useEffect(() => {
        decideRef.current = onDecision;
    });
    // Round 2 từng đặt chốt "một quyết định / approval" NGAY TRONG MODAL và round 2 của reviewer
    // chứng minh nó là ngõ cụt: modal không biết POST thành bại, còn `handleApproval` bên cha chỉ toast
    // khi lỗi mà không settle (`ChatInterface.tsx:452` dispatch frame chỉ khi thành công, `:453-454` catch
    // → showToast), nên một lần lỗi là ba nút + Escape tê liệt cho tới
    // `APPROVAL_TIMEOUT_MS = 120_000`. Chống trùng là việc của CHỦ REQUEST (người thấy kết quả),
    // xem `decidingRef` trong ChatInterface; modal chỉ là mặt input nên mọi lần bấm đều báo về.
    // Memoised on the approval id only: the body reads the latest callback through `decideRef`, so this
    // identity is stable for the whole life of one approval. That keeps the Escape/focus effect below
    // from re-running on every parent re-render (which pulled focus back to the first button) while
    // still letting `decide` be a real dependency instead of a closure the linter cannot verify.
    const decide = useCallback(
        (decision: 'allow' | 'deny', scope: 'once' | 'session', feedback?: string) =>
            // Keep the legacy 3-argument call shape unless there is real feedback to carry; callers and
            // tests pin the exact wire triple, not an extra `undefined`.
            feedback === undefined
                ? decideRef.current(approval.approvalId, decision, scope)
                : decideRef.current(approval.approvalId, decision, scope, feedback),
        [approval.approvalId],
    );
    const titleId = `approval-title-${approval.approvalId}`;

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const buttons = () =>
            Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);

        buttons()[0]?.focus();

        const onKeyDown = (event: KeyboardEvent) => {
            // I1: Escape phải có nghĩa. Modal từ chối là "cửa thoát" hiển nhiên, và nó khớp với nút
            // đã được focus lúc mở (an toàn nhất) — Enter và Escape cho ra cùng một kết quả.
            // `decide` mà handler này nắm là bản của render gần nhất mà effect chạy (deps = approvalId ở
            // `:103`), và thân nó chỉ đọc `decideRef.current` — ref luôn mang callback mới nhất (`:50-52`) —
            // nên không có khác biệt hành vi so với bản mới nhất. Escape đi qua `decide` thay vì gọi thẳng
            // `decideRef.current` để ba nút và Escape dùng ĐÚNG MỘT đường: chống trùng ở chủ request,
            // không nhân bản logic ở hai chỗ.
            if (event.key === 'Escape') {
                event.preventDefault();
                // While the plan rejection box is open, Escape closes the box (and keeps the plan on
                // screen) instead of denying the plan outright.
                if (rejectingRef.current) {
                    setRejecting(false);
                    return;
                }
                decide('deny', 'once');
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = buttons();
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previous?.focus();
        };
    }, [approval.approvalId, decide]);

    if (plan !== null) {
        return (
            <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
                <div aria-hidden="true" className="absolute inset-0 bg-scrim-soft" />
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-card shadow-premium"
                >
                    <div className="flex items-start gap-3 border-b border-border px-5 py-4">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand-text">
                            <FileText aria-hidden="true" size={20} />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                                {vi.approval.planTitle}
                            </p>
                            <h2 id={titleId} className="truncate text-[17px] font-semibold text-text-primary">
                                {planHeading ?? vi.approval.planTitle}
                            </h2>
                        </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto sidebar-scrollbar px-5 py-4">
                        <Markdown>{plan}</Markdown>
                    </div>

                    <div className="border-t border-border px-5 py-4">
                        {rejecting ? (
                            <div className="space-y-2">
                                <label htmlFor={`plan-reason-${approval.approvalId}`} className="block text-[13px] font-medium text-text-primary">
                                    {vi.approval.planRejectReason}
                                </label>
                                <textarea
                                    id={`plan-reason-${approval.approvalId}`}
                                    ref={reasonRef}
                                    value={reason}
                                    onChange={(event) => setReason(event.target.value)}
                                    rows={3}
                                    placeholder={vi.approval.planRejectPlaceholder}
                                    className="w-full resize-y rounded-xl border border-border bg-bg-inset px-3 py-2 text-[13px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary focus:border-brand"
                                />
                                <div className="flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => { setRejecting(false); setReason(''); }}
                                        className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                                    >
                                        {vi.approval.planCancelReject}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => decide('deny', 'once', reason.trim() || undefined)}
                                        className="rounded-xl border border-danger-text px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg"
                                    >
                                        {vi.approval.planRevise}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={() => setRejecting(true)}
                                    className="rounded-xl border border-danger-text px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg"
                                >
                                    {vi.approval.planReject}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => decide('allow', 'once')}
                                    className="btn-primary text-sm"
                                >
                                    {vi.approval.planApprove}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
            <div aria-hidden="true" className="absolute inset-0 bg-scrim-soft" />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="relative w-full max-w-lg rounded-2xl border border-border bg-bg-card p-6 shadow-premium"
            >
                <div className="mb-4 flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-bg text-danger-text">
                        <ShieldAlert aria-hidden="true" size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-[17px] font-semibold text-text-primary">
                            {vi.approval.title}
                        </h2>
                        <p className="mt-1 font-mono text-[13px] text-text-tertiary">{approval.name}</p>
                    </div>
                    <span className={`shrink-0 rounded-md px-2 py-1 text-[12px] font-semibold ${RISK_CLASS[approval.risk]}`}>
                        {riskLabel(approval.risk)}
                    </span>
                </div>

                <div className="mb-4">
                    <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
                        {vi.chat.args}
                    </div>
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-inset p-3 font-mono text-[12px] leading-relaxed text-text-primary">
                        {formatArgs(approval.args)}
                    </pre>
                </div>

                <p className="mb-5 flex items-start gap-2 text-[13px] leading-relaxed text-text-secondary">
                    <TriangleAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-warning-text" />
                    <span>{vi.chat.approvalWarning}</span>
                </p>

                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <button
                        type="button"
                        onClick={() => decide('deny', 'once')}
                        className="rounded-xl border border-danger-text px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg"
                    >
                        {vi.approval.deny}
                    </button>
                    <button
                        type="button"
                        onClick={() => decide('allow', 'session')}
                        className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                    >
                        {vi.approval.allowSession}
                    </button>
                    <button
                        type="button"
                        onClick={() => decide('allow', 'once')}
                        className="btn-primary text-sm"
                    >
                        {vi.approval.allowOnce}
                    </button>
                </div>
            </div>
        </div>
    );
}
