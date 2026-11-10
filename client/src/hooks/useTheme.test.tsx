import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

/** Module state is the point of this hook, so every test needs a pristine copy of it. */
const importFresh = async () => {
    vi.resetModules();
    return await import('./useTheme');
};

beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
});

afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
});

describe('useTheme', () => {
    it('keeps two independent consumers on one value', async () => {
        const { useTheme } = await importFresh();

        const Reader = ({ label }: { label: string }) => {
            const { theme, toggle } = useTheme();
            return (
                <div>
                    <span data-testid={`${label}-theme`}>{theme}</span>
                    <button onClick={toggle}>{label}</button>
                </div>
            );
        };

        render(
            <>
                <Reader label="header" />
                <Reader label="settings" />
            </>,
        );

        expect(screen.getByTestId('header-theme')).toHaveTextContent('light');
        expect(screen.getByTestId('settings-theme')).toHaveTextContent('light');

        fireEvent.click(screen.getByRole('button', { name: 'header' }));

        // `useState` trong từng component sẽ để 'settings' mốc ở light dù class `.dark` đã bật —
        // đúng cú lệch làm hàng Settings của Task 24 bấm hai lần mới ăn.
        expect(screen.getByTestId('header-theme')).toHaveTextContent('dark');
        expect(screen.getByTestId('settings-theme')).toHaveTextContent('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(localStorage.getItem('morphi.theme')).toBe('dark');

        fireEvent.click(screen.getByRole('button', { name: 'settings' }));

        expect(screen.getByTestId('header-theme')).toHaveTextContent('light');
        expect(screen.getByTestId('settings-theme')).toHaveTextContent('light');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        // `index.html` paints the loading splash before any module runs and reads this attribute.
        // Without the write here, a light-mode user's NEXT reload would flash the dark splash
        // even though the stored theme says light.
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('prefers the stored value over the OS preference', async () => {
        localStorage.setItem('morphi.theme', 'dark');
        const { useTheme } = await importFresh();

        const Reader = () => {
            const { theme } = useTheme();
            return <span data-testid="theme">{theme}</span>;
        };
        render(<Reader />);

        expect(screen.getByTestId('theme')).toHaveTextContent('dark');
        // `beforeEach` vừa xóa class, nên `.dark` ở đây là do HIỆU ỨNG SƠN LẠI từ store lúc mount —
        // không có hiệu ứng đó thì người dùng OS-sáng + app-tối nhận bảng màu sáng dù hook báo 'dark'.
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
});
