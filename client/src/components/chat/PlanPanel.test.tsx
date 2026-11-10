import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DerivedMessage } from '../../types';
import { PlanPanel } from './PlanPanel';

afterEach(() => cleanup());

const todoMessage = (todos: { title: string; status: 'todo' | 'doing' | 'done' }[], status: 'running' | 'done' = 'done'): DerivedMessage => ({
    id: `a-${todos.map(todo => todo.title).join('-')}-${status}`,
    role: 'assistant',
    content: '',
    steps: [{
        type: 'call',
        call: { callId: `c-${status}`, name: 'todo_write', args: {}, status, result: { todos } },
    }],
    createdAt: 1,
    superseded: false,
});

describe('PlanPanel', () => {
    it('hides itself when the session has no completed todo_write result', () => {
        const { container: empty } = render(<PlanPanel messages={[]} />);
        expect(empty).toBeEmptyDOMElement();

        const running = todoMessage([{ title: 'Đang dở', status: 'todo' }], 'running');
        const { container: uncompleted } = render(<PlanPanel messages={[running]} />);
        expect(uncompleted).toBeEmptyDOMElement();
        expect(screen.queryByText('Kế hoạch')).toBeNull();
    });

    it('renders the latest completed todo list with all three labels and a progress count', () => {
        const older = todoMessage([
            { title: 'Việc cũ', status: 'done' },
            { title: 'Việc cũ 2', status: 'done' },
        ]);
        const newer = todoMessage([
            { title: 'Khảo sát', status: 'done' },
            { title: 'Viết code', status: 'doing' },
            { title: 'Kiểm thử', status: 'todo' },
        ]);

        render(<PlanPanel messages={[older, newer]} />);

        expect(screen.getByText('Kế hoạch')).toBeInTheDocument();
        expect(screen.getByText('Khảo sát')).toBeInTheDocument();
        expect(screen.getByText('Viết code')).toBeInTheDocument();
        expect(screen.getByText('Kiểm thử')).toBeInTheDocument();
        expect(screen.getByText('Xong')).toBeInTheDocument();
        expect(screen.getByText('Đang làm')).toBeInTheDocument();
        expect(screen.getByText('Chưa làm')).toBeInTheDocument();
        expect(screen.getByText('1/3')).toBeInTheDocument();
        expect(screen.queryByText('Việc cũ')).toBeNull();
    });

    it('treats an empty todo array as no plan', () => {
        const { container } = render(<PlanPanel messages={[todoMessage([])]} />);
        expect(container).toBeEmptyDOMElement();
    });
});
