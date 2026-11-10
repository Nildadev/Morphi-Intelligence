import { describe, expect, it } from 'vitest';
import { changesOfCall, diffLines, summarizeTurnChanges } from './turnChanges';
import type { DerivedToolCall } from '../types';

const call = (over: Partial<DerivedToolCall>): DerivedToolCall => ({
    callId: 'c1',
    name: 'studio.edit_script',
    args: {},
    status: 'done',
    ...over,
});

const editArgs = (path: string, oldText: string, newText: string) => ({ path, old: oldText, source: newText });

describe('diffLines', () => {
    it('counts a pure insertion as added lines and nothing removed', () => {
        const { added, removed } = diffLines('a\nb', 'a\nb\nc');
        expect({ added, removed }).toEqual({ added: 1, removed: 0 });
    });

    it('counts a pure deletion', () => {
        const { added, removed } = diffLines('a\nb\nc', 'a\nc');
        expect({ added, removed }).toEqual({ added: 0, removed: 1 });
    });

    it('treats a replacement as one add plus one remove', () => {
        const { added, removed } = diffLines('a\nb', 'a\nB');
        expect({ added, removed }).toEqual({ added: 1, removed: 1 });
    });

    it('falls back to all-added/all-removed past the 2000-line cap instead of allocating O(n·m)', () => {
        const big = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join('\n');
        const { added, removed, ops } = diffLines('', big);
        expect(added).toBe(2001);
        expect(removed).toBe(0);
        expect(ops).toHaveLength(2001);
    });

    it('an unchanged text is all "eq", zero churn', () => {
        const { added, removed } = diffLines('same\ntext', 'same\ntext');
        expect({ added, removed }).toEqual({ added: 0, removed: 0 });
    });

    it('drops the trailing newline on both sides instead of emitting a ghost empty row', () => {
        // Real payloads end with '\n'. Splitting naively leaves '' in BOTH arrays, the LCS
        // matches the two terminators and the renderer prints a row with only two line numbers.
        const { ops, added, removed } = diffLines('return {}\n', 'return {\n  speed = 16,\n  jump = 50,\n}\n');
        expect(ops.some((op) => op.kind === 'eq' && op.text === '')).toBe(false);
        expect(ops.filter((op) => op.kind === 'eq')).toHaveLength(0);
        expect({ added, removed }).toEqual({ added: 4, removed: 1 });
    });

    it('keeps a genuine interior blank line, which is real content', () => {
        const { ops } = diffLines('a\n\nb\n', 'a\n\nc\n');
        const blank = ops.filter((op) => op.kind === 'eq' && op.text === '');
        expect(blank).toHaveLength(1);
    });

    it('keeps a genuine trailing blank line: only ONE terminating empty element is dropped', () => {
        // 'a\n\n' is the line "a" followed by an empty line; dropping the terminator must leave
        // that empty line in place, otherwise the diff silently loses a real line.
        const { ops, added, removed } = diffLines('a\n\n', 'a\nb\n');
        expect({ added, removed }).toEqual({ added: 1, removed: 1 });
        expect(ops.filter((op) => op.kind === 'del').map((op) => op.text)).toEqual(['']);
    });

    it('still reports a pure insertion when only the new text is newline-terminated', () => {
        expect(diffLines('a\nb', 'a\nb\nc\n')).toMatchObject({ added: 1, removed: 0 });
    });
});

describe('changesOfCall', () => {
    it('reads a flat edit call', () => {
        const changes = changesOfCall(call({ args: editArgs('src/Foo.lua', 'a', 'a\nb') }));
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'src/Foo.lua', added: 1, removed: 0 });
    });

    it('accepts every alias the payloads really use', () => {
        // The four path aliases and the before/after aliases are not interchangeable in theory but
        // are all present in real Studio tool calls; a missed alias silently drops a changed file.
        for (const args of [
            { filename: 'A.lua', old_string: 'x', new_string: 'x\ny' },
            { script: 'A.lua', oldText: 'x', newText: 'x\ny' },
            { target: 'A.lua', before: 'x', code: 'x\ny' },
            { file: 'A.lua', old: 'x', content: 'x\ny' },
        ]) {
            expect(changesOfCall(call({ args }))[0]?.path, JSON.stringify(args)).toBe('A.lua');
        }
    });

    it('expands a multi_edit array into one change per file', () => {
        const changes = changesOfCall(call({
            name: 'studio.multi_edit',
            args: { edits: [editArgs('a.lua', '', 'one'), editArgs('b.lua', '', 'two\nlines')] },
        }));
        expect(changes.map((change) => change.path)).toEqual(['a.lua', 'b.lua']);
        expect(changes.map((change) => change.added)).toEqual([1, 2]);
    });

    it('accepts a bare array as args (the other multi_edit shape)', () => {
        const changes = changesOfCall(call({
            name: 'studio.multi_edit',
            args: [editArgs('a.lua', '', 'one'), editArgs('b.lua', '', 'two')],
        }));
        expect(changes.map((change) => change.path)).toEqual(['a.lua', 'b.lua']);
    });

    it('prefers the explicit edit list over a flat path on the same call', () => {
        // A multi_edit that also carries `path` must not double-count the parent path as a file.
        const changes = changesOfCall(call({
            name: 'studio.multi_edit',
            args: { path: 'ignored.lua', edits: [editArgs('a.lua', '', 'one')] },
        }));
        expect(changes.map((change) => change.path)).toEqual(['a.lua']);
    });

    it('skips calls that are not edit tools, are not settled, or carry no path', () => {
        expect(changesOfCall(call({ name: 'studio.read_script', args: editArgs('a.lua', '', 'x') }))).toEqual([]);
        expect(changesOfCall(call({ status: 'running', args: editArgs('a.lua', '', 'x') }))).toEqual([]);
        expect(changesOfCall(call({ args: { old: 'a', source: 'b' } }))).toEqual([]);
        expect(changesOfCall(call({ args: null }))).toEqual([]);
    });

    it('keeps a touched-but-empty edit as a zero-churn file rather than dropping it', () => {
        // A write with no before/after text still means "this file was touched"; hiding it would
        // make the file count disagree with what the user saw in the tool card.
        const changes = changesOfCall(call({ args: { path: 'empty.lua' } }));
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'empty.lua', added: 0, removed: 0 });
    });
});

describe('summarizeTurnChanges', () => {
    it('returns null when nothing was written, so no "0 files" line is rendered', () => {
        expect(summarizeTurnChanges([])).toBeNull();
        expect(summarizeTurnChanges([call({ name: 'studio.read_script', args: { path: 'a.lua' } })])).toBeNull();
    });

    it('counts a file edited twice in one turn ONCE, keeping the last write', () => {
        // Two writes to the same file are one changed file. The final workspace content is the
        // second write, so its diff is the one reported — summing both would overstate churn.
        const summary = summarizeTurnChanges([
            call({ args: editArgs('a.lua', '', 'first') }),
            call({ args: editArgs('a.lua', 'first', 'first\nsecond') }),
        ]);
        expect(summary).not.toBeNull();
        expect(summary?.files).toBe(1);
        expect(summary?.additions).toBe(1);
        expect(summary?.deletions).toBe(0);
    });

    it('sums additions and deletions across distinct files', () => {
        const summary = summarizeTurnChanges([
            call({ args: editArgs('a.lua', '', 'one\ntwo') }),
            call({ name: 'studio.create_script', args: { path: 'b.lua', source: 'x' } }),
            call({ name: 'studio.write_script', args: { path: 'c.lua', old: 'gone', source: '' } }),
        ]);
        expect(summary).toMatchObject({ files: 3, additions: 3, deletions: 1 });
    });

    it('keeps first-seen order for the per-file list', () => {
        const summary = summarizeTurnChanges([
            call({ args: editArgs('z.lua', '', 'x') }),
            call({ args: editArgs('a.lua', '', 'y') }),
        ]);
        expect(summary?.changes.map((change) => change.path)).toEqual(['z.lua', 'a.lua']);
    });

    it('a multi_edit counts every file it touched', () => {
        const summary = summarizeTurnChanges([call({
            name: 'studio.multi_edit',
            args: { edits: [editArgs('a.lua', '', 'one'), editArgs('b.lua', '', 'two')] },
        })]);
        expect(summary).toMatchObject({ files: 2, additions: 2, deletions: 0 });
    });
});
