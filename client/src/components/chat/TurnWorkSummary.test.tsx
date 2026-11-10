import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TurnWorkSummary } from './TurnWorkSummary';
import { diffLines, type TurnChangeSummary } from '../../lib/turnChanges';

afterEach(() => cleanup());

const changeOf = (path: string, oldText: string, newText: string) => {
    const { ops, added, removed } = diffLines(oldText, newText);
    return { path, added, removed, ops };
};

const summaryOf = (over: Partial<TurnChangeSummary> = {}): TurnChangeSummary => ({
    files: 2,
    additions: 12,
    deletions: 3,
    changes: [
        changeOf('src/ServerScriptService/Combat.lua', '', 'local Combat = {}\n\nreturn Combat'),
        changeOf('src/ReplicatedStorage/Config.lua', 'return {}\n', 'return {\n  speed = 16,\n  jump = 50,\n}\n'),
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
            changes: [changeOf('a.lua', '', 'x')],
        })} />);
        expect(screen.getByText('1 tệp thay đổi')).toBeInTheDocument();
    });

    it('starts collapsed: no per-file cards and no diff rows until clicked', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.queryByRole('list')).toBeNull();
        expect(screen.queryByText('src/ServerScriptService/Combat.lua')).toBeNull();
        expect(screen.queryByText('speed = 16,')).toBeNull();
    });

    it('expands into one full diff card per file, with the path, churn and hunk rows', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        fireEvent.click(screen.getByRole('button'));

        const cards = screen.getAllByRole('listitem');
        expect(cards).toHaveLength(2);
        expect(within(cards[0]!).getByText('src/ServerScriptService/Combat.lua')).toBeInTheDocument();
        expect(within(cards[1]!).getByText('src/ReplicatedStorage/Config.lua')).toBeInTheDocument();
        // The complete change, not a one-line-per-file list: added source lines are readable.
        expect(screen.getByText('local Combat = {}')).toBeInTheDocument();
        expect(screen.getByText('speed = 16,')).toBeInTheDocument();
        expect(screen.getByText('jump = 50,')).toBeInTheDocument();
        // Both the removed original and the added replacement are present.
        expect(screen.getByText('return {}')).toBeInTheDocument();
    });

    it('does not emit a ghost empty diff row for newline-terminated payloads', () => {
        // Both sides end with '\n' and share a line, so the old split left an empty terminator
        // element on each side that the LCS matched into an `eq` row holding only line numbers.
        const shared = changeOf('src/Shared.lua', 'local x = 1\nlocal y = 2\n', 'local x = 1\nlocal y = 3\n');
        const { container } = render(<TurnWorkSummary summary={summaryOf({
            files: 1,
            additions: 1,
            deletions: 1,
            changes: [shared],
        })} />);
        fireEvent.click(screen.getByRole('button'));

        const rows = [...container.querySelectorAll('[data-diff-kind]')];
        expect(rows.length).toBeGreaterThan(0);
        const contentOf = (row: Element): string => {
            // The last span is the row's text; the gutter and prefix are the earlier spans.
            const spans = row.querySelectorAll('span');
            return spans[spans.length - 1]?.textContent ?? '';
        };
        // No row may consist only of gutter numbers and a prefix.
        expect(rows.filter((row) => contentOf(row) === '')).toHaveLength(0);
        expect(rows.map((row) => row.getAttribute('data-diff-kind'))).toEqual(['eq', 'del', 'add']);
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
