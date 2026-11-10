import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PendingApproval } from '../../lib/chatReducer';
import { ApprovalModal } from './ApprovalModal';

afterEach(() => cleanup());

const approval: PendingApproval = {
    approvalId: 'ap1',
    callId: 'c1',
    name: 'run_command',
    args: { cmd: 'npm test' },
    risk: 'high',
    turnId: 't1',
};

describe('ApprovalModal', () => {
    it('shows the tool, args, risk and all three wire-valid decisions', () => {
        render(<ApprovalModal approval={approval} onDecision={vi.fn()} />);

        expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByText('Cần phê duyệt')).toBeInTheDocument();
        expect(screen.getByText('run_command')).toBeInTheDocument();
        expect(screen.getByText(/npm test/)).toBeInTheDocument();
        expect(screen.getByText('Rủi ro cao')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cho phép một lần' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cho phép trong phiên' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Từ chối' })).toBeInTheDocument();
        // The wire has no "always" scope; shipping that fourth label would be a §6.6.2 lie.
        expect(screen.queryByText(/luôn cho phép/i)).toBeNull();
    });

    it.each([
        ['Cho phép một lần', 'allow', 'once'],
        ['Cho phép trong phiên', 'allow', 'session'],
        ['Từ chối', 'deny', 'once'],
    ] as const)('sends the exact decision/scope triple for %s', (label, decision, scope) => {
        const onDecision = vi.fn();
        render(<ApprovalModal approval={approval} onDecision={onDecision} />);

        fireEvent.click(screen.getByRole('button', { name: label }));

        expect(onDecision).toHaveBeenCalledTimes(1);
        expect(onDecision).toHaveBeenCalledWith('ap1', decision, scope);
    });

    it('pins initial focus to the safe action so Enter and Escape agree', () => {
        // M3: `buttons()[0]?.focus()` chưa từng được đo. Nó là "Từ chối" (nút đầu trong DOM), nên
        // bàn phím Enter không accidentally cho phép chạy tool rủi ro cao.
        render(<ApprovalModal approval={approval} onDecision={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Từ chối' })).toHaveFocus();
    });

    it('treats Escape as deny/once instead of doing nothing', () => {
        // I1: modal ba nút mà phím thoát im lặng nghĩa là bàn phím phải Tab tới "Từ chối".
        const onDecision = vi.fn();
        render(<ApprovalModal approval={approval} onDecision={onDecision} />);

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(onDecision).toHaveBeenCalledTimes(1);
        expect(onDecision).toHaveBeenCalledWith('ap1', 'deny', 'once');
    });

    it('reports every trigger instead of latching, so a failed POST stays retryable', () => {
        // Round 2 đặt chốt một-quyết-trong-modal và làm dialog thành ngõ cụt khi POST lỗi (modal không
        // biết kết quả; `handleApproval` chỉ toast mà không settle). Chống trùng giờ thuộc
        // ChatInterface — xem `collapses repeated approval triggers into one request`. Ở đây chốt
        // CHIỀU NGƯỢC: modal phải báo mọi lần bấm, nếu không thì test kia xanh cả khi modal nuốt input.
        const onDecision = vi.fn();
        render(<ApprovalModal approval={approval} onDecision={onDecision} />);

        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.click(screen.getByRole('button', { name: 'Cho phép một lần' }));

        expect(onDecision).toHaveBeenCalledTimes(3);
        expect(onDecision).toHaveBeenLastCalledWith('ap1', 'allow', 'once');
        expect(onDecision).toHaveBeenNthCalledWith(1, 'ap1', 'deny', 'once');
    });

    it('uses the latest onDecision for Escape without re-running the focus effect', () => {
        // deps của effect là [approval.approvalId] — thêm onDecision vào sẽ giật focus về nút đầu mỗi
        // lần ChatInterface re-render. Ref phải đọc callback của render gần nhất.
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = render(<ApprovalModal approval={approval} onDecision={first} />);
        rerender(<ApprovalModal approval={approval} onDecision={second} />);

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith('ap1', 'deny', 'once');
    });

    it('traps Tab inside the dialog and restores focus on unmount', () => {
        const trigger = document.createElement('button');
        trigger.textContent = 'mở';
        document.body.appendChild(trigger);
        trigger.focus();

        const { unmount } = render(<ApprovalModal approval={approval} onDecision={vi.fn()} />);
        const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
        expect(buttons.length).toBeGreaterThanOrEqual(3);

        buttons[buttons.length - 1].focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(buttons[0]);

        buttons[0].focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(buttons[buttons.length - 1]);

        unmount();
        expect(document.activeElement).toBe(trigger);
        trigger.remove();
    });

    describe('plan review', () => {
        const planApproval: PendingApproval = {
            ...approval,
            name: 'exit_plan_mode',
            risk: 'low',
            args: { plan: '## Kế hoạch A\n\n- Bước một\n- Bước hai' },
        };

        it('renders the named spec card with the full markdown and a single approve action', () => {
            const onDecision = vi.fn();
            render(<ApprovalModal approval={planApproval} onDecision={onDecision} />);

            expect(screen.getByText('Đặc tả đề xuất')).toBeInTheDocument();
            // The heading appears twice on purpose: once as the card title and once inside the rendered
            // markdown. Pin the dialog's accessible name to the card title rather than a loose query.
            const dialog = screen.getByRole('dialog');
            const titleId = dialog.getAttribute('aria-labelledby');
            expect(titleId).toBeTruthy();
            expect(document.getElementById(titleId as string)?.textContent).toBe('Kế hoạch A');
            expect(screen.getByText('Bước một')).toBeInTheDocument();
            // A plan is not a session-wide tool grant: only approve-once and reject exist.
            expect(screen.queryByRole('button', { name: 'Cho phép trong phiên' })).toBeNull();

            fireEvent.click(screen.getByRole('button', { name: 'Duyệt kế hoạch' }));
            expect(onDecision).toHaveBeenCalledWith('ap1', 'allow', 'once');
        });

        it('reveals a reason box on reject and carries the reason with the deny', () => {
            const onDecision = vi.fn();
            render(<ApprovalModal approval={planApproval} onDecision={onDecision} />);

            fireEvent.click(screen.getByRole('button', { name: 'Từ chối' }));
            const reason = screen.getByLabelText('Lý do từ chối (tuỳ chọn)');
            fireEvent.change(reason, { target: { value: 'Thiếu bước kiểm thử' } });
            fireEvent.click(screen.getByRole('button', { name: 'Gửi yêu cầu chỉnh sửa' }));

            expect(onDecision).toHaveBeenCalledWith('ap1', 'deny', 'once', 'Thiếu bước kiểm thử');
        });

        it('closes the reason box on Escape instead of denying the plan', () => {
            const onDecision = vi.fn();
            render(<ApprovalModal approval={planApproval} onDecision={onDecision} />);

            fireEvent.click(screen.getByRole('button', { name: 'Từ chối' }));
            fireEvent.keyDown(document, { key: 'Escape' });

            expect(onDecision).not.toHaveBeenCalled();
            expect(screen.getByRole('button', { name: 'Duyệt kế hoạch' })).toBeInTheDocument();
        });
    });
});
