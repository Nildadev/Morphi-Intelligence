import type { LucideIcon } from '../icons';
import { Bot, Eraser, FilePlus2, Flag, HelpCircle, ListChecks, ListTree, PanelLeftOpen, Search, Settings2 } from '../icons';
import { vi } from '../../i18n/vi';

export type SlashSection = 'skills' | 'commands';

/** A client-side slash command wired to a ChatInterface action (new-chat, clear, …). */
export interface SlashCommand {
    id: string;
    /** Token typed after the slash, e.g. "new" renders the trigger "/new". */
    token: string;
    icon: LucideIcon;
}

/** Commands always offered by the composer, independent of the server. */
export const SLASH_COMMANDS: SlashCommand[] = [
    { id: 'new-chat', token: 'new', icon: FilePlus2 },
    { id: 'clear', token: 'clear', icon: Eraser },
    { id: 'settings', token: 'settings', icon: Settings2 },
    { id: 'help', token: 'help', icon: HelpCircle },
    { id: 'search', token: 'search', icon: Search },
    { id: 'sidebar', token: 'sidebar', icon: PanelLeftOpen },
    { id: 'goal', token: 'goal', icon: Flag },
    { id: 'subagent', token: 'subagent', icon: Bot },
    { id: 'workflow', token: 'workflow', icon: ListTree },
    { id: 'plan', token: 'plan', icon: ListChecks },
];

/**
 * Commands that take a message argument typed after the token (`/goal <text>`). Selecting one in
 * the palette installs the `/token ` prefix and keeps the remainder; Enter then dispatches it
 * (see ChatInterface's handleSend).
 */
export const SLASH_ARG_COMMANDS: readonly string[] = ['goal', 'subagent', 'workflow', 'plan'];

/** Read lazily so descriptions follow the UI language. */
export function slashCommandDescription(id: string): string {
    const table: Record<string, string> = {
        'new-chat': vi.composer.slash.newChat,
        clear: vi.composer.slash.clear,
        settings: vi.composer.slash.settings,
        help: vi.composer.slash.help,
        search: vi.composer.slash.search,
        sidebar: vi.composer.slash.sidebar,
        goal: vi.composer.slash.goal,
        subagent: vi.composer.slash.subagent,
        workflow: vi.composer.slash.workflow,
        plan: vi.composer.slash.plan,
    };
    return table[id] ?? '';
}

/** One flattened, pre-filtered row the palette renders; `section` decides the group header. */
export interface SlashItem {
    key: string;
    kind: 'command' | 'skill';
    section: SlashSection;
    /** Command id, or skill name. */
    id: string;
    /** Display name: the command token, or the skill name. */
    label: string;
    description: string;
    icon: LucideIcon;
}
