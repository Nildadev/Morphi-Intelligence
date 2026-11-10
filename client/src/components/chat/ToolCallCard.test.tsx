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

    it('shows the primary argument on the row and expands the JSON body on demand', () => {
        render(<ToolCallCard call={call()} />);

        // The row itself carries the argument summary (that is what tells two calls apart)...
        expect(screen.getByText('src/a.ts')).toHaveClass('font-mono');
        // ...while the structured body stays collapsed.
        expect(screen.queryByText('Tham số')).toBeNull();
        fireEvent.click(screen.getByRole('button'));

        expect(screen.getByText('Tham số')).toBeInTheDocument();
        expect(screen.getByText('Kết quả')).toBeInTheDocument();
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

    describe('edit calls own their diff, collapsed by default', () => {
        const editCall = (over: Partial<DerivedToolCall> = {}) => call({
            name: 'studio.edit_script',
            args: {
                path: 'ReplicatedStorage/Config',
                old: 'return {}\n',
                source: 'return {\n  speed = 16,\n  jump = 50,\n}\n',
            },
            result: { ok: true },
            ...over,
        });

        it('shows the tool label, path and churn in one row (no click needed)', () => {
            render(<ToolCallCard call={editCall()} />);

            expect(screen.getByText('Dùng tool studio.edit script')).toBeInTheDocument();
            expect(screen.getByText('ReplicatedStorage/Config')).toBeInTheDocument();
            expect(screen.getByText('+4')).toBeInTheDocument();
            expect(screen.getByText('−1')).toBeInTheDocument();
            expect(screen.getByText('Hoàn tất')).toBeInTheDocument();
        });

        it('starts collapsed with no diff rows, then expands into the hunks', () => {
            const { container } = render(<ToolCallCard call={editCall()} />);

            const trigger = screen.getByRole('button');
            expect(trigger).toHaveAttribute('aria-expanded', 'false');
            expect(container.querySelector('[data-diff-kind]')).toBeNull();
            expect(screen.queryByText('speed = 16,')).toBeNull();

            fireEvent.click(trigger);

            expect(trigger).toHaveAttribute('aria-expanded', 'true');
            expect(container.querySelectorAll('[data-diff-kind]').length).toBeGreaterThan(0);
            expect(screen.getByText('speed = 16,')).toBeInTheDocument();
            expect(screen.getByText('jump = 50,')).toBeInTheDocument();
            // The removed original is present too, not just the new source.
            expect(screen.getByText('return {}')).toBeInTheDocument();
        });

        it('renders one diff section per script for a multi_edit', () => {
            const { container } = render(
                <ToolCallCard
                    call={call({
                        name: 'studio.multi_edit',
                        args: {
                            edits: [
                                { path: 'ServerScriptService/Combat', old: '', source: 'local a = 1' },
                                { path: 'ReplicatedStorage/Config', old: 'x', source: 'x\ny' },
                            ],
                        },
                        result: { ok: true },
                    })}
                />,
            );

            fireEvent.click(screen.getByRole('button'));

            // Two path headers, one per script...
            const headers = [...container.querySelectorAll('[title]')]
                .filter((node) => node.getAttribute('title') === 'ServerScriptService/Combat'
                    || node.getAttribute('title') === 'ReplicatedStorage/Config');
            expect(headers).toHaveLength(2);
            // ...and each has its own DiffBody (hunk rows grouped in one scroll container each).
            expect(container.querySelectorAll('[data-diff-kind]').length).toBeGreaterThanOrEqual(3);
            expect(screen.getByText('local a = 1')).toBeInTheDocument();
            expect(screen.getByText('x')).toBeInTheDocument();
            expect(screen.getByText('y')).toBeInTheDocument();
        });

        it('does NOT dump the tool arguments as JSON', () => {
            render(<ToolCallCard call={editCall()} />);
            fireEvent.click(screen.getByRole('button'));

            expect(screen.queryByText('Tham số')).toBeNull();
            expect(screen.queryByText('Kết quả')).toBeNull();
            expect(screen.queryByText(/"old":/)).toBeNull();
        });

        it('shows the target path while the call is still running', () => {
            // The args stream before the result, so the process row is useful during the turn.
            render(<ToolCallCard call={editCall({ status: 'running', result: undefined })} />);

            expect(screen.getByText('ReplicatedStorage/Config')).toBeInTheDocument();
            expect(screen.getByText('Đang chạy')).toBeInTheDocument();
        });

        it('keeps the non-edit tools on the compact card with args and result', () => {
            // The change is scoped: a read call still needs its parameters to be inspectable.
            render(<ToolCallCard call={call()} />);
            fireEvent.click(screen.getByRole('button'));
            expect(screen.getByText('Tham số')).toBeInTheDocument();
            expect(screen.getByText('Kết quả')).toBeInTheDocument();
        });
    });

    describe('transcript chrome: borderless rows, quote-block expansion', () => {
        it('draws no card border or filled surface around a non-edit tool row', () => {
            const { container } = render(<ToolCallCard call={call()} />);
            const row = screen.getByRole('button');

            // The row itself is on the page background: no border/rounded/card classes.
            expect(row.className).not.toMatch(/rounded|border|bg-bg-card/);
            const outer = container.firstElementChild as HTMLElement;
            expect(outer.className).not.toMatch(/rounded|border|bg-bg-card/);
            // Dense row (~28px) with a bold label and the detail in monospace.
            expect(row).toHaveClass('h-7');
            expect(screen.getByText('Đọc tệp')).toHaveClass('font-semibold');
            expect(screen.getByText('read_file')).toHaveClass('font-mono');
            expect(row).toHaveAttribute('aria-expanded', 'false');
        });

        it('expands args/result inside a left-bordered quote block with no fill', () => {
            render(<ToolCallCard call={call()} />);
            fireEvent.click(screen.getByRole('button'));

            const body = screen.getByText('Tham số').parentElement?.parentElement as HTMLElement;
            expect(body).toHaveClass('border-l');
            expect(body).toHaveClass('border-border');
            expect(body).toHaveClass('pl-3');
            expect(body.className).not.toMatch(/rounded|bg-bg-card|bg-bg-inset/);
            // The raw JSON keeps no filled surface of its own either.
            const pre = screen.getByText(/"path": "src\/a\.ts"/);
            expect(pre.className).not.toMatch(/rounded|bg-bg-inset/);
        });

        it('keeps a subtle card on the approval variant, the one permission-gate exception', () => {
            const { container } = render(
                <ToolCallCard
                    approval={{
                        approvalId: 'ap1',
                        callId: 'c1',
                        name: 'run_command',
                        args: { cmd: 'ls' },
                        risk: 'high',
                    }}
                />,
            );

            const card = container.firstElementChild as HTMLElement;
            expect(card).toHaveClass('rounded-lg');
            expect(card).toHaveClass('border');
            expect(card).toHaveClass('bg-bg-card');
        });
    });
});
