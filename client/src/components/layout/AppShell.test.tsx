import { afterEach, beforeEach, describe, expect, it, vi as mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';
import { Rail } from './Rail';
import { vi as viDict } from '../../i18n/vi';

/**
 * Task 21 pins the actual Vietnamese literals here, not the dictionary values the component already
 * reads (finding I4: `expect(vi.nav.chat).toBe(vi.nav.chat)` could never fail). Changing a string in
 * `i18n/vi.ts` turns these tests red.
 */
const PINNED_LITERALS = {
    newChat: 'Cuộc trò chuyện mới',
    search: 'Tìm kiếm',
    projects: 'Dự án',
    memory: 'Bộ nhớ',
    settings: 'Cài đặt',
    more: 'Thêm',
    today: 'Hôm nay',
    yesterday: 'Hôm qua',
    last7: '7 ngày qua',
    older: 'Cũ hơn',
    pinned: 'Đã ghim',
} as const;

type Listener = (event: MediaQueryListEvent) => void;
let desktop = false;
let listeners: Listener[] = [];

const mediaQueryList = () => ({
    get matches() { return desktop; },
    media: '(min-width:1024px)',
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => { listeners.push(listener); },
    removeEventListener: (_type: string, listener: Listener) => {
        listeners = listeners.filter(item => item !== listener);
    },
    addListener: () => { },
    removeListener: () => { },
    dispatchEvent: () => false,
});

const setDesktop = (value: boolean) => {
    desktop = value;
    act(() => {
        for (const listener of listeners) listener({ matches: value } as MediaQueryListEvent);
    });
};

beforeEach(() => {
    desktop = false;
    listeners = [];
    window.matchMedia = mock.fn(() => mediaQueryList()) as unknown as typeof window.matchMedia;
});

afterEach(() => {
    cleanup();
    mock.restoreAllMocks();
});

const rail = (onAction: (action: 'newChat' | 'search' | 'projects' | 'memory' | 'settings') => void = () => { }) => (
    <Rail onAction={onAction} />
);

describe('AppShell layout', () => {
    it('pins every Vietnamese literal the sidebar/rail contract depends on', () => {
        expect(viDict.nav.newChat).toBe(PINNED_LITERALS.newChat);
        expect(viDict.nav.search).toBe(PINNED_LITERALS.search);
        expect(viDict.nav.projects).toBe(PINNED_LITERALS.projects);
        expect(viDict.nav.memory).toBe(PINNED_LITERALS.memory);
        expect(viDict.nav.settings).toBe(PINNED_LITERALS.settings);
        expect(viDict.sidebar.more).toBe(PINNED_LITERALS.more);
        expect(viDict.sidebar.groups).toEqual({
            today: PINNED_LITERALS.today,
            yesterday: PINNED_LITERALS.yesterday,
            last7: PINNED_LITERALS.last7,
            older: PINNED_LITERALS.older,
            pinned: PINNED_LITERALS.pinned,
        });
    });

    it('renders a main landmark, the slotted children, and every real rail action', () => {
        render(
            <AppShell rail={rail()} sidebar={<div>sidebar-slot</div>}>
                main-content
            </AppShell>,
        );

        expect(screen.getByRole('main')).toBeInTheDocument();
        expect(screen.getByText('main-content')).toBeInTheDocument();
        expect(screen.getByText('sidebar-slot')).toBeInTheDocument();

        for (const label of [PINNED_LITERALS.newChat, PINNED_LITERALS.search, PINNED_LITERALS.projects, PINNED_LITERALS.more]) {
            expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        }
    });

    it('wires rail actions and the 226px “…” popover to real destinations', () => {
        const onAction = mock.fn();
        render(<AppShell rail={rail(onAction)} sidebar={<div />}>x</AppShell>);

        fireEvent.click(screen.getByRole('button', { name: PINNED_LITERALS.projects }));
        expect(onAction).toHaveBeenCalledWith('projects');

        fireEvent.click(screen.getByRole('button', { name: PINNED_LITERALS.more }));
        const menu = screen.getByRole('menu', { name: PINNED_LITERALS.more });
        expect(menu).toHaveClass('w-[226px]');
        expect(menu).toHaveClass('rounded-xl');

        const memory = screen.getByRole('menuitem', { name: PINNED_LITERALS.memory });
        expect(memory).toHaveClass('h-8');
        expect(memory.querySelector('svg')).toHaveAttribute('width', '16');
        expect(memory).toHaveClass('text-[14px]');

        fireEvent.click(screen.getByRole('menuitem', { name: PINNED_LITERALS.settings }));
        expect(onAction).toHaveBeenCalledWith('settings');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('roves focus through the “…” menu with arrows and hands it back on Escape', () => {
        const onAction = mock.fn();
        render(<AppShell rail={rail(onAction)} sidebar={<div />}>x</AppShell>);

        const trigger = screen.getByRole('button', { name: PINNED_LITERALS.more });
        fireEvent.click(trigger);

        const memory = screen.getByRole('menuitem', { name: PINNED_LITERALS.memory });
        const settings = screen.getByRole('menuitem', { name: PINNED_LITERALS.settings });
        expect(memory).toHaveFocus();

        fireEvent.keyDown(memory, { key: 'ArrowDown' });
        expect(settings).toHaveFocus();

        fireEvent.keyDown(settings, { key: 'ArrowDown' });
        expect(memory).toHaveFocus();

        fireEvent.keyDown(memory, { key: 'ArrowUp' });
        expect(settings).toHaveFocus();

        fireEvent.keyDown(settings, { key: 'Home' });
        expect(memory).toHaveFocus();

        fireEvent.keyDown(memory, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger).toHaveFocus();
    });

    it('keeps a closed mobile drawer out of the tab order with aria-hidden true', () => {
        const { container } = render(
            <AppShell rail={rail()} sidebar={<button type="button">noi dung drawer</button>} sidebarOpen={false}>
                x
            </AppShell>,
        );

        const aside = container.querySelector('aside');
        expect(aside).not.toBeNull();
        expect(aside).toHaveClass('-translate-x-full');
        expect(aside).toHaveClass('invisible');
        expect(aside).toHaveAttribute('aria-hidden', 'true');
        expect(container.textContent).toContain('noi dung drawer');
        expect(container.querySelector('[data-testid="app-shell-scrim"]')).toBeNull();
    });

    it('derives desktop visibility from matchMedia so aria-hidden never contradicts lg:visible (N3)', () => {
        const { container } = render(
            <AppShell rail={rail()} sidebar={<div>sidebar-slot</div>} sidebarOpen={false}>
                x
            </AppShell>,
        );

        const aside = container.querySelector('aside');
        expect(aside).toHaveAttribute('aria-hidden', 'true');

        setDesktop(true);

        expect(aside).not.toHaveClass('invisible');
        expect(aside).not.toHaveClass('-translate-x-full');
        expect(aside).toHaveAttribute('aria-hidden', 'false');
        expect(container.querySelector('[data-testid="app-shell-scrim"]')).toBeNull();
    });

    it('dismisses the drawer from the scrim or Escape, and keeps the rail clickable', () => {
        const onCloseSidebar = mock.fn();
        const { container } = render(
            <AppShell rail={rail()} sidebar={<div>sidebar-slot</div>} sidebarOpen onCloseSidebar={onCloseSidebar}>
                x
            </AppShell>,
        );

        const scrim = container.querySelector('[data-testid="app-shell-scrim"]');
        expect(scrim).not.toBeNull();
        expect(scrim).toHaveClass('left-[var(--rail-width)]');
        expect(scrim).not.toHaveClass('inset-0');
        fireEvent.click(scrim as Element);
        expect(onCloseSidebar).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCloseSidebar).toHaveBeenCalledTimes(2);

        const aside = container.querySelector('aside');
        expect(aside).not.toHaveClass('invisible');
        expect(aside).toHaveAttribute('aria-hidden', 'false');
    });

    it('registers Ctrl/Cmd+K and Ctrl/Cmd+N, but ignores Ctrl+N inside an input', () => {
        const onSearch = mock.fn();
        const onNewChat = mock.fn();
        render(
            <AppShell rail={rail()} onSearch={onSearch} onNewChat={onNewChat}>
                <input aria-label="note" />
            </AppShell>,
        );

        fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        expect(onSearch).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document, { key: 'K', metaKey: true });
        expect(onSearch).toHaveBeenCalledTimes(2);

        const input = screen.getByLabelText('note');
        input.focus();
        fireEvent.keyDown(input, { key: 'n', ctrlKey: true });
        expect(onNewChat).not.toHaveBeenCalled();

        fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
        expect(onNewChat).toHaveBeenCalledTimes(1);
    });

    it('uses h-dvh and the measured 52/286 widths from the shared rail token', () => {
        const { container } = render(
            <AppShell rail={rail()} sidebar={<div>sidebar-slot</div>} sidebarOpen onCloseSidebar={() => { }}>
                x
            </AppShell>,
        );

        expect(container.firstElementChild).toHaveClass('h-dvh');
        expect(container.querySelector('nav')).toHaveClass('w-[var(--rail-width)]');
        expect(container.querySelector('aside')).toHaveClass('w-[286px]');
        expect(container.querySelector('[data-testid="app-shell-scrim"]')).toHaveClass('left-[var(--rail-width)]');
    });

    it('null sidebar renders no aside and no scrim (slot absent, not empty shell)', () => {
        const { container } = render(<AppShell rail={rail()} sidebar={null}>x</AppShell>);
        expect(container.querySelector('aside')).toBeNull();
        expect(container.querySelector('[data-testid="app-shell-scrim"]')).toBeNull();
    });

    it('mainAs="div" opts out of the main landmark without dropping the content', () => {
        const { container } = render(<AppShell mainAs="div">content-no-main</AppShell>);
        expect(screen.queryByRole('main')).toBeNull();
        expect(screen.getByText('content-no-main')).toBeInTheDocument();
        expect(container.textContent).toContain('content-no-main');
    });
});

describe('Rail', () => {
    it('exposes only destination-backed icon buttons with Vietnamese names', () => {
        render(<Rail onAction={() => { }} />);
        expect(screen.getByRole('navigation', { name: 'Điều hướng chính' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cuộc trò chuyện mới' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tìm kiếm' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dự án' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Thêm' })).toBeInTheDocument();
    });

    it('closes the “…” popover with Escape', () => {
        render(<Rail onAction={() => { }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Thêm' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
    });
});
