import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Titlebar } from './Titlebar';

const baseProps = {
    canGoBack: false,
    canGoForward: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onToggleSidebar: vi.fn(),
    sidebarCollapsed: false,
    onNewChat: vi.fn(),
    onNewProject: vi.fn(),
    onShowHelp: vi.fn(),
    onWindowCommand: vi.fn(),
};

afterEach(() => cleanup());

describe('Titlebar', () => {
    it('disables back/forward until history exists, then calls the handlers', () => {
        const { rerender } = render(<Titlebar {...baseProps} />);

        expect(screen.getByRole('button', { name: 'Quay lại' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Tới' })).toBeDisabled();

        rerender(<Titlebar {...baseProps} canGoBack canGoForward />);
        fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }));
        fireEvent.click(screen.getByRole('button', { name: 'Tới' }));

        expect(baseProps.onBack).toHaveBeenCalledTimes(1);
        expect(baseProps.onForward).toHaveBeenCalledTimes(1);
    });

    it('is the single sidebar toggle', () => {
        const onToggleSidebar = vi.fn();
        render(<Titlebar {...baseProps} onToggleSidebar={onToggleSidebar} />);

        fireEvent.click(screen.getByRole('button', { name: 'Bật/tắt thanh bên' }));

        expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    });

    it('opens the File menu and runs the chosen item', () => {
        render(<Titlebar {...baseProps} />);

        fireEvent.click(screen.getByRole('button', { name: 'Tệp' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('menuitem', { name: 'Cuộc trò chuyện mới' }));

        expect(baseProps.onNewChat).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('routes window-level items (quit) through the window command channel', () => {
        const onWindowCommand = vi.fn();
        render(<Titlebar {...baseProps} onWindowCommand={onWindowCommand} />);

        fireEvent.click(screen.getByRole('button', { name: 'Tệp' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Thoát' }));

        expect(onWindowCommand).toHaveBeenCalledWith('quit');
    });

    it('closes the open menu with Escape', () => {
        render(<Titlebar {...baseProps} />);

        fireEvent.click(screen.getByRole('button', { name: 'Trợ giúp' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByRole('menu')).toBeNull();
    });
});
