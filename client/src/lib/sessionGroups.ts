import { vi } from '../i18n/vi';
import type { Project, SessionSummary } from '../types';

/**
 * Task 21 recents grouping.
 *
 * Groups are LOCAL CALENDAR days, never `now - lastUpdated < 24h`: a 23:00 session yesterday and a
 * 01:00 session today are two hours apart but belong to two different groups. Pinned sessions are
 * pulled out into the leading `Đã ghim` group; every group keeps `lastUpdated` descending.
 */
export interface SessionGroup {
    label: string;
    sessions: SessionSummary[];
}

const DAY_MS = 86_400_000;

/** Local calendar-day ordinal (UTC arithmetic on the LOCAL y/m/d fields avoids DST holes). */
const localDay = (timestamp: number): number => {
    const date = new Date(timestamp);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
};

const byLastUpdatedDesc = (a: SessionSummary, b: SessionSummary): number =>
    b.lastUpdated - a.lastUpdated;

export function groupSessionsByTime(
    sessions: SessionSummary[],
    now: number = Date.now(),
): SessionGroup[] {
    const pinned: SessionSummary[] = [];
    const today: SessionSummary[] = [];
    const yesterday: SessionSummary[] = [];
    const lastSeven: SessionSummary[] = [];
    const older: SessionSummary[] = [];

    const todayIndex = localDay(now);

    for (const session of sessions) {
        if (session.isPinned) {
            pinned.push(session);
            continue;
        }
        const dayDelta = todayIndex - localDay(session.lastUpdated);
        if (dayDelta <= 0) today.push(session);
        else if (dayDelta === 1) yesterday.push(session);
        else if (dayDelta <= 7) lastSeven.push(session);
        else older.push(session);
    }

    const groups: SessionGroup[] = [
        { label: vi.sidebar.groups.pinned, sessions: pinned },
        { label: vi.sidebar.groups.today, sessions: today },
        { label: vi.sidebar.groups.yesterday, sessions: yesterday },
        { label: vi.sidebar.groups.last7, sessions: lastSeven },
        { label: vi.sidebar.groups.older, sessions: older },
    ];

    return groups
        .filter(group => group.sessions.length > 0)
        .map(group => ({ ...group, sessions: [...group.sessions].sort(byLastUpdatedDesc) }));
}

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Codex-style relative age for a sidebar row: `5m`, `23h`, `1d`, `18d`.
 * Thresholds are elapsed-time, not calendar days, so a row never reads "today"
 * while the groups above it do — the row itself is the clock.
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
    const diff = Math.max(0, now - timestamp);
    if (diff < MIN_MS) return 'vừa';
    if (diff < HOUR_MS) return `${Math.floor(diff / MIN_MS)}m`;
    if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
    return `${Math.floor(diff / DAY_MS)}d`;
}

export interface ProjectSessionGroup {
    project: Project | null;
    label: string;
    sessions: SessionSummary[];
}

/**
 * Project-grouped sidebar: one header per project (newest activity first), each
 * holding its chats pinned-first then `lastUpdated` descending. Projects with no
 * chats still render as a bare header. Sessions whose project is missing from the
 * project list fall into a trailing group named after `projectName`.
 */
export function groupSessionsByProject(
    sessions: SessionSummary[],
    projects: Project[],
): ProjectSessionGroup[] {
    const byProject = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
        const bucket = byProject.get(session.projectId) ?? [];
        bucket.push(session);
        byProject.set(session.projectId, bucket);
    }
    const latestOf = (list: SessionSummary[]): number =>
        list.reduce((max, s) => Math.max(max, s.lastUpdated), 0);
    const sortSessions = (list: SessionSummary[]): SessionSummary[] => [...list].sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return b.lastUpdated - a.lastUpdated;
    });

    const groups: ProjectSessionGroup[] = projects.map((project) => ({
        project,
        label: project.name,
        sessions: sortSessions(byProject.get(project.id) ?? []),
    }));
    const known = new Set(projects.map((project) => project.id));
    for (const [projectId, list] of byProject) {
        if (known.has(projectId)) continue;
        groups.push({
            project: null,
            label: list[0]?.projectName ?? projectId,
            sessions: sortSessions(list),
        });
    }
    return groups.sort((a, b) => latestOf(b.sessions) - latestOf(a.sessions));
}

export default groupSessionsByTime;
