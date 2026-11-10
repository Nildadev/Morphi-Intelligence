import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatDraft, ChatError, PendingApproval } from '../../lib/chatReducer';
import type { DerivedMessage } from '../../types';
import { ChatView } from './ChatView';

afterEach(() => cleanup());

const emptyDraft: ChatDraft = { turnId: '', key: '', content: '', reasoning: '', steps: [] };

const assistant: DerivedMessage = {
    id: 'a1',
    role: 'assistant',
    content: 'Trả lời',
    steps: [{ type: 'text', content: 'Trả lời' }],
    createdAt: 2,
    superseded: false,
};

const props = {
    messages: [] as DerivedMessage[],
    draft: emptyDraft,
    draftSteps: [],
    hasDraft: false,
    pendingApproval: null as PendingApproval | null,
    error: null as ChatError | null,
    toolProgress: {},
    onRegenerate: vi.fn(),
    onApprovalDecision: vi.fn(),
    onOpenSettings: vi.fn(),
};

describe('ChatView', () => {
    it('renders the durable transcript followed by the live draft', () => {
        render(
            <ChatView
                {...props}
                messages={[assistant]}
                draft={{ ...emptyDraft, turnId: 't2', content: 'Đang viết' }}
                draftSteps={[{ type: 'text', content: 'Đang viết' }]}
                busy
                streaming
                hasDraft
            />,
        );

        const text = document.body.textContent ?? '';
        // M1: `indexOf(a) < indexOf(b)` là assertion rỗng khi một trong hai chuỗi không được render
        // (-1 < 5 luôn đúng) — draft row biến mất thì test vẫn xanh. Chốt hiện diện trước khi so thứ tự.
        expect(text).toContain('Trả lời');
        expect(text).toContain('Đang viết');
        expect(text.indexOf('Trả lời')).toBeLessThan(text.indexOf('Đang viết'));
    });

    it('shows one honest waiting row while a turn runs but nothing has streamed yet', () => {
        render(<ChatView {...props} messages={[assistant]} busy streaming />);

        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('Đang chờ phản hồi…');
        expect(status).toHaveClass('animate-shiny');
        // hasDraft vẫn false → không có draft row giả, nên đúng một dòng trạng thái tồn tại.
        expect(screen.getAllByRole('status')).toHaveLength(1);
    });

    it('hands the live line over to the draft row as soon as content arrives', () => {
        render(
            <ChatView
                {...props}
                messages={[assistant]}
                busy
                streaming
                draft={{ ...emptyDraft, turnId: 't2', content: 'Đang viết' }}
                draftSteps={[{ type: 'text', content: 'Đang viết' }]}
                hasDraft
            />,
        );

        expect(screen.queryByRole('status')).toBeNull();
        expect(document.body.textContent).toContain('Đang viết');
    });

    it('shows no waiting row when nothing is in flight', () => {
        render(<ChatView {...props} messages={[assistant]} />);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('wires a retryable error to regenerate the last assistant row', () => {
        const onRegenerate = vi.fn();
        render(
            <ChatView
                {...props}
                messages={[assistant]}
                error={{ code: 'TURN_TIMEOUT', retryable: true }}
                onRegenerate={onRegenerate}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
        expect(onRegenerate).toHaveBeenCalledWith('a1');
    });

    it('routes NO_PROVIDER to settings instead of a dead retry', () => {
        const onOpenSettings = vi.fn();
        render(
            <ChatView
                {...props}
                messages={[assistant]}
                error={{ code: 'NO_PROVIDER', retryable: false }}
                onOpenSettings={onOpenSettings}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Mở Cài đặt' }));
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
    });

    it('shows a pending approval as a modal and forwards the exact decision', () => {
        const onApprovalDecision = vi.fn();
        render(
            <ChatView
                {...props}
                pendingApproval={{
                    approvalId: 'ap1', callId: 'c1', name: 'run_command',
                    args: { cmd: 'ls' }, risk: 'medium', turnId: 't1',
                }}
                onApprovalDecision={onApprovalDecision}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Cho phép trong phiên' }));
        expect(onApprovalDecision).toHaveBeenCalledWith('ap1', 'allow', 'session');
    });

    // The todo/plan panel moved out of the transcript into the composer (deepseek standing plan):
    // ChatInterface renders it above <Composer/>, so ChatView intentionally no longer shows it.
    it('does not render the todo plan inside the transcript', () => {
        const withTodos: DerivedMessage = {
            id: 'a2',
            role: 'assistant',
            content: '',
            steps: [{
                type: 'call',
                call: {
                    callId: 'c9', name: 'todo_write', args: {}, status: 'done',
                    result: { todos: [{ title: 'Việc một', status: 'done' }] },
                },
            }],
            createdAt: 3,
            superseded: false,
        };

        render(<ChatView {...props} messages={[assistant, withTodos]} />);
        expect(screen.queryByText('Kế hoạch')).toBeNull();
    });

    it('shows a single worked block on the final conclusion, not on each tool row', () => {
        const user: DerivedMessage = { id: 'u1', role: 'user', content: 'Làm giúp', steps: [], createdAt: 1, superseded: false };
        const toolRow: DerivedMessage = {
            id: 'a1', role: 'assistant', content: '', reasoning: 'Suy nghĩ trước tool',
            steps: [{ type: 'call', call: { callId: 'c1', name: 'search_objects', args: {}, status: 'done', durationMs: 9000 } }],
            createdAt: 2, superseded: false,
        };
        const conclusion: DerivedMessage = {
            id: 'a2', role: 'assistant', content: 'Kết luận',
            steps: [{ type: 'text', content: 'Kết luận' }],
            createdAt: 3, superseded: false,
        };

        render(<ChatView {...props} messages={[user, toolRow, conclusion]} />);

        // Exactly one worked header for the whole turn, on the conclusion row.
        const headers = screen.getAllByRole('button', { name: /Đã làm trong/ });
        expect(headers).toHaveLength(1);
        expect(screen.getByText('Kết luận')).toBeInTheDocument();

        fireEvent.click(headers[0]);
        expect(screen.getByText('Tìm object')).toBeInTheDocument();
        // Thinking is a separate collapsed block inside the worked block.
        fireEvent.click(screen.getByRole('button', { name: 'Đã suy nghĩ' }));
        expect(screen.getAllByText((_, node) => node?.textContent === 'Suy nghĩ trước tool').length).toBeGreaterThan(0);
    });

    it('keeps a single working header while the turn is live instead of splitting per step', () => {
        const user: DerivedMessage = { id: 'u1', role: 'user', content: 'Làm giúp', steps: [], createdAt: 1, superseded: false };
        const toolRow: DerivedMessage = {
            id: 'a1', role: 'assistant', content: '', reasoning: 'thinking-1',
            steps: [{ type: 'call', call: { callId: 'c1', name: 'search_objects', args: {}, status: 'running' } }],
            createdAt: 2, superseded: false,
        };
        const conclusion: DerivedMessage = {
            id: 'a2', role: 'assistant', content: 'Kết luận',
            steps: [{ type: 'text', content: 'Kết luận' }],
            createdAt: 3, superseded: false,
        };

        const { rerender } = render(<ChatView {...props} messages={[user, toolRow]} busy streaming />);
        expect(screen.getByRole('button', { name: 'Đang làm việc…' })).toBeInTheDocument();
        expect(screen.queryAllByRole('button', { name: /Đã làm trong/ })).toHaveLength(0);

        const doneToolRow: DerivedMessage = {
            ...toolRow,
            steps: [{ type: 'call', call: { callId: 'c1', name: 'search_objects', args: {}, status: 'done', durationMs: 2000 } }],
        };
        rerender(<ChatView {...props} messages={[user, doneToolRow, conclusion]} />);
        expect(screen.getAllByRole('button', { name: /Đã làm trong/ })).toHaveLength(1);
    });

    it('keeps an interleaved thinking → tool → spoken-text timeline in the worked block', () => {
        const user: DerivedMessage = { id: 'u1', role: 'user', content: 'Làm giúp', steps: [], createdAt: 1, superseded: false };
        const toolRow: DerivedMessage = {
            id: 'a1', role: 'assistant', content: '', reasoning: 'thinking-1',
            steps: [{ type: 'call', call: { callId: 'c1', name: 'search_objects', args: {}, status: 'done', durationMs: 2000 } }],
            createdAt: 2, superseded: false,
        };
        const spokenRow: DerivedMessage = {
            id: 'a2', role: 'assistant', content: 'oh i see',
            steps: [{ type: 'text', content: 'oh i see' }],
            createdAt: 3, superseded: false,
        };
        const conclusion: DerivedMessage = {
            id: 'a3', role: 'assistant', content: 'Kết luận',
            steps: [{ type: 'text', content: 'Kết luận' }],
            createdAt: 4, superseded: false,
        };

        const { container } = render(<ChatView {...props} messages={[user, toolRow, spokenRow, conclusion]} />);

        const headers = screen.getAllByRole('button', { name: /Đã làm trong/ });
        expect(headers).toHaveLength(1);
        fireEvent.click(headers[0]);

        const order = ['Tìm object', 'oh i see', 'Kết luận']
            .map((text) => container.textContent?.indexOf(text) ?? -1);
        expect(order.every((position) => position >= 0)).toBe(true);
        expect(order[0]).toBeLessThan(order[1]);
        expect(order[1]).toBeLessThan(order[2]);
    });

    it('uses the provider-streamed order when a row carries activity', () => {
        const user: DerivedMessage = { id: 'u1', role: 'user', content: 'Làm giúp', steps: [], createdAt: 1, superseded: false };
        const mixedRow: DerivedMessage = {
            id: 'a1',
            role: 'assistant',
            content: 'oh i see',
            reasoning: 'thinking-1',
            steps: [{ type: 'text', content: 'oh i see' }],
            activity: [
                { kind: 'thinking', text: 'thinking-1' },
                { kind: 'call', callId: 'c1' },
                { kind: 'text', text: 'oh i see' },
                { kind: 'thinking', text: 'thinking-2' },
            ],
            createdAt: 2,
            superseded: false,
        };
        mixedRow.steps.push({ type: 'call', call: { callId: 'c1', name: 'search_objects', args: {}, status: 'done', durationMs: 2000 } });
        const conclusion: DerivedMessage = {
            id: 'a2', role: 'assistant', content: 'Kết luận',
            steps: [{ type: 'text', content: 'Kết luận' }],
            createdAt: 3, superseded: false,
        };

        render(<ChatView {...props} messages={[user, mixedRow, conclusion]} />);
        fireEvent.click(screen.getAllByRole('button', { name: /Đã làm trong/ })[0]);

        const order = ['Tìm object', 'oh i see', 'Kết luận']
            .map((text) => document.body.textContent?.indexOf(text) ?? -1);
        expect(order.every((position) => position >= 0)).toBe(true);
        expect(order[0]).toBeLessThan(order[1]);
        expect(order[1]).toBeLessThan(order[2]);
    });
});
