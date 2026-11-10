import { afterEach, beforeEach, describe, expect, it, vi as mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar, SIDEBAR_COLLAPSED_KEY, readSidebarCollapsed, writeSidebarCollapsed } from './Sidebar';
import { SearchPalette } from './SearchPalette';
import type { Project, SessionSummary } from '../../types';

/**
 * Task 21 UI contract. Every Vietnamese literal below is hardcoded on purpose: reading the same
 * dictionary the component reads would make a copy change invisible to the test (finding I4).
 */
const NOW = Date.parse('2026-11-02T12:00:00Z');

/** Elapsed-time fixtures: timezone-proof, unlike local calendar days. */
const hoursAgo = (hours: number): number => NOW - hours * 3_600_000;

const projects: Project[] = [
    { id: 'p1', name: 'Dự án Alpha', createdAt: NOW, lastActive: NOW },
    { id: 'p2', name: 'Dự án Beta', createdAt: NOW, lastActive: NOW },
];

const today: SessionSummary = {
    id: 's1', projectId: 'p1', projectName: 'Dự án Alpha',
    title: 'Thiết kế hệ thống chiến đấu', createdAt: hoursAgo(3), lastUpdated: hoursAgo(1),
    isPinned: false, status: 'idle',
};
const yesterday: SessionSummary = {
    id: 's2', projectId: 'p2', projectName: 'Dự án Beta',
    title: 'Ghi chú Beta', createdAt: hoursAgo(30), lastUpdated: hoursAgo(26),
    isPinned: false, status: 'idle',
};
const older: SessionSummary = {
    id: 's3', projectId: 'p1', projectName: 'Dự án Alpha',
    title: 'Bản nháp cũ', createdAt: hoursAgo(240), lastUpdated: hoursAgo(240),
    isPinned: false, status: 'idle',
};

const sidebarProps = () => ({
    projects,
    sessions: [today, yesterday, older],
    currentProjectId: 'p1',
    currentSessionId: 's1',
    onSelectProject: mock.fn(),
    onSelectSession: mock.fn(),
    onNewSession: mock.fn(),
    onNewSessionInProject: mock.fn(),
    onNewProject: mock.fn(),
    onDelete: mock.fn(),
    onTogglePin: mock.fn(),
    onSearch: mock.fn(),
    connected: true,
});

beforeEach(() => {
    mock.spyOn(Date, 'now').mockReturnValue(NOW);
    localStorage.clear();
});

afterEach(() => {
    cleanup();
    mock.restoreAllMocks();
    localStorage.clear();
});

describe('Sidebar — ChatGPT-style recents rail', () => {
    it('renders the exact Vietnamese chrome and time-group labels', () => {
        render(<Sidebar {...sidebarProps()} />);

        expect(screen.getByText('Morphi')).toBeInTheDocument();
        expect(screen.getByText('Morphi v1.1.0')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cuộc trò chuyện mới' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tìm kiếm' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Thông báo' })).toBeInTheDocument();
        // Nút thu gọn sidebar đã chuyển lên titlebar (nút bật/tắt duy nhất) — header sidebar không
        // còn mang nút nào ngoài bell/search.
        expect(screen.queryByRole('button', { name: 'Thu gọn thanh bên' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Mở rộng thanh bên' })).toBeNull();

        // Codex-style: no "Dự án" section heading and no time-group headings — each project is
        // its own folder header with its chats indented below.
        expect(screen.queryByRole('heading', { name: 'Dự án' })).toBeNull();
        expect(screen.getByTestId('project-row-p1')).toHaveTextContent('Dự án Alpha');
        expect(screen.getByTestId('project-row-p2')).toHaveTextContent('Dự án Beta');
        expect(screen.queryByRole('heading', { name: 'Hôm nay' })).toBeNull();
        // Relative ages sit on the chat rows ("1h" for the row updated an hour ago).
        expect(screen.getByTestId('session-row-s1')).toHaveTextContent('1h');
        expect(screen.getByTestId('session-row-s2')).toHaveTextContent('1d');
    });

    it('groups chats under their project header with a relative age on the right', () => {
        render(<Sidebar {...sidebarProps()} />);

        expect(screen.getByTestId('session-row-s1')).toHaveTextContent('Thiết kế hệ thống chiến đấu');
        expect(screen.getByTestId('session-row-s3')).toHaveTextContent('10d');
        // Project names live on headers only; a chat row never repeats them.
        expect(screen.getByTestId('session-row-s1')).not.toHaveTextContent('Dự án Alpha');
        expect(screen.getByTestId('session-row-s2')).not.toHaveTextContent('Dự án Beta');
    });

    it('shows the chat title and emits the session id on selection', () => {
        const props = sidebarProps();
        render(<Sidebar {...props} />);

        const row = screen.getByTestId('session-row-s1').querySelector('button');
        expect(row).not.toBeNull();
        fireEvent.click(row!);
        expect(props.onSelectSession).toHaveBeenCalledWith('s1');
    });

    it('wires new chat, search, new project and project selection', () => {
        const props = sidebarProps();
        render(<Sidebar {...props} />);

        fireEvent.click(screen.getByRole('button', { name: 'Cuộc trò chuyện mới' }));
        expect(props.onNewSession).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
        expect(props.onSearch).toHaveBeenCalledTimes(1);

        // The per-project `+` only creates the chat (selecting first would race the create).
        fireEvent.click(screen.getAllByRole('button', { name: 'Cuộc trò chuyện mới trong dự án này' })[0]);
        expect(props.onNewSessionInProject).toHaveBeenCalledWith('p1');
        expect(props.onSelectProject).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('project-row-p2'));
        expect(props.onSelectProject).toHaveBeenCalledWith('p2');
    });

    it('reveals pin/delete on hover but keeps a keyboard path (focus-within) and isolates clicks', () => {
        const props = sidebarProps();
        render(<Sidebar {...props} />);

        const actions = screen.getByTestId('session-actions-s1');
        expect(actions).toHaveClass('opacity-0');
        expect(actions).toHaveClass('group-hover:opacity-100');
        expect(actions).toHaveClass('group-focus-within:opacity-100');
        // Touch pointers never fire hover, so destructive controls must be visible there too.
        expect(actions).toHaveClass('pointer-coarse:opacity-100');

        const pin = screen.getByRole('button', { name: 'Ghim Thiết kế hệ thống chiến đấu' });
        const del = screen.getByRole('button', { name: 'Xoá Thiết kế hệ thống chiến đấu' });
        // Both controls exist in the tab order even before hover/focus.
        expect(pin).toHaveAttribute('type', 'button');
        expect(del).toHaveAttribute('type', 'button');

        fireEvent.click(pin);
        expect(props.onTogglePin).toHaveBeenCalledWith('s1');
        expect(props.onSelectSession).not.toHaveBeenCalled();

        fireEvent.click(del);
        expect(props.onDelete).toHaveBeenCalledWith('s1');
        expect(props.onSelectSession).not.toHaveBeenCalled();
    });

    it('shows the running dots on the sessions that have a live turn', () => {
        // A turn belongs to its session: a chat streaming in the background must announce itself
        // on its row without being opened (deepseek background chats).
        const props = { ...sidebarProps(), runningSessionIds: new Set(['s2']) };
        render(<Sidebar {...props} />);

        expect(screen.getByTestId('session-running-s2')).toBeInTheDocument();
        // Three staggered dots read as one typing wave, and they are decorative (aria carries the label).
        expect(screen.getByTestId('session-running-s2').querySelectorAll('.session-running-dot')).toHaveLength(3);
        expect(screen.getByRole('status', { name: 'Đang chạy' })).toBeInTheDocument();
        expect(screen.queryByTestId('session-running-s1')).toBeNull();
        expect(screen.queryByTestId('session-running-s3')).toBeNull();
    });

    it('renders no running indicator when no turn is live', () => {
        render(<Sidebar {...sidebarProps()} />);
        expect(screen.queryByRole('status', { name: 'Đang chạy' })).toBeNull();
    });

    it('keeps the collapse key helpers verbatim (the titlebar toggle is the only writer)', () => {
        expect(readSidebarCollapsed()).toBe(false);
        expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();

        writeSidebarCollapsed(true);
        expect(localStorage.getItem('morphi.sidebarCollapsed')).toBe('true');
        expect(readSidebarCollapsed()).toBe(true);

        writeSidebarCollapsed(false);
        expect(localStorage.getItem('morphi.sidebarCollapsed')).toBe('false');
        expect(readSidebarCollapsed()).toBe(false);
    });

    it('collapses a project without dropping its header', () => {
        render(<Sidebar {...sidebarProps()} />);
        expect(screen.getByTestId('session-row-s1')).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole('button', { name: 'Thu gọn dự án' })[0]);

        expect(screen.queryByTestId('session-row-s1')).toBeNull();
        expect(screen.getByTestId('session-row-s2')).toBeInTheDocument();
        expect(screen.getByTestId('project-row-p1')).toBeInTheDocument();
    });

    it('uses the measured geometry: 38px rows and indented project children', () => {
        render(<Sidebar {...sidebarProps()} />);

        expect(screen.getByTestId('sidebar')).toHaveClass('w-full');
        expect(screen.getByTestId('session-row-s1')).toHaveClass('h-[28px]');
        expect(screen.getByTestId('session-row-s1')).toHaveClass('rounded-lg');
        expect(screen.queryByTestId('sidebar-recents-label')).toBeNull();
    });

    it('offers a new-project action and a direct delete control on each project header', () => {
        const props = { ...sidebarProps(), onDeleteProject: mock.fn() };
        render(<Sidebar {...props} />);

        fireEvent.click(screen.getByRole('button', { name: 'Dự án mới' }));
        expect(props.onNewProject).toHaveBeenCalledTimes(1);

        const deleteButton = screen.getByRole('button', { name: 'Xoá dự án Dự án Alpha' });
        expect(deleteButton).toHaveClass('opacity-0');
        fireEvent.click(deleteButton);
        expect(props.onDeleteProject).toHaveBeenCalledWith('p1');
    });

    it('renders genuine connection status in the footer', () => {
        const { rerender } = render(<Sidebar {...sidebarProps()} connected />);
        expect(screen.getByText('Đã kết nối')).toBeInTheDocument();

        rerender(<Sidebar {...sidebarProps()} connected={false} />);
        expect(screen.getByText('Chưa kết nối')).toBeInTheDocument();
    });

    it('focuses the first project header when the rail asks for it', () => {
        const { rerender } = render(<Sidebar {...sidebarProps()} focusProjectsSignal={0} />);
        rerender(<Sidebar {...sidebarProps()} focusProjectsSignal={1} />);
        expect(screen.getByTestId('project-row-p1')).toHaveFocus();
    });
});

describe('SearchPalette — modal search with real keyboard control', () => {
    const paletteProps = (overrides: Partial<Parameters<typeof SearchPalette>[0]> = {}) => ({
        open: true,
        sessions: [today, yesterday, older],
        projects,
        onClose: mock.fn(),
        onSelectSession: mock.fn(),
        onSelectProject: mock.fn(),
        ...overrides,
    });

    it('uses the Vietnamese aria label and the measured 768px/top-128 geometry', () => {
        render(<SearchPalette {...paletteProps()} />);

        const dialog = screen.getByRole('dialog', { name: 'Tìm kiếm cuộc trò chuyện và dự án' });
        expect(dialog).toHaveClass('w-[768px]');
        expect(dialog).toHaveClass('mt-32');
        expect(dialog).toHaveClass('rounded-2xl');
        expect(screen.getByPlaceholderText('Tìm kiếm cuộc trò chuyện hoặc dự án…')).toBeInTheDocument();
        expect(screen.getByTestId('search-input-row')).toHaveClass('h-[50px]');
        expect(screen.getByTestId('search-result-s1')).toHaveClass('h-8');
        expect(screen.getByTestId('search-footer')).toHaveClass('h-9');
        expect(screen.getByText('Ctrl K')).toBeInTheDocument();
    });

    it('filters across session titles and project names', () => {
        render(<SearchPalette {...paletteProps()} />);
        const input = screen.getByPlaceholderText('Tìm kiếm cuộc trò chuyện hoặc dự án…');

        fireEvent.change(input, { target: { value: 'Beta' } });
        expect(screen.getByRole('option', { name: /Ghi chú Beta/ })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /Thiết kế hệ thống chiến đấu/ })).toBeNull();

        fireEvent.change(input, { target: { value: 'chiến đấu' } });
        expect(screen.getByRole('option', { name: /Thiết kế hệ thống chiến đấu/ })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /Ghi chú Beta/ })).toBeNull();
    });

    it('opens on the all view, lists projects before chats, and selects with Enter', () => {
        const props = paletteProps();
        render(<SearchPalette {...props} />);
        const input = screen.getByPlaceholderText('Tìm kiếm cuộc trò chuyện hoặc dự án…');

        // Default filter is `all`, so the list is [p1, p2, s1, s2, s3] and row 0 is a project.
        expect(screen.getByTestId('search-result-p1')).toBeInTheDocument();
        expect(screen.getByTestId('search-result-s1')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tất cả' })).toHaveAttribute('aria-pressed', 'true');

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(props.onSelectProject).toHaveBeenCalledWith('p2');
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('wraps from the first row to the last so ArrowUp never dead-ends', () => {
        const props = paletteProps();
        render(<SearchPalette {...props} />);
        const input = screen.getByPlaceholderText('Tìm kiếm cuộc trò chuyện hoặc dự án…');

        fireEvent.keyDown(input, { key: 'ArrowUp' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(props.onSelectSession).toHaveBeenCalledWith('s3');
    });

    it('closes on Escape and traps Tab/Shift+Tab inside the dialog', () => {
        const props = paletteProps();
        render(<SearchPalette {...props} />);
        const input = screen.getByPlaceholderText('Tìm kiếm cuộc trò chuyện hoặc dự án…');

        fireEvent.keyDown(input, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);

        input.focus();
        fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
        expect(screen.getByRole('button', { name: 'Dự án' })).toHaveFocus();

        const last = screen.getByRole('button', { name: 'Dự án' });
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(input).toHaveFocus();
    });

    it('shows a real empty state and never fabricates a result count or usage card', () => {
        render(<SearchPalette {...paletteProps()} />);
        fireEvent.change(screen.getByPlaceholderText('Tìm kiếm cuộc trò chuyện hoặc dự án…'), {
            target: { value: 'không tồn tại' },
        });

        expect(screen.getByText('Không tìm thấy kết quả')).toBeInTheDocument();
        expect(screen.queryByText(/\d+\s*kết quả/i)).toBeNull();
        expect(screen.queryByText(/usage/i)).toBeNull();
    });

    it('selects a project from the Dự án filter', () => {
        const props = paletteProps();
        render(<SearchPalette {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'Dự án' }));

        const project = screen.getByRole('option', { name: /Dự án Alpha/ });
        fireEvent.click(project);
        expect(props.onSelectProject).toHaveBeenCalledWith('p1');
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('renders nothing when closed', () => {
        render(<SearchPalette {...paletteProps({ open: false })} />);
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
