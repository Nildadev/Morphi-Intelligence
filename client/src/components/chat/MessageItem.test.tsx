import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DerivedMessage } from '../../types';
import { MessageItem } from './MessageItem';

afterEach(() => cleanup());

const userMessage = (content = 'Xin chào'): DerivedMessage => ({
    id: 'u1',
    role: 'user',
    content,
    steps: [],
    createdAt: 1,
    superseded: false,
});

const assistantMessage = (overrides: Partial<DerivedMessage> = {}): DerivedMessage => ({
    id: 'a1',
    role: 'assistant',
    content: 'Nội dung duy nhất',
    steps: [{ type: 'text', content: '**Nội dung duy nhất**' }],
    createdAt: 2,
    superseded: false,
    ...overrides,
});

describe('MessageItem', () => {
    it('renders a user message right-aligned in the tinted 18px bubble', () => {
        render(<MessageItem message={userMessage()} />);

        const text = screen.getByText('Xin chào');
        expect(text.closest('.bg-bg-inset')).not.toBeNull();
        expect(text.closest('.items-end')).not.toBeNull();
    });

    it('offers undo under a user message', () => {
        const onUndo = vi.fn();
        render(<MessageItem message={userMessage()} onUndo={onUndo} />);

        fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
        expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it('keeps action buttons hidden until hover or keyboard focus', () => {
        const onRegenerate = vi.fn();
        render(<MessageItem message={assistantMessage()} onRegenerate={onRegenerate} />);

        // Hidden-by-opacity, not display:none: the buttons stay in the tab order and the
        // accessibility tree even before the first hover.
        const copy = screen.getByRole('button', { name: 'Sao chép câu trả lời' });
        const footer = copy.closest('footer');
        expect(footer).not.toBeNull();
        expect(footer).toHaveClass('opacity-0');
        expect(footer).toHaveClass('group-hover:opacity-100');
        expect(footer).toHaveClass('group-focus-within:opacity-100');
        expect(footer).toHaveClass('pointer-coarse:opacity-100');
        expect(screen.getByRole('button', { name: 'Tạo lại câu trả lời' })).toBeInTheDocument();
    });

    it('renders assistant text from steps only, never content a second time', () => {
        render(<MessageItem message={assistantMessage()} />);

        expect(screen.getAllByText('Nội dung duy nhất')).toHaveLength(1);
        expect(document.querySelector('strong')).toHaveTextContent('Nội dung duy nhất');
        // Ruling U4 drops the planned avatar: the installed app renders none.
        expect(screen.queryByText('M')).toBeNull();
    });

    it('never renders a token footer, even when usage is present', () => {
        const { rerender } = render(<MessageItem message={assistantMessage()} />);
        expect(screen.queryByText(/token/i)).toBeNull();

        rerender(
            <MessageItem
                message={assistantMessage({
                    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
                })}
            />,
        );
        // The token footer was removed from the assistant row on purpose.
        expect(screen.queryByText(/token/i)).toBeNull();
    });

    it('keeps thinking collapsed by default and offers regenerate only when wired', () => {
        const onRegenerate = vi.fn();
        const { rerender } = render(
            <MessageItem message={assistantMessage({ reasoning: 'Suy nghĩ kín' })} onRegenerate={onRegenerate} />,
        );

        // Merged activity section: collapsed by default, expands on click (deepseek shape).
        expect(screen.queryByText('Suy nghĩ kín')).toBeNull();
        expect(screen.getByText('Đã suy nghĩ')).toBeInTheDocument();
        fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]);
        // Reasoning is split into per-word spans, so match on any block whose text content is it.
        expect(screen.getAllByText((_, node) => node?.textContent === 'Suy nghĩ kín').length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Tạo lại câu trả lời' }));
        expect(onRegenerate).toHaveBeenCalledTimes(1);

        rerender(<MessageItem message={assistantMessage({ reasoning: 'Suy nghĩ kín' })} />);
        expect(screen.queryByRole('button', { name: 'Tạo lại câu trả lời' })).toBeNull();
    });

    it('streams plain text with no animation spans', () => {
        const { rerender, container } = render(
            <MessageItem
                message={assistantMessage({ content: 'xin chào bạn', steps: [{ type: 'text', content: 'xin chào bạn' }] })}
                isStreaming
            />,
        );

        expect(container.querySelectorAll('span.stream-word')).toHaveLength(0);
        expect(container.textContent).toContain('xin chào bạn');

        rerender(
            <MessageItem
                message={assistantMessage({ content: '**xin chào bạn**', steps: [{ type: 'text', content: '**xin chào bạn**' }] })}
            />,
        );
        // The durable row takes over the live DOM — still plain text, markdown intact.
        expect(container.querySelectorAll('span.stream-word')).toHaveLength(0);
        expect(container.querySelector('strong')).toHaveTextContent('xin chào bạn');
    });

    it('streams plain text as the content grows', () => {
        const renderWith = (content: string) => (
            <MessageItem
                message={assistantMessage({ content, steps: [{ type: 'text', content }] })}
                isStreaming
            />
        );
        const { container, rerender } = render(renderWith('xin chào'));
        expect(container.textContent).toContain('xin chào');

        rerender(renderWith('xin chào bạn'));

        expect(container.textContent).toContain('xin chào bạn');
        expect(container.querySelectorAll('span.stream-word')).toHaveLength(0);
    });

    it('keeps markdown structure live while streaming', () => {
        const { container } = render(
            <MessageItem
                message={assistantMessage({
                    content: '**xin chào** bạn\n\n- một\n- hai',
                    steps: [{ type: 'text', content: '**xin chào** bạn\n\n- một\n- hai' }],
                })}
                isStreaming
            />,
        );

        // Formatting is alive mid-stream (not a plain-text fallback).
        expect(container.querySelector('strong')).toHaveTextContent('xin chào');
        expect(container.querySelectorAll('li')).toHaveLength(2);
        expect(container.textContent).toContain('xin chào bạn');
    });

    it('collapses the worked block once settled and reveals tools only after expanding', () => {
        render(
            <MessageItem
                message={assistantMessage({
                    content: '',
                    steps: [
                        {
                            type: 'call',
                            call: {
                                callId: 'c1', name: 'search_objects', args: {}, status: 'done',
                                durationMs: 9000,
                            },
                        },
                    ],
                })}
            />,
        );

        const header = screen.getByRole('button', { name: 'Đã làm trong 9s' });
        expect(header).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('Tìm object')).toBeNull();

        fireEvent.click(header);

        expect(screen.getByText('Tìm object')).toBeInTheDocument();
        expect(screen.getByText('Hoàn tất')).toBeInTheDocument();
    });

    it('keeps thinking as its own collapsible inside the worked block, not merged with the tools', () => {
        const steps: DerivedMessage['steps'] = [
            { type: 'call', call: { callId: 'c1', name: 'search_objects', args: {}, status: 'done', durationMs: 9000 } },
        ];
        const { rerender } = render(
            <MessageItem message={assistantMessage({ content: '', reasoning: 'Suy nghĩ kín', steps })} isStreaming />,
        );

        // While streaming the worked block stays open and the thinking row reads as live.
        expect(screen.getByRole('button', { name: 'Đang làm việc…' })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'Đang suy nghĩ…' })).toBeInTheDocument();

        rerender(<MessageItem message={assistantMessage({ content: 'x', reasoning: 'Suy nghĩ kín', steps })} />);

        // Settled: the outer block collapses to the Codex-style worked header.
        const header = screen.getByRole('button', { name: 'Đã làm trong 9s' });
        expect(header).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(header);

        // Thinking is a separate collapsed block beside the tool card, never a merged body.
        const thinking = screen.getByRole('button', { name: 'Đã suy nghĩ' });
        expect(thinking).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByText('Tìm object')).toBeInTheDocument();
        expect(screen.queryByText('Suy nghĩ kín')).toBeNull();

        fireEvent.click(thinking);
        expect(screen.getAllByText((_, node) => node?.textContent === 'Suy nghĩ kín').length).toBeGreaterThan(0);
    });

    it('renders a reasoning-only turn as a single thinking block without a worked wrapper', () => {
        render(<MessageItem message={assistantMessage({ reasoning: 'Suy nghĩ kín' })} />);

        expect(screen.queryByText(/Đã làm trong/)).toBeNull();
        expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(1);
    });

    it('names every footer/code button in Vietnamese, and the visible label sits inside the name', () => {
        // I2 + WCAG 2.5.3: bản cũ là `aria-label="Copy code"` cạnh chữ "Sao chép" — trình đọc màn
        // hình thông báo một cái tên không có ký tự nào in trên nút.
        render(<MessageItem message={assistantMessage({ steps: [{ type: 'text', content: '```ts\nconst x = 1;\n```' }] })} />);

        expect(screen.getByRole('button', { name: 'Sao chép câu trả lời' })).toBeInTheDocument();
        const codeButton = screen.getByRole('button', { name: 'Sao chép code' });
        expect(codeButton).toHaveAccessibleName('Sao chép code');
        // Nhãn nhìn thấy của nút code là "Sao chép" — phải là một phần của accessible name.
        expect(within(codeButton).getByText('Sao chép')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /copy|regenerate/i })).toBeNull();
    });

    it('renders fenced code with syntax highlighting and a working copy affordance', () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });

        render(
            <MessageItem
                message={assistantMessage({
                    content: '```ts\nconst x = 1;\n```',
                    steps: [{ type: 'text', content: '```ts\nconst x = 1;\n```' }],
                })}
            />,
        );

        expect(screen.getByText('ts')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Sao chép code' }));
        expect(writeText).toHaveBeenCalledWith('const x = 1;');
    });

    it('keeps the copied-state accessible name containing its visible label', async () => {
        // New breakage #6 (round 1): nhãn lật thành 'Đã sao chép' nhưng tên vẫn 'Sao chép code' ⇒ 2.5.3
        // tái phát đúng trạng thái transient mà I2 vừa đóng.
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
        render(<MessageItem message={assistantMessage({ steps: [{ type: 'text', content: '```ts\nconst x = 1;\n```' }] })} />);

        fireEvent.click(screen.getByRole('button', { name: 'Sao chép code' }));

        // `copied` chỉ bật SAU khi promise clipboard resolve, nên phải await — đọc ngay thì tên vẫn là
        // 'Sao chép code' (lỗi này chỉ hiện khi chạy cả suite, không hiện khi chạy một mình).
        const copied = await screen.findByRole('button', { name: 'Đã sao chép code' });
        expect(within(copied).getByText('Đã sao chép')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Sao chép code' })).toBeNull();
    });

    it('paints the fenced block on the dark code surface, never on a light chat surface', () => {
        // C1: chữ #d4d4d4 của vscDarkPlus đặt trên --bg-inset/--bg-sidebar (1.34:1 / 1.41:1) là lỗi
        // tương phản nặng nhất của round trước. Nguồn sơn nền duy nhất là token --code-surface.
        const { container } = render(
            <MessageItem
                message={assistantMessage({
                    content: '```ts\nconst x = 1;\n```',
                    steps: [{ type: 'text', content: '```ts\nconst x = 1;\n```' }],
                })}
            />,
        );

        const block = container.querySelector('.bg-code-surface');
        expect(block).not.toBeNull();
        expect(block).toHaveClass('border-code-line');
        expect(block?.className).not.toMatch(/bg-bg-sidebar|bg-bg-inset|bg-bg-card/);
        // `!bg-transparent` phải còn trên div code: nó là thứ bịt inline background #1e1e1e của theme
        // để token ở wrapper là nguồn sơn duy nhất.
        expect(container.querySelector('code')?.parentElement?.className ?? '')
            .toMatch(/!bg-transparent/);
        // Không có <pre> nào: `pre` component trả fragment, nên rule `.prose pre` cũ là CSS chết.
        expect(container.querySelector('pre')).toBeNull();
    });

    it('styles GFM tables instead of leaving them to the UA stylesheet', () => {
        const { container } = render(
            <MessageItem
                message={assistantMessage({
                    content: '',
                    steps: [{ type: 'text', content: '| a | b |\n| - | - |\n| 1 | 2 |' }],
                })}
            />,
        );

        const table = container.querySelector('table');
        expect(table).not.toBeNull();
        expect(container.querySelector('table')?.parentElement).toHaveClass('overflow-x-auto');
        expect(container.querySelector('th')).toHaveClass('border-border', 'bg-bg-inset');
        expect(container.querySelector('td')).toHaveClass('border-border');
    });

    it('renders the changed-files block AFTER the answer, outside the worked block', () => {
        const editCall = {
            callId: 'c1', name: 'studio.edit_script', status: 'done' as const, durationMs: 1000,
            args: { path: 'src/Config.lua', old: 'return {}\n', source: 'return {\n  speed = 16,\n}\n' },
        };
        const { container } = render(
            <MessageItem
                message={assistantMessage({
                    content: 'Đã xong',
                    steps: [
                        { type: 'text', content: 'Đã xong' },
                        { type: 'call', call: editCall },
                    ],
                })}
            />,
        );

        const text = container.textContent ?? '';
        const workedAt = text.indexOf('Đã làm trong');
        const answerAt = text.indexOf('Đã xong');
        const summaryAt = text.indexOf('1 tệp thay đổi');
        expect(workedAt).toBeGreaterThanOrEqual(0);
        expect(answerAt).toBeGreaterThanOrEqual(0);
        expect(summaryAt).toBeGreaterThanOrEqual(0);
        // Process → answer → outcome.
        expect(workedAt).toBeLessThan(answerAt);
        expect(answerAt).toBeLessThan(summaryAt);

        // The summary trigger is a sibling of the answer, not a descendant of the worked block:
        // the worked block's expander and the summary are distinct buttons.
        const summary = screen.getByRole('button', { name: /1 tệp thay đổi/ });
        const worked = screen.getByRole('button', { name: /Đã làm trong/ });
        expect(worked.contains(summary)).toBe(false);
        expect(summary).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps the changed-files block collapsed by default and expands into the full diff', () => {
        render(
            <MessageItem
                message={assistantMessage({
                    content: 'Đã xong',
                    steps: [
                        { type: 'text', content: 'Đã xong' },
                        {
                            type: 'call',
                            call: {
                                callId: 'c1', name: 'studio.edit_script', status: 'done', durationMs: 1000,
                                args: { path: 'src/Config.lua', old: 'return {}\n', source: 'return {\n  speed = 16,\n}\n' },
                            },
                        },
                    ],
                })}
            />,
        );

        // Collapsed: no diff rows anywhere yet.
        expect(screen.queryByText('speed = 16,')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /1 tệp thay đổi/ }));
        expect(screen.getByText('speed = 16,')).toBeInTheDocument();
        expect(screen.getByText('src/Config.lua')).toBeInTheDocument();
    });

    it('does not show the changed-files block on an intermediate row that hides activity', () => {
        const editCall = {
            callId: 'c1', name: 'studio.edit_script', status: 'done' as const, durationMs: 1000,
            args: { path: 'src/Config.lua', old: '', source: 'x' },
        };
        render(
            <MessageItem
                message={assistantMessage({
                    content: '',
                    steps: [{ type: 'call', call: editCall }],
                })}
                hideActivity
            />,
        );

        expect(screen.queryByText(/tệp thay đổi/)).toBeNull();
    });

    it('renders an edit tool call inside the worked block as a compact row without diff rows', () => {
        const editCall = {
            callId: 'c1', name: 'studio.edit_script', status: 'done' as const, durationMs: 1000,
            args: { path: 'src/Config.lua', old: 'return {}\n', source: 'return {\n  speed = 16,\n}\n' },
        };
        const { container } = render(
            <MessageItem
                message={assistantMessage({
                    content: 'Đã xong',
                    steps: [
                        { type: 'text', content: 'Đã xong' },
                        { type: 'call', call: editCall },
                    ],
                })}
            />,
        );

        // The diff is not painted while the worked block is collapsed...
        expect(container.querySelector('[data-diff-kind]')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Đã làm trong/ }));

        // ...and expanding the process block reveals the compact call row, not hunks: the only
        // diff on screen appears after expanding the outcome block.
        expect(screen.getByText('src/Config.lua')).toBeInTheDocument();
        expect(container.querySelector('[data-diff-kind]')).toBeNull();
        expect(screen.queryByText('speed = 16,')).toBeNull();
    });

    it('renders a runtime delivery as a subtle notice row, never a user bubble', () => {
        render(
            <MessageItem
                message={{
                    ...userMessage('Background subagent sess_abc finished [status: done]. Đã xong phần việc.'),
                    source: 'notice',
                }}
            />,
        );

        const note = screen.getByRole('note');
        expect(note).toHaveTextContent('Subagent xong: Đã xong phần việc.');
        expect(note.querySelector('.items-end')).toBeNull();
        expect(screen.queryByText(/Background subagent/)).toBeNull();
    });

    it('renders a legacy steer delivery with the runtime prefix as a notice too', () => {
        // Rows written before `source: 'notice'` existed carry `steer`; the machine prefix must still
        // keep them out of the user bubble on old sessions.
        render(
            <MessageItem
                message={{
                    ...userMessage('Background job job_9 (workflow: Kiểm thử) finished [status: completed].'),
                    source: 'steer',
                }}
            />,
        );

        expect(screen.getByRole('note')).toHaveTextContent('Tác vụ nền đã xong · workflow: Kiểm thử');
        expect(screen.queryByText(/Background job/)).toBeNull();
    });

    it('renders text, tool and approval steps in projection order', () => {
        const { container } = render(
            <MessageItem
                message={assistantMessage({
                    content: 'Mở đầu',
                    steps: [
                        { type: 'text', content: 'Mở đầu' },
                        { type: 'call', call: { callId: 'c1', name: 'read_file', args: { path: 'a' }, status: 'done', result: 'ok' } },
                        {
                            type: 'approval',
                            approval: {
                                approvalId: 'ap1', callId: 'c2', name: 'run_command',
                                args: {}, risk: 'low', decision: 'deny',
                            },
                        },
                    ],
                })}
            />,
        );

        const text = container.textContent ?? '';
        // M1: `indexOf(a) < indexOf(b)` đúng một cách rỗng khi CẢ HAI chuỗi đều thiếu (-1 < -1 sai,
        // nhưng -1 < 5 thì đúng) → test xanh cả khi component không render gì. Chốt hiện diện trước.
        const at = (needle: string): number => {
            expect(text).toContain(needle);
            return text.indexOf(needle);
        };
        // Collapsed by default: header summary visible, tool body only after expanding.
        expect(at('Mở đầu')).toBeLessThan(at('Yêu cầu phê duyệt'));
        fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]);
        expect(screen.getByText('Đọc tệp')).toBeInTheDocument();
    });
});
