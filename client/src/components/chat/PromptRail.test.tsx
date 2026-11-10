import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PromptRail, promptPreview } from './PromptRail';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const items = [
    { id: 'u1', prompt: 'Câu hỏi đầu tiên', reply: 'Câu trả lời đầu tiên' },
    { id: 'u2', prompt: 'Câu hỏi thứ hai', reply: 'Câu trả lời thứ hai' },
];

describe('PromptRail', () => {
    it('renders nothing for fewer than two prompts', () => {
        const { container } = render(<PromptRail items={[items[0]!]} />);
        expect(container.querySelector('[data-testid="prompt-rail"]')).toBeNull();
    });

    it('renders one tick per prompt, marks the first active, and is hidden below 1024px', () => {
        render(<PromptRail items={items} />);

        const rail = screen.getByTestId('prompt-rail');
        // The rail is CSS-hidden below `lg` and has no alternative mobile affordance.
        expect(rail).toHaveClass('hidden');
        expect(rail).toHaveClass('lg:block');
        expect(screen.getAllByTestId(/prompt-rail-tick-/)).toHaveLength(2);
        expect(screen.getByTestId('prompt-rail-tick-0')).toHaveAttribute('data-active', 'true');
        expect(screen.getByTestId('prompt-rail-tick-1')).toHaveAttribute('data-active', 'false');
    });

    it('shows the prompt and reply previews in a tooltip on hover, with neighbour magnification', () => {
        render(<PromptRail items={items} />);

        const second = screen.getByTestId('prompt-rail-tick-1');
        fireEvent.mouseEnter(second);

        const tooltip = screen.getByRole('tooltip');
        expect(tooltip).toHaveTextContent('Câu hỏi thứ hai');
        expect(tooltip).toHaveTextContent('Câu trả lời thứ hai');
        expect(tooltip).toHaveClass('bg-bg-card');
        expect(tooltip).toHaveClass('border-border');

        // Hovered tick magnifies most; the neighbour also grows (the "magnification" effect).
        expect(second.firstElementChild).toHaveClass('scale-y-150');
        expect(screen.getByTestId('prompt-rail-tick-0').firstElementChild).toHaveClass('scale-y-125');

        fireEvent.mouseLeave(second);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('scrolls the matching user row into view when a tick is clicked', () => {
        const scroller = document.createElement('div');
        scroller.id = 'msg-u2';
        const scrollIntoView = vi.fn();
        scroller.scrollIntoView = scrollIntoView;
        document.body.appendChild(scroller);
        const original = window.matchMedia;
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: vi.fn(() => ({ matches: false }) as MediaQueryList),
        });

        render(<PromptRail items={items} />);
        fireEvent.click(screen.getByTestId('prompt-rail-tick-1'));

        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
        scroller.remove();
        Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original });
    });

    it('promptPreview flattens whitespace and caps at ~120 characters', () => {
        expect(promptPreview('  dòng một\n\ndòng hai  ')).toBe('dòng một dòng hai');
        const long = promptPreview('a'.repeat(200));
        expect(long).toHaveLength(121);
        expect(long.endsWith('…')).toBe(true);
    });
});
