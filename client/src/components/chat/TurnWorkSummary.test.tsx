import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TurnWorkSummary } from './TurnWorkSummary';
import { diffLines, type ScriptChange, type TurnChangeSummary } from '../../lib/turnChanges';

afterEach(() => cleanup());

const changeOf = (path: string, oldText: string, newText: string, status?: ScriptChange['status']): ScriptChange => {
    const { ops, added, removed } = diffLines(oldText, newText);
    return { path, added, removed, ops, ...(status === undefined ? {} : { status }) };
};

const summaryOf = (over: Partial<TurnChangeSummary> = {}): TurnChangeSummary => ({
    scripts: 2,
    additions: 12,
    deletions: 3,
    changes: [
        changeOf('ServerScriptService/Combat', '', 'local Combat = {}\n\nreturn Combat', 'done'),
        changeOf('ReplicatedStorage/Config', 'return {}\n', 'return {\n  speed = 16,\n  jump = 50,\n}\n', 'done'),
    ],
    ...over,
});

describe('TurnWorkSummary', () => {
    it('states the script count and line churn in the collapsed row', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.getByText('2 script đã thay đổi')).toBeInTheDocument();
        expect(screen.getByText('+12')).toBeInTheDocument();
        expect(screen.getByText('−3')).toBeInTheDocument();
    });

    it('uses the singular sentence for one script instead of "1 script đã thay đổi"', () => {
        render(<TurnWorkSummary summary={summaryOf({
            scripts: 1,
            changes: [changeOf('ServerScriptService/Combat', '', 'x')],
        })} />);
        expect(screen.getByText('1 script đã thay đổi')).toBeInTheDocument();
    });

    it('starts collapsed: no list rows and no script paths until clicked', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.queryByRole('list')).toBeNull();
        expect(screen.queryByText('ServerScriptService/Combat')).toBeNull();
        expect(screen.queryByText('ReplicatedStorage/Config')).toBeNull();
    });

    it('expands into a plain list: one row per script with path and churn', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        fireEvent.click(screen.getByRole('button'));

        const rows = screen.getAllByRole('listitem');
        expect(rows).toHaveLength(2);
        expect(within(rows[0]!).getByText('ServerScriptService/Combat')).toBeInTheDocument();
        expect(within(rows[1]!).getByText('ReplicatedStorage/Config')).toBeInTheDocument();
        // Per-row churn comes from that script's own diff, not from the turn totals.
        expect(within(rows[0]!).getByText('+3')).toBeInTheDocument();
        expect(within(rows[1]!).getByText('+4')).toBeInTheDocument();
        expect(within(rows[1]!).getByText('−1')).toBeInTheDocument();
        // The known status is shown next to the path.
        expect(within(rows[0]!).getByText('Hoàn tất')).toBeInTheDocument();
    });

    it('never renders diff rows — the summary is a table of contents, not a diff viewer', () => {
        const { container } = render(<TurnWorkSummary summary={summaryOf()} />);
        fireEvent.click(screen.getByRole('button'));

        // The source text exists in the fixture but must not be painted here: the diff lives on
        // the edit tool call that produced it.
        expect(screen.queryByText('local Combat = {}')).toBeNull();
        expect(screen.queryByText('speed = 16,')).toBeNull();
        expect(screen.queryByText('jump = 50,')).toBeNull();
        expect(screen.queryByText('return {}')).toBeNull();
        expect(container.querySelector('[data-diff-kind]')).toBeNull();
    });

    it('puts the full script path in the row title so truncation is never lossy', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        fireEvent.click(screen.getByRole('button'));

        expect(screen.getByText('ServerScriptService/Combat')).toHaveAttribute('title', 'ServerScriptService/Combat');
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

    it('labels the trigger with the count and the fact that it is a script list', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.getByRole('button')).toHaveAttribute(
            'aria-label',
            '2 script đã thay đổi · Các script đã thay đổi trong lượt này',
        );
    });
});

describe('TurnWorkSummary - framed row with the Undo action', () => {
    it('draws a bordered container, not a bare line', () => {
        const { container } = render(<TurnWorkSummary summary={summaryOf()} />);
        const frame = container.firstElementChild as HTMLElement;
        expect(frame.className).toContain('border');
        expect(frame.className).toContain('rounded-xl');
        expect(frame.className).toContain('bg-bg-card');
    });

    it('shows Undo next to the count, visible while collapsed', () => {
        const onUndo = vi.fn();
        render(<TurnWorkSummary summary={summaryOf()} onUndo={onUndo} />);
        const undo = screen.getByRole('button', { name: 'Hoàn tác' });
        expect(undo).toBeVisible();
        // The list is still collapsed, so Undo does not require expanding first.
        expect(screen.queryByRole('list')).toBeNull();
    });

    it('calls the handler once per click', () => {
        const onUndo = vi.fn();
        render(<TurnWorkSummary summary={summaryOf()} onUndo={onUndo} />);
        fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
        expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it('shows no Undo button when there is no restore path', () => {
        render(<TurnWorkSummary summary={summaryOf()} />);
        expect(screen.queryByRole('button', { name: 'Hoàn tác' })).toBeNull();
    });

    it('reports the request in flight instead of accepting a second click', () => {
        render(<TurnWorkSummary summary={summaryOf()} onUndo={() => undefined} undoBusy />);
        const undo = screen.getByRole('button', { name: 'Hoàn tác' });
        expect(undo).toBeDisabled();
        expect(undo).toHaveTextContent('Đang hoàn tác…');
    });

    it('hides Undo on a live turn, where nothing has settled yet', () => {
        render(<TurnWorkSummary summary={summaryOf()} onUndo={() => undefined} live />);
        expect(screen.queryByRole('button', { name: 'Hoàn tác' })).toBeNull();
    });
});
