import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ERROR_COPY, errorCopy } from '../../lib/errorCopy';
import { ErrorCard } from './ErrorCard';

afterEach(() => cleanup());

describe('ErrorCard', () => {
    it('renders NO_PROVIDER with a real settings CTA and no invented retry', () => {
        const onOpenSettings = vi.fn();
        const onRetry = vi.fn();
        render(
            <ErrorCard
                error={{ code: 'NO_PROVIDER', retryable: false }}
                onOpenSettings={onOpenSettings}
                onRetry={onRetry}
            />,
        );

        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(errorCopy('NO_PROVIDER'))).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Mở Cài đặt' }));
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
    });

    it('renders CONTEXT_TRIMMED as a warning, never as a failed turn', () => {
        render(
            <ErrorCard
                error={{ code: 'CONTEXT_TRIMMED', retryable: false }}
                onRetry={vi.fn()}
                onOpenSettings={vi.fn()}
            />,
        );

        const card = screen.getByRole('status');
        expect(card).toHaveClass('bg-warning-bg');
        expect(card).toHaveClass('text-warning-text');
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText('Cảnh báo')).toBeInTheDocument();
        expect(screen.getByText(errorCopy('CONTEXT_TRIMMED'))).toBeInTheDocument();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('treats TOO_MANY_TOOL_CALLS as a warning with no CTA even when retryable is true', () => {
        render(<ErrorCard error={{ code: 'TOO_MANY_TOOL_CALLS', retryable: true }} onRetry={vi.fn()} />);
        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('offers retry only when the code is retryable and the parent supplied a real action', () => {
        const onRetry = vi.fn();
        const { rerender } = render(<ErrorCard error={{ code: 'TURN_TIMEOUT', retryable: true }} onRetry={onRetry} />);
        fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
        expect(onRetry).toHaveBeenCalledTimes(1);

        rerender(<ErrorCard error={{ code: 'TURN_TIMEOUT', retryable: false }} onRetry={onRetry} />);
        expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();

        rerender(<ErrorCard error={{ code: 'TURN_TIMEOUT', retryable: true }} />);
        expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
    });

    it('uses the shared copy table for the provider codes that really exist on the wire', () => {
        // I4: bảng copy từng có `RATE_LIMIT`/`PROVIDER_ERROR` trong khi `grep -rn "RATE_LIMIT" server/src`
        // trả về 0 kết quả — hai code thật là `http_error` và `stream_error` (agent/loop.ts:408,
        // llm/gemini.ts:117). Copy cho một code không tồn tại là chữ trang trí.
        render(<ErrorCard error={{ code: 'http_error', retryable: true }} onRetry={vi.fn()} />);
        expect(screen.getByText(errorCopy('http_error'))).toBeInTheDocument();
        expect(errorCopy('http_error')).not.toBe('Lỗi http_error.');
        expect(errorCopy('stream_error')).not.toBe('Lỗi stream_error.');
    });

    it('ships no copy for codes the server never emits', () => {
        expect(ERROR_COPY).not.toHaveProperty('RATE_LIMIT');
        expect(ERROR_COPY).not.toHaveProperty('PROVIDER_ERROR');
    });
});
