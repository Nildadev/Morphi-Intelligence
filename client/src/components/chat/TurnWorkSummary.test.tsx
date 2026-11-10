import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TurnWorkSummary } from './TurnWorkSummary';
import type { TurnChangeSummary } from '../../lib/turnChanges';

afterEach(() => cleanup());

const summaryOf = (over: Partial<TurnChangeSummary> = {}): TurnChangeSummary => ({
    files: 2,
    additions: 12,
    deletions: 3,
    changes: [
        { path: 'src/ServerScriptService/Combat.lua', added: 10, removed: 2, ops: [] },
        { path: 'src/ReplicatedStorage/Config.lua', added: 2, removed: 1, ops: [] },
    ],
    ...over,
});

describe('TurnWorkSummary', () => {
    it('states the file count and line churn in the collapsed row', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.getByText('2 tệp thay đổi')).toBeInTheDocument();
        expect(screen.getByText('+12')).toBeInTheDocument();
        expect(screen.getByText('−3')).toBeInTheDocument();
    });

    it('uses the singular sentence for one file instead of "1 tệp thay đổi"', () => {
        render(<TurnWorkSummary summary={summaryOf({
            files: 1,
            changes: [{ path: 'a.lua', added: 1, removed: 0, ops: [] }],
        })} />);
        expect(screen.getByText('1 tệp thay đổi')).toBeInTheDocument();
    });

    it('keeps the per-file list collapsed until the row is expanded', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.queryByRole('list')).toBeNull();
        expect(screen.queryByText('Combat.lua')).toBeNull();
    });

    it('expands into one row per file with its own churn', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        fireEvent.click(screen.getByRole('button'));
        const rows = screen.getAllByRole('listitem');
        expect(rows).toHaveLength(2);
        // Long paths are shortened to the file name but keep the full path in `title`.
        expect(screen.getByText('Combat.lua')).toBeInTheDocument();
        expect(screen.getByText('Config.lua')).toBeInTheDocument();
        expect(screen.getByTitle('src/ServerScriptService/Combat.lua')).toBeInTheDocument();
    });

    it('collapses again on a second click', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        const trigger = screen.getByRole('button');
        fireEvent.click(trigger);
        expect(screen.getByRole('list')).toBeInTheDocument();
        fireEvent.click(trigger);
        expect(screen.queryByRole('list')).toBeNull();
    });

    it('exposes aria-expanded so the collapsed state is not visual-only', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        const trigger = screen.getByRole('button');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    it('is inert while the turn is still running', () => {
        // A live turn's counts are still moving; letting the row expand would show a partial list
        // that contradicts itself a second later.
        render(<TurnWorkSummary summary={summaryOf()} live />);
        const trigger = screen.getByRole('button');
        expect(trigger).toBeDisabled();
        fireEvent.click(trigger);
        expect(screen.queryByRole('list')).toBeNull();
        expect(trigger).not.toHaveAttribute('aria-expanded');
    });

    it('labels the trigger with the count and the fact that it is a file list', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.getByRole('button')).toHaveAttribute(
            'aria-label',
            '2 tệp thay đổi · Các tệp đã thay đổi trong lượt này',
        );
    });
});
