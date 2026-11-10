import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SearchPalette } from './SearchPalette';
import type { Project, SessionSummary } from '../../types';

/**
 * R25-5 (round-4 verdict debt): a project row used to print `vi.search.projects` ("Dự án") as its
 * OWN subtitle — a self-label, i.e. exactly the "không label giả" rule in spec §6.6.2. A section
 * heading already says "Dự án"; the row itself must not repeat it.
 */
const project: Project = {
    id: 'p-alpha',
    name: 'Alpha workspace',
    createdAt: 1,
    lastActive: 2,
};

const session: SessionSummary = {
    id: 's-one',
    projectId: 'p-alpha',
    projectName: 'Alpha workspace',
    title: 'Phiên đầu',
    createdAt: 1,
    lastUpdated: 2,
    isPinned: false,
    status: 'idle',
};

const renderPalette = () => render(
    <SearchPalette
        open
        projects={[project]}
        sessions={[session]}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectProject={vi.fn()}
    />,
);

afterEach(() => cleanup());

describe('SearchPalette result subtitles', () => {
    it('a project option has no self-label subtitle, while a session keeps its real project name', () => {
        renderPalette();

        const projectOption = screen.getByTestId('search-result-p-alpha');
        expect(within(projectOption).getByText('Alpha workspace')).toBeInTheDocument();
        // Trước khi sửa: `meta: vi.search.projects` in đúng chữ "Dự án" ngay trong chính option này.
        expect(within(projectOption).queryByText('Dự án')).toBeNull();

        const sessionOption = screen.getByTestId('search-result-s-one');
        expect(within(sessionOption).getByText('Phiên đầu')).toBeInTheDocument();
        expect(within(sessionOption).getByText('Alpha workspace')).toBeInTheDocument();
    });

    it('the listbox names the group exactly once, in its section heading', () => {
        renderPalette();
        // Trước khi sửa có 2: một ở heading, một tự dán làm phụ đề của chính option dự án.
        expect(within(screen.getByRole('listbox')).getAllByText('Dự án')).toHaveLength(1);
    });
});
