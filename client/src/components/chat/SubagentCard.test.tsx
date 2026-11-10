import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import type { DerivedMessage } from '../../types';

afterEach(() => cleanup());

const run: Extract<DerivedMessage['steps'][number], { type: 'subagent' }> = {
    type: 'subagent',
    subagentId: 'sub_1',
    task: 'Tóm tắt hoá đơn tháng này',
    childSessionId: 'sess_child',
    status: 'running',
    summary: null,
    toolCount: 0,
    failedToolCount: 0,
    durationMs: 0,
};

const messageWith = (step: typeof run): DerivedMessage => ({
    id: 'm1',
    role: 'assistant',
    content: '',
    steps: [step],
    createdAt: 2,
    superseded: false,
});

describe('SubagentCard', () => {
    it('renders one borderless row: SubAgent, the agent name in blue, the task and a chevron', () => {
        const onOpenChildSession = vi.fn();
        render(<MessageItem message={messageWith(run)} onOpenChildSession={onOpenChildSession} />);

        const row = screen.getByRole('button', { name: /SubAgent general-purpose/ });
        expect(row).toHaveTextContent('SubAgent');
        expect(row).toHaveTextContent('general-purpose');
        expect(row).toHaveTextContent('Tóm tắt hoá đơn tháng này');
        // No card chrome: no border, no rounded card, no filled surface on the row itself.
        expect(row.className).not.toMatch(/rounded|border|bg-bg-card/);

        const agentName = screen.getByText('general-purpose');
        expect(agentName).toHaveClass('text-brand-text');
    });

    it('opens the child session on click without expanding anything inline', () => {
        const onOpenChildSession = vi.fn();
        render(<MessageItem message={messageWith(run)} onOpenChildSession={onOpenChildSession} />);

        fireEvent.click(screen.getByRole('button', { name: /SubAgent general-purpose/ }));
        expect(onOpenChildSession).toHaveBeenCalledWith('sess_child');
        // The row is a door, not an expander: no inline summary and no aria-expanded.
        expect(screen.queryByText('Đã tóm tắt được 42 hoá đơn thành bảng.')).toBeNull();
        expect(screen.getByRole('button', { name: /SubAgent general-purpose/ })).not.toHaveAttribute('aria-expanded');
    });

    it('marks a running child with a spinner and a finished one with its outcome', () => {
        const { rerender } = render(<MessageItem message={messageWith(run)} />);
        const runningRow = screen.getByRole('button', { name: /SubAgent general-purpose/ });
        expect(runningRow.querySelector('.animate-spin')).not.toBeNull();

        rerender(<MessageItem message={messageWith({ ...run, status: 'done' })} />);
        expect(screen.queryByRole('button', { name: /SubAgent general-purpose/ })?.querySelector('.animate-spin')).toBeNull();

        rerender(<MessageItem message={messageWith({ ...run, status: 'error' })} />);
        expect(screen.getByText('Subagent thất bại')).toBeInTheDocument();
    });
});
