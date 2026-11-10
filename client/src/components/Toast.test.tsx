import { act } from 'react';
import type { ReactNode } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * M5 (vế hành vi) + nợ test #6 của round 1 — Toast phải TÔN TRỌNG `prefers-reduced-motion`, và câu đó
 * phải đỏ được khi ai đó bỏ gate.
 *
 * Vì sao file này mock `framer-motion` thay vì stub `matchMedia` như brief ban đầu gợi ý: round 2 đã đo
 * thật (`task-24-fix2-rereview.md` §3, probe R-M4) rằng stub `window.matchMedia` cho
 * `(prefers-reduced-motion: reduce)` trả `matches: true` mà `useReducedMotion()` VẪN trả `false` —
 * framer-motion không đọc lại object đã bị thay. Một test viết đúng chữ của brief vì thế sẽ xanh vì lý
 * do sai: nó không bao giờ vào nhánh reduce. Test này đổi câu hỏi thành câu mà jsdom trả lời được, và
 * nói thẳng phạm vi:
 *
 *   ĐÃ CHỨNG MINH — caller production đọc cờ reduce và đổi props nó đưa cho framer-motion theo cờ đó.
 *     Xoá gate ở `Toast.tsx:80-87` là đỏ ngay tại commit của nó. Đây đúng là điều M5 tố là vắng mặt
 *     ("không có production caller nào"; tên test cũ assert "the media-query primitive the app uses"
 *     trong khi app không dùng nó, và nó assert một spy nhận chính chuỗi literal của test — tự tham
 *     chiếu, không thể đỏ).
 *   CHƯA CHỨNG MINH — framer-motion tự đáp ứng media query của hệ điều hành trên trình duyệt thật. Phần
 *     đó thuộc Task 25 (`page.emulateMedia({ reducedMotion: 'reduce' })`), không thuộc jsdom, và không
 *     được tính là đã xanh chỉ vì file này xanh.
 *   LUẬT CSS (`index.css:337-349`) có chốt chặn riêng ở `client/tests/tokens.test.ts` (M5 vế CSS).
 *
 * Mock chỉ thay ba thứ surface này dùng (`useReducedMotion`, `motion.div`, `AnimatePresence`);
 * `motion.div` render `div` thường nên DOM vẫn query được bằng role, còn props nó nhận được ghi vào một
 * biến module để assert đúng hợp đồng caller → library. `Toast` là module-local (file chỉ export
 * `ToastContainer`/`useToasts`), nên mọi test đi qua container thật, không qua một cổng sau lưng.
 */

const probe = vi.hoisted(() => ({
    reduce: false,
    lastMotionProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('framer-motion', async () => {
    const React = await import('react');
    const motionDiv = (props: Record<string, unknown> & { children?: ReactNode }) => {
        probe.lastMotionProps = props;
        return React.createElement(
            'div',
            { role: (props.role as string) ?? undefined, className: props.className as string },
            props.children,
        );
    };
    return {
        useReducedMotion: () => probe.reduce,
        motion: { div: motionDiv },
        AnimatePresence: ({ children }: { children?: ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    };
});

const { ToastContainer } = await import('./Toast');
const { vi: dictionary } = await import('../i18n/vi');

const infoToast = { id: 't-1', type: 'info' as const, message: 'Đã lưu projector.' };

describe('Toast — reduced motion là hợp đồng của caller, không phải lời hứa trong comment', () => {
    beforeEach(() => {
        probe.reduce = false;
        probe.lastMotionProps = undefined;
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('không reduce thì animation vẫn đủ — gate không được nhân tiện giết hoạt ảnh', () => {
        // Chiều hay bị bỏ quên: một "fix" reduced-motion xoá luôn `x`/`scale` cho MỌI người dùng là đổi
        // thiết kế của surface. `layout` + spring + giá trị dịch chuyển phải còn khi reduce = false.
        render(<ToastContainer toasts={[infoToast]} onDismiss={() => {}} />);
        const props = probe.lastMotionProps;
        expect(props).toBeDefined();
        expect(props?.layout).toBe(true);
        expect(props?.initial).toEqual({ opacity: 0, x: 60, scale: 0.95 });
        expect(props?.animate).toEqual({ opacity: 1, x: 0, scale: 1 });
        expect(props?.transition).toEqual({ type: 'spring', stiffness: 350, damping: 30 });
    });

    it('prefers-reduced-motion: không còn giá trị dịch chuyển nào, duration về 0, layout tắt', () => {
        probe.reduce = true;
        render(<ToastContainer toasts={[infoToast]} onDismiss={() => {}} />);
        const props = probe.lastMotionProps;
        expect(props).toBeDefined();
        // `initial={false}` = "vào thẳng giá trị animate": không có khung hình đầu để mà trượt.
        expect(props?.initial).toBe(false);
        expect(props?.layout).toBe(false);
        expect(props?.transition).toEqual({ duration: 0 });
        // Assert theo TẬP HỢP KEY, không theo object literal: `opacity` vẫn được phép (fade không phải
        // chuyển động), còn `x`/`scale`/`y` thì không — đó mới là thứ reduced-motion yêu cầu.
        for (const key of ['animate', 'exit'] as const) {
            const value = props?.[key] as Record<string, unknown>;
            expect(Object.keys(value)).toEqual(['opacity']);
        }
    });

    it('hàng error đội role=alert trong một region role=status có TRƯỚC nội dung (M6)', () => {
        // Region phải sống khi chưa có toast nào, nếu không AT không có gì để nghe. Assert cả hai chiều
        // để một lần "early-return khi mảng rỗng" ở tương lai bị bắt ngay tại commit của nó.
        const { rerender } = render(<ToastContainer toasts={[]} onDismiss={() => {}} />);
        const region = screen.getByRole('status');
        expect(region).toHaveAttribute('aria-live', 'polite');
        expect(within(region).queryAllByRole('alert')).toHaveLength(0);

        rerender(
            <ToastContainer
                toasts={[{ ...infoToast, type: 'error', message: 'Không gọi được harness.' }]}
                onDismiss={() => {}}
            />,
        );
        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(within(screen.getByRole('status')).getByRole('alert')).toHaveTextContent(
            'Không gọi được harness.',
        );
    });

    it('nút đóng có tên truy cập và dismiss đúng hàng (không phải nút chết)', () => {
        const onDismiss = vi.fn();
        render(<ToastContainer toasts={[infoToast, { ...infoToast, id: 't-2' }]} onDismiss={onDismiss} />);
        const closeButtons = screen.getAllByRole('button', { name: dictionary.nav.close });
        expect(closeButtons).toHaveLength(2);
        fireEvent.click(closeButtons[0]);
        expect(onDismiss).toHaveBeenCalledWith('t-1');
    });

    it('đồng hồ tự ẩn chạy thật: đúng AUTO_DISMISS_MS thì onDismiss được gọi cho đúng id', () => {
        // §6.6.2 cấm "trang trí diễn". Progress bar ở `Toast.tsx:112` rộng theo `progress`, và `progress`
        // giảm mỗi 100 ms tới 0 thì dismiss — đây là bằng chứng đồng hồ đó thật, không phải CSS trang trí.
        const onDismiss = vi.fn();
        render(<ToastContainer toasts={[infoToast]} onDismiss={onDismiss} />);
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(5900);
        });
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(onDismiss).toHaveBeenCalledWith('t-1');
    });
});
