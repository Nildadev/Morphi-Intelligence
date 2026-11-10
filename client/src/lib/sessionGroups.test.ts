import { describe, expect, it } from 'vitest';
import type { Project, SessionSummary } from '../types';
import { formatRelativeTime, groupSessionsByProject, groupSessionsByTime } from './sessionGroups';

/**
 * Task 21 Step 1. `now` is the fixed instant named by the brief; all session timestamps are built
 * with local Date setters so the test exercises LOCAL calendar days on every machine/timezone.
 */
const NOW = Date.parse('2026-11-02T12:00:00Z');

const localDaysAgo = (days: number, hour = 12): number => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
};

const session = (id: string, lastUpdated: number, isPinned = false): SessionSummary => ({
    id,
    projectId: 'p1',
    projectName: 'Dự án Alpha',
    title: id,
    createdAt: lastUpdated,
    lastUpdated,
    isPinned,
    status: 'idle',
});

const labelsOf = (groups: ReturnType<typeof groupSessionsByTime>): string[] => groups.map(g => g.label);
const idsOf = (groups: ReturnType<typeof groupSessionsByTime>): string[][] => groups.map(g => g.sessions.map(s => s.id));

describe('groupSessionsByTime', () => {
    it('uses the brief labels for today, yesterday, 7 days and older', () => {
        const groups = groupSessionsByTime([
            session('today', localDaysAgo(0, 9)),
            session('yesterday', localDaysAgo(1, 9)),
            session('three-days', localDaysAgo(3, 9)),
            session('ten-days', localDaysAgo(10, 9)),
        ], NOW);

        expect(labelsOf(groups)).toEqual(['Hôm nay', 'Hôm qua', '7 ngày qua', 'Cũ hơn']);
        expect(idsOf(groups)).toEqual([['today'], ['yesterday'], ['three-days'], ['ten-days']]);
    });

    it('uses local calendar days, not 24h arithmetic (01:00 today vs 23:00 yesterday)', () => {
        // These two instants are only two hours apart. A `now - lastUpdated < 24h` implementation
        // puts both in "Hôm nay"; a local-calendar implementation must split them.
        const groups = groupSessionsByTime([
            session('today-0100', localDaysAgo(0, 1)),
            session('yesterday-2300', localDaysAgo(1, 23)),
        ], NOW);

        expect(labelsOf(groups)).toEqual(['Hôm nay', 'Hôm qua']);
        expect(idsOf(groups)).toEqual([['today-0100'], ['yesterday-2300']]);
    });

    it('puts the pinned group first and keeps lastUpdated descending inside every group', () => {
        const groups = groupSessionsByTime([
            session('today-older', localDaysAgo(0, 8)),
            session('pinned-old', localDaysAgo(20, 9), true),
            session('today-newer', localDaysAgo(0, 11)),
            session('yesterday', localDaysAgo(1, 9)),
        ], NOW);

        expect(labelsOf(groups)).toEqual(['Đã ghim', 'Hôm nay', 'Hôm qua']);
        expect(idsOf(groups)).toEqual([['pinned-old'], ['today-newer', 'today-older'], ['yesterday']]);
    });

    it('omits empty groups and does not mutate the caller array', () => {
        const input = [
            session('old', localDaysAgo(9, 9)),
            session('older', localDaysAgo(12, 9)),
        ];
        const snapshot = input.map(s => s.id);

        const groups = groupSessionsByTime(input, NOW);

        expect(labelsOf(groups)).toEqual(['Cũ hơn']);
        expect(idsOf(groups)).toEqual([['old', 'older']]);
        expect(input.map(s => s.id)).toEqual(snapshot);
    });

    it('returns an empty list when there are no sessions', () => {
        expect(groupSessionsByTime([], NOW)).toEqual([]);
    });
});

describe('formatRelativeTime', () => {
    it('reads minutes, hours and days as Codex-style ages', () => {
        expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('vừa');
        expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m');
        expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23h');
        expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1d');
        expect(formatRelativeTime(NOW - 18 * 86_400_000, NOW)).toBe('18d');
    });
});

describe('groupSessionsByProject', () => {
    const project = (id: string, name: string, lastActive: number): Project =>
        ({ id, name, createdAt: NOW, lastActive });
    const inProject = (id: string, projectId: string, lastUpdated: number, isPinned = false): SessionSummary => ({
        ...session(id, lastUpdated, isPinned),
        projectId,
        projectName: projectId === 'p1' ? 'Dự án Alpha' : projectId === 'p2' ? 'Dự án Beta' : projectId,
    });

    it('groups chats under their project, pinned first, newest activity first', () => {
        const groups = groupSessionsByProject([
            inProject('s1-old', 'p1', NOW - 86_400_000),
            inProject('s1-new', 'p1', NOW - 3_600_000),
            inProject('s1-pin', 'p1', NOW - 10 * 86_400_000, true),
            inProject('s2', 'p2', NOW - 2 * 86_400_000),
        ], [project('p1', 'Dự án Alpha', NOW), project('p2', 'Dự án Beta', NOW - 86_400_000)]);

        expect(groups.map(g => g.label)).toEqual(['Dự án Alpha', 'Dự án Beta']);
        expect(groups[0].sessions.map(s => s.id)).toEqual(['s1-pin', 's1-new', 's1-old']);
        expect(groups[1].sessions.map(s => s.id)).toEqual(['s2']);
    });

    it('keeps an empty project as a bare header and names orphan groups after the project', () => {
        const groups = groupSessionsByProject([
            inProject('orphan', 'gone', NOW),
        ], [project('p1', 'Dự án Alpha', NOW)]);

        expect(groups.map(g => g.label)).toEqual(['gone', 'Dự án Alpha']);
        expect(groups[0].project).toBeNull();
        expect(groups[1].sessions).toEqual([]);
    });
});
