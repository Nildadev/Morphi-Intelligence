import type { SessionDetail } from '../../types';
import { vi } from '../../i18n/vi';
import { MessageItem } from './MessageItem';

export interface ChildSessionPanelProps {
    detail: SessionDetail | null;
    loading: boolean;
    failed: boolean;
}

/**
 * Read-only transcript of a subagent's child session inside the docked side panel. It reuses
 * `MessageItem`, so thinking blocks, tool rows and edit rows keep the exact transcript chrome of
 * the main conversation; the parent session is never replaced, and the child has no composer or
 * regenerate/undo controls of its own.
 */
export function ChildSessionPanel({ detail, loading, failed }: ChildSessionPanelProps) {
    if (failed) {
        return <p className="p-4 text-ui-sm text-danger-text">{vi.chat.sidePanelLoadError}</p>;
    }
    if (loading || detail === null) {
        return (
            <p role="status" className="animate-shiny p-4 text-ui-sm text-text-secondary">
                {vi.chat.sidePanelLoading}
            </p>
        );
    }
    if (detail.messages.length === 0) {
        return <p className="p-4 text-ui-sm text-text-tertiary">{vi.chat.sidePanelEmpty}</p>;
    }
    return (
        <div className="mx-auto w-full px-3 py-3">
            {detail.messages.map((message) => (
                <MessageItem key={message.id} message={message} />
            ))}
        </div>
    );
}

export default ChildSessionPanel;
