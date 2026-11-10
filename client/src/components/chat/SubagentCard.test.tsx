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
    status: 'done',
    summary: 'Đã tóm tắt được 42 hoá đơn thành bảng.',
    toolCount: 26,
    failedToolCount: 1,
    durationMs: 31_000,
};

describe('SubagentCard', () => {
    it('renders the collapsed card, expands for the summary, and opens the child session', () => {
        const onOpenChildSession = vi.fn();
        const message: DerivedMessage = {
            id: 'm1',
            role: 'assistant',
            content: '',
            steps: [run],
            createdAt: 2,
            superseded: false,
        };
        render(<MessageItem message={message} onOpenChildSession={onOpenChildSession} />);

        expect(screen.getByText('Subagent')).toBeInTheDocument();
        expect(screen.getByText(/Subagent xong · sau 31 giây/)).toBeInTheDocument();
        expect(screen.queryByText('Đã tóm tắt được 42 hoá đơn thành bảng.')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /Subagent xong/ }));
        expect(screen.getByText('Tóm tắt hoá đơn tháng này')).toBeInTheDocument();
        expect(screen.getByText('Đã tóm tắt được 42 hoá đơn thành bảng.')).toBeInTheDocument();
        expect(screen.getByText('Đã chạy 26 tool · 1 trong đó lỗi')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Mở phiên con' }));
        expect(onOpenChildSession).toHaveBeenCalledWith('sess_child');
    });

    it('keeps an errored run from claiming a clean outcome', () => {
        const message: DerivedMessage = {
            id: 'm2',
            role: 'assistant',
            content: '',
            steps: [{ ...run, status: 'error', summary: 'Lỗi mạng', durationMs: 21_000 }],
            createdAt: 3,
            superseded: false,
        };
        render(<MessageItem message={message} />);

        expect(screen.getByText(/Subagent thất bại · sau 21 giây/)).toBeInTheDocument();
        expect(screen.queryByText(/Subagent xong/)).toBeNull();
    });
});
