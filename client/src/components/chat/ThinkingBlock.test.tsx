import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThinkingBlock } from './ThinkingBlock';

afterEach(() => cleanup());

describe('ThinkingBlock', () => {
    it('is collapsed by default and reveals the reasoning only after expanding', () => {
        render(<ThinkingBlock reasoning="Suy luận nội bộ" />);

        const toggle = screen.getByRole('button', { name: /đã suy nghĩ/i });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('Suy luận nội bộ')).toBeNull();

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        // Reasoning renders as per-word spans, so match on a node's full text content.
        expect(screen.getAllByText((_, node) => node?.textContent === 'Suy luận nội bộ').length).toBeGreaterThan(0);
    });

    it('shows a duration only when a real duration is supplied', () => {
        const { rerender } = render(<ThinkingBlock reasoning="x" durationMs={4200} />);
        expect(screen.getByRole('button', { name: 'Đã suy nghĩ trong 4s' })).toBeInTheDocument();

        // DerivedMessage carries no thinking start/end pair, so MessageItem passes no duration and
        // the block must not invent one (Ruling 8).
        rerender(<ThinkingBlock reasoning="x" />);
        expect(screen.getByRole('button', { name: 'Đã suy nghĩ' })).toBeInTheDocument();
        expect(screen.queryByText(/\d+s/)).toBeNull();
    });

    it('uses the live label while reasoning is still streaming', () => {
        render(<ThinkingBlock reasoning="đang chảy" active />);
        expect(screen.getByRole('button', { name: 'Đang suy nghĩ…' })).toBeInTheDocument();
    });

    it('streams the reasoning body as plain text while streaming', () => {
        render(<ThinkingBlock reasoning="đang chảy từng chữ" active />);
        fireEvent.click(screen.getByRole('button', { name: 'Đang suy nghĩ…' }));

        expect(screen.getByText('đang chảy từng chữ')).toBeInTheDocument();
        expect(document.querySelectorAll('span.stream-word')).toHaveLength(0);
    });
});
