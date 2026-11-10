import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Every test reloads Header (`vi.resetModules()`), and Header imports the icon module. Hugeicons'
 * barrel is ~15k glyphs, so eight reloads cost more than the default 10s hook budget. The budget is
 * raised instead of mocking the icons: mocking a module under `resetModules` proved fragile, and the
 * icons are real UI this file renders.
 */
vi.setConfig({ hookTimeout: 30_000 });

window.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;

/**
 * `useTheme` giữ store ở cấp module (một class `.dark` cho mọi consumer), nên nhập tĩnh `Header` bắt mọi
 * test dùng CHUNG một giá trị: `localStorage.clear()` không reset được `current`, còn mock `matchMedia`
 * đặt ở đầu file đã chạy SAU lần đọc đầu tiên. Một test để lại theme tối thì test sau thấy nhãn nút ngược
 * với giả định của nó. Mỗi test vì thế nạp lại module — cùng cách `useTheme.test.tsx` vẫn làm.
 */
type HeaderType = (typeof import('./Header'))['Header'];
let Header: HeaderType;

const baseProps = {
    mcpConnected: true as boolean | null,
    onReconnectMcp: vi.fn(),
    onShowHelp: vi.fn(),
};

beforeEach(async () => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    vi.resetModules();
    Header = (await import('./Header')).Header;
});

afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
});

describe('Header', () => {
    it('shows the real project/session breadcrumb joined by ›', () => {
        render(<Header {...baseProps} projectName="Dự án Alpha" sessionTitle="Phiên Beta" />);

        expect(screen.getByText('Dự án Alpha › Phiên Beta')).toBeInTheDocument();
    });

    it('degrades the breadcrumb to only what actually exists', () => {
        const { rerender } = render(<Header {...baseProps} projectName="Dự án Alpha" />);
        expect(screen.getByText('Dự án Alpha')).toBeInTheDocument();

        rerender(<Header {...baseProps} sessionTitle="Phiên Beta" />);
        expect(screen.getByText('Phiên Beta')).toBeInTheDocument();
        expect(screen.queryByText(/›/)).toBeNull();
    });

    it('renders all three MCP states with their own label and token pair', () => {
        const { rerender } = render(<Header {...baseProps} mcpConnected={null} />);
        const chip = () => screen.getByRole('button', { name: /^Roblox Studio MCP/ });

        expect(chip()).toHaveAccessibleName('Roblox Studio MCP: Đang kết nối');
        expect(chip()).toHaveTextContent('Đang kết nối');
        expect(chip()).toHaveClass('bg-warning-bg');
        expect(chip()).toHaveClass('text-warning-text');

        rerender(<Header {...baseProps} mcpConnected={false} />);
        expect(chip()).toHaveAccessibleName('Roblox Studio MCP: Chưa kết nối');
        expect(chip()).toHaveTextContent('Chưa kết nối');
        expect(chip()).toHaveClass('bg-danger-bg');
        expect(chip()).toHaveClass('text-danger-text');

        rerender(<Header {...baseProps} mcpConnected />);
        const status = screen.getByRole('status', { name: 'Roblox Studio MCP: Đã kết nối' });
        expect(status).toHaveTextContent('Đã kết nối');
        expect(status).toHaveClass('bg-success-bg');
        expect(status).toHaveClass('text-success-text');
    });

    it('stops offering reconnect once the bridge is healthy', () => {
        // `onReconnectMcp` → `api.mcp.reconnect()`. Một control vẫn bấm được khi bridge đang khỏe là cú
        // khởi động lại server giấu trong nhãn trạng thái, và là nút chết theo §6.6.2.
        const onReconnectMcp = vi.fn();
        const { rerender } = render(<Header {...baseProps} mcpConnected onReconnectMcp={onReconnectMcp} />);

        expect(screen.queryByRole('button', { name: /^Roblox Studio MCP/ })).toBeNull();
        expect(screen.getByRole('status', { name: 'Roblox Studio MCP: Đã kết nối' })).not.toBeNull();

        rerender(<Header {...baseProps} mcpConnected={false} onReconnectMcp={onReconnectMcp} />);
        fireEvent.click(screen.getByRole('button', { name: 'Roblox Studio MCP: Chưa kết nối' }));

        expect(onReconnectMcp).toHaveBeenCalledTimes(1);
    });

    it('derives the status text from the real busy/tool state', () => {
        const { rerender } = render(<Header {...baseProps} />);
        expect(screen.getByText('Sẵn sàng')).toBeInTheDocument();

        rerender(<Header {...baseProps} busy />);
        expect(screen.getByText('Đang nghĩ')).toBeInTheDocument();

        rerender(<Header {...baseProps} busy runningTool />);
        expect(screen.getByText('Đang chạy tool')).toBeInTheDocument();
    });

    it('toggles the dark class and persists morphi.theme', () => {
        render(<Header {...baseProps} />);

        const toDark = screen.getByRole('button', { name: 'Chuyển sang giao diện tối' });
        fireEvent.click(toDark);

        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(localStorage.getItem('morphi.theme')).toBe('dark');

        const toLight = screen.getByRole('button', { name: 'Chuyển sang giao diện sáng' });
        fireEvent.click(toLight);

        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(localStorage.getItem('morphi.theme')).toBe('light');
    });

    it('keeps a live control that reopens onboarding', () => {
        const onShowHelp = vi.fn();
        render(<Header {...baseProps} onShowHelp={onShowHelp} />);

        fireEvent.click(screen.getByRole('button', { name: 'Trợ giúp và hướng dẫn' }));

        expect(onShowHelp).toHaveBeenCalledTimes(1);
    });
});
