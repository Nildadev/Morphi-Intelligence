import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Rail } from './Rail';
import type { Project, SessionSummary } from '../../types';

const NOW = Date.parse('2026-11-02T12:00:00Z');

const projects: Project[] = [
    { id: 'p1', name: 'Dự án Alpha', createdAt: NOW, lastActive: NOW },
    { id: 'p2', name: 'Dự án Beta', createdAt: NOW, lastActive: NOW },
];

const sessions: SessionSummary[] = [
    {
        id: 's1', projectId: 'p1', projectName: 'Dự án Alpha', title: 'Cuộc mới',
        createdAt: NOW, lastUpdated: NOW + 60_000, isPinned: false, status: 'idle',
        modelSelection: 'auto',
    },
    {
        id: 's2', projectId: 'p2', projectName: 'Dự án Beta', title: 'Cuộc cũ',
        createdAt: NOW, lastUpdated: NOW, isPinned: false, status: 'idle',
        modelSelection: 'auto',
    },
];

afterEach(() => cleanup());

describe('Rail popups', () => {
    it('opens the project switcher from the Folder icon and switches with a click', () => {
        const onSelectProject = vi.fn();
        render(
            <Rail
                onAction={vi.fn()}
                projects={projects}
                currentProjectId="p1"
                onSelectProject={onSelectProject}
                onNewProject={vi.fn()}
                sessions={[]}
                onSelectSession={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Dự án' }));
        expect(screen.getByRole('menu', { name: 'Dự án' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('menuitem', { name: /Dự án Beta/ }));
        expect(onSelectProject).toHaveBeenCalledWith('p2');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('offers "Dự án mới" as the project switcher footer', () => {
        const onNewProject = vi.fn();
        render(
            <Rail
                onAction={vi.fn()}
                projects={projects}
                currentProjectId="p1"
                onSelectProject={vi.fn()}
                onNewProject={onNewProject}
                sessions={[]}
                onSelectSession={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Dự án' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Dự án mới' }));

        expect(onNewProject).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens recent conversations from the Clock icon, newest first', () => {
        const onSelectSession = vi.fn();
        render(
            <Rail
                onAction={vi.fn()}
                projects={[]}
                currentProjectId={undefined}
                onSelectProject={vi.fn()}
                onNewProject={vi.fn()}
                sessions={sessions}
                currentSessionId="s1"
                onSelectSession={onSelectSession}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Gần đây' }));
        const menu = screen.getByRole('menu', { name: 'Gần đây' });
        expect(menu).toBeInTheDocument();

        const items = screen.getAllByRole('menuitem');
        expect(items[0]).toHaveTextContent('Cuộc mới');
        expect(items[1]).toHaveTextContent('Cuộc cũ');

        fireEvent.click(items[1]);
        expect(onSelectSession).toHaveBeenCalledWith('s2');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('keeps Search as the recents footer and shows the empty state', () => {
        const onAction = vi.fn();
        render(
            <Rail
                onAction={onAction}
                projects={[]}
                onSelectProject={vi.fn()}
                onNewProject={vi.fn()}
                sessions={[]}
                onSelectSession={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Gần đây' }));
        expect(screen.getByText('Chưa có cuộc trò chuyện')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('menuitem', { name: 'Tìm kiếm' }));
        expect(onAction).toHaveBeenCalledWith('search');
    });

    it('closes the popup with Escape and falls back without data', () => {
        const onAction = vi.fn();
        const { rerender } = render(
            <Rail
                onAction={onAction}
                projects={projects}
                currentProjectId="p1"
                onSelectProject={vi.fn()}
                onNewProject={vi.fn()}
                sessions={sessions}
                onSelectSession={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Gần đây' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();

        rerender(<Rail onAction={onAction} />);
        fireEvent.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
        expect(onAction).toHaveBeenCalledWith('search');
    });
});
