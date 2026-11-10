import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StreamWords } from './StreamWords';

afterEach(() => cleanup());

describe('StreamWords', () => {
    it('renders the accumulated text exactly as delivered, with no spans or animation', () => {
        const { container, rerender } = render(<StreamWords text="xin chào" active />);
        expect(container.textContent).toBe('xin chào');
        expect(container.querySelector('span')).toBeNull();

        rerender(<StreamWords text="xin chào bạn" active />);
        expect(container.textContent).toBe('xin chào bạn');
    });

    it('renders the whole text when settled too', () => {
        const { container } = render(<StreamWords text="xin chào bạn" active={false} />);
        expect(container.textContent).toBe('xin chào bạn');
    });

    it('clears back to empty text', () => {
        const { container, rerender } = render(<StreamWords text="xin chào" active />);
        expect(container.textContent).toBe('xin chào');
        rerender(<StreamWords text="" active />);
        expect(container.textContent).toBe('');
    });
});
