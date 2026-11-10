import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SidePanel } from './SidePanel';

const originalMatchMedia = window.matchMedia;

const setViewport = (wide: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: vi.fn((query: string) => ({
            matches: query === '(min-width:1024px)' ? wide : false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    });
};

afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia });
});

describe('SidePanel', () => {
    it('docks as a 420px bordered panel at >=1024px without a scrim or a focus-trapping dialog', () => {
        setViewport(true);
        render(<SidePanel title="Phiên con" onClose={vi.fn()}><p>Nội dung</p></SidePanel>);

        const panel = screen.getByTestId('side-panel');
        expect(panel).toHaveClass('w-[420px]');
        expect(panel).toHaveClass('border-l');
        expect(panel).toHaveClass('border-border');
        expect(panel).not.toHaveAttribute('role', 'dialog');
        expect(screen.queryByTestId('side-panel-scrim')).toBeNull();
        // A docked panel leaves the transcript keyboard-reachable: no modal semantics.
        expect(panel).not.toHaveAttribute('aria-modal');
    });

    it('becomes a full-height overlay with a scrim and a modal dialog below 1024px', () => {
        setViewport(false);
        const onClose = vi.fn();
        render(<SidePanel title="Phiên con" onClose={onClose}><p>Nội dung</p></SidePanel>);

        const panel = screen.getByTestId('side-panel');
        expect(panel).toHaveClass('fixed');
        expect(panel).toHaveClass('inset-y-0');
        expect(panel).toHaveAttribute('role', 'dialog');
        expect(panel).toHaveAttribute('aria-modal', 'true');

        fireEvent.click(screen.getByTestId('side-panel-scrim'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('is dismissable with Escape and by its header close button', () => {
        setViewport(true);
        const onClose = vi.fn();
        render(<SidePanel title="Phiên con" onClose={onClose}><p>Nội dung</p></SidePanel>);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Đóng bảng phiên con' }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('shows the title in the header and keeps the body scrollable', () => {
        setViewport(true);
        render(<SidePanel title="Tóm tắt hoá đơn" onClose={vi.fn()}><p>Nội dung</p></SidePanel>);

        expect(screen.getByRole('heading', { name: 'Tóm tắt hoá đơn' })).toBeInTheDocument();
        expect(screen.getByText('Nội dung').closest('.overflow-y-auto')).not.toBeNull();
    });
});
