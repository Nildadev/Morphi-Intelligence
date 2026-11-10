import { CheckCircle2, Circle, Loader2, ListChecks } from '../icons';
import type { DerivedMessage } from '../../types';
import { vi } from '../../i18n/vi';

export type TodoStatus = 'todo' | 'doing' | 'done';

export interface TodoItem {
    title: string;
    status: TodoStatus;
}

const isTodoItem = (value: unknown): value is TodoItem => {
    if (typeof value !== 'object' || value === null) return false;
    const item = value as { title?: unknown; status?: unknown };
    return typeof item.title === 'string'
        && (item.status === 'todo' || item.status === 'doing' || item.status === 'done');
};

/** `todo_write` resolves `{ todos: { title, status }[] }` (server/src/harness/tools/builtin/todo.ts:31-34). */
function todosOf(result: unknown): TodoItem[] | null {
    let candidate = result;
    if (typeof candidate === 'string') {
        try {
            candidate = JSON.parse(candidate) as unknown;
        } catch {
            return null;
        }
    }
    if (typeof candidate !== 'object' || candidate === null) return null;
    const todos = (candidate as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) return null;
    return todos.filter(isTodoItem);
}

/**
 * The latest COMPLETED `todo_write` result in the session. A running call is not a plan yet, and a
 * later empty plan intentionally wins over an older non-empty one (the session's current state).
 */
export function latestTodos(messages: DerivedMessage[]): TodoItem[] | null {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const steps = messages[messageIndex].steps;
        for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
            const step = steps[stepIndex];
            if (step.type !== 'call') continue;
            if (step.call.name !== 'todo_write' || step.call.status !== 'done') continue;
            return todosOf(step.call.result);
        }
    }
    return null;
}

function statusMeta() {
    return {
        todo: { label: vi.chat.todo, Icon: Circle, className: 'text-text-tertiary' },
        doing: { label: vi.chat.doing, Icon: Loader2, className: 'text-brand-text' },
        done: { label: vi.chat.done, Icon: CheckCircle2, className: 'text-success-text' },
    } as const;
}

/**
 * Plan panel (brief Step 4): renders the latest completed `todo_write` result, `Chưa làm / Đang làm /
 * Xong` and a progress count. It renders NOTHING when the session has no todos — no empty shell.
 */
export function PlanPanel({ messages }: { messages: DerivedMessage[] }) {
    const todos = latestTodos(messages);
    if (todos === null || todos.length === 0) return null;

    const done = todos.filter(todo => todo.status === 'done').length;

    return (
        <section aria-label={vi.chat.planTitle} className="mb-4 rounded-xl border border-border bg-bg-card p-3">
            <div className="mb-2 flex items-center gap-2">
                <ListChecks aria-hidden="true" size={16} className="text-text-secondary" />
                <h2 className="flex-1 text-[15px] font-semibold text-text-primary">{vi.chat.planTitle}</h2>
                <span className="text-[13px] font-semibold text-text-secondary">{done}/{todos.length}</span>
            </div>
            <ul className="space-y-1">
                {todos.map(todo => {
                    const meta = statusMeta()[todo.status];
                    const Icon = meta.Icon;
                    return (
                        <li key={`${todo.title}-${todo.status}`} className="flex items-center gap-2 text-[13px]">
                            <Icon aria-hidden="true" size={14} className={meta.className} />
                            <span className="min-w-0 flex-1 truncate text-text-primary">{todo.title}</span>
                            <span className={meta.className}>{meta.label}</span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
