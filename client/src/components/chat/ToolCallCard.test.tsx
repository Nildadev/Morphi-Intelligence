import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DerivedToolCall } from '../../types';
import { MAX_TOOL_OUTPUT_CHARS, ToolCallCard } from './ToolCallCard';

afterEach(() => cleanup());

const call = (overrides: Partial<DerivedToolCall> = {}): DerivedToolCall => ({
    callId: 'c1',
    name: 'read_file',
    args: { path: 'src/a.ts' },
    status: 'done',
    result: 'nội dung',
    durationMs: 12,
    ...overrides,
});

describe('ToolCallCard', () => {
    it.each([
        ['running', 'Đang chạy'],
        ['done', 'Hoàn tất'],
        ['error', 'Lỗi'],
        ['cancelled', 'Đã huỷ'],
    ] as const)('renders the %s status as its Vietnamese label', (status, label) => {
        render(<ToolCallCard call={call({ status })} />);
        expect(screen.getByText(label)).toBeInTheDocument();
    });

    it('maps the tool name to a Vietnamese label and keeps the raw name in monospace', () => {
        render(<ToolCallCard call={call()} />);
        expect(screen.getByText('Đọc tệp')).toBeInTheDocument();
        expect(screen.getByText('read_file')).toHaveClass('font-mono');
    });

    it('prefers the label the server measured over the client map', () => {
        // Task 31B's policy table knows `studio.get_studio_state` is "Đọc trạng thái Studio"; the
        // client map never had 35 Studio entries and never should.
        render(<ToolCallCard call={call({ name: 'studio.get_studio_state', args: {}, label: 'Đọc trạng thái Studio' })} />);
        expect(screen.getByText('Đọc trạng thái Studio')).toBeInTheDocument();
        expect(screen.queryByText(/Tool studio/)).toBeNull();
    });

    it('falls back to the client map when a persisted call predates the label field', () => {
        render(<ToolCallCard call={call()} />);
        expect(screen.getByText('Đọc tệp')).toBeInTheDocument();
    });

    it('expands args and result from an inset surface', () => {
        render(<ToolCallCard call={call()} />);

        expect(screen.queryByText(/src\/a\.ts/)).toBeNull();
        fireEvent.click(screen.getByRole('button'));

        expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument();
        expect(screen.getByText('nội dung')).toBeInTheDocument();
    });

    it('shows a live progress line only while the call is still running', () => {
        const { rerender } = render(<ToolCallCard call={call({ status: 'running', result: undefined })} progress="đang đọc tệp" />);
        expect(screen.getByText(/đang đọc tệp/)).toBeInTheDocument();

        rerender(<ToolCallCard call={call({ status: 'done' })} progress="đang đọc tệp" />);
        expect(screen.queryByText('đang đọc tệp')).toBeNull();
    });

    it('marks a 50k string result as truncated and leaves 49,999 characters unmarked', () => {
        expect(MAX_TOOL_OUTPUT_CHARS).toBe(50_000);
        const below = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS - 1);
        const atCap = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS);

        const { rerender } = render(<ToolCallCard call={call({ result: below })} />);
        fireEvent.click(screen.getByRole('button'));
        expect(screen.queryByText(/cắt bớt/i)).toBeNull();

        rerender(<ToolCallCard call={call({ result: atCap })} />);
        expect(screen.getByText(/cắt bớt/i)).toBeInTheDocument();
    });

    it('renders an approval step as the same card body with a shield and its decision state', () => {
        render(
            <ToolCallCard
                approval={{
                    approvalId: 'ap1',
                    callId: 'c1',
                    name: 'run_command',
                    args: { cmd: 'ls' },
                    risk: 'high',
                    decision: 'allow',
                }}
            />,
        );

        expect(screen.getByText('Yêu cầu phê duyệt')).toBeInTheDocument();
        expect(screen.getByText('Đã cho phép')).toBeInTheDocument();
    });

    describe('edit calls render as the file change, not as a parameter dump', () => {
        const editCall = (over: Partial<DerivedToolCall> = {}) => call({
            name: 'studio.edit_script',
            args: {
                path: 'src/ReplicatedStorage/Config.lua',
                old: 'return {}\n',
                source: 'return {\n  speed = 16,\n  jump = 50,\n}\n',
            },
            result: { ok: true },
            ...over,
        });

        it('shows the path and the churn in the header, always visible (no click needed)', () => {
            render(<ToolCallCard call={editCall()} />);

            expect(screen.getByText('src/ReplicatedStorage/Config.lua')).toBeInTheDocument();
            expect(screen.getByText('+4')).toBeInTheDocument();
            expect(screen.getByText('−1')).toBeInTheDocument();
        });

        it('shows the diff rows themselves — the added lines are readable without expanding', () => {
            render(<ToolCallCard call={editCall()} />);

            expect(screen.getByText('speed = 16,')).toBeInTheDocument();
            expect(screen.getByText('jump = 50,')).toBeInTheDocument();
        });

        it('does NOT dump the tool arguments — the diff is the payload', () => {
            render(<ToolCallCard call={editCall()} />);

            // The old card printed an args JSON block; the source text appearing as a raw blob is
            // exactly what this change removes. `path` may appear in the header, never as a label.
            expect(screen.queryByText('Tham số')).toBeNull();
            expect(screen.queryByText('Kết quả')).toBeNull();
            expect(screen.queryByText(/"old":/)).toBeNull();
        });

        it('keeps the non-edit tools on the compact card with args and result', () => {
            // The change is scoped: a read call still needs its parameters to be inspectable.
            render(<ToolCallCard call={call()} />);
            fireEvent.click(screen.getByRole('button'));
            expect(screen.getByText('Tham số')).toBeInTheDocument();
            expect(screen.getByText('Kết quả')).toBeInTheDocument();
        });
    });
});
