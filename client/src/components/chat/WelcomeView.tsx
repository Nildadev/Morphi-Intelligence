import { Sparkles } from '../icons';
import { vi } from '../../i18n/vi';

interface WelcomeViewProps {
    /** Sends the suggestion verbatim — no hidden prompt expansion. */
    onSuggestion: (text: string) => void;
    disabled?: boolean;
    /** Active project, used only for the quiet context line under the heading. */
    projectName?: string;
}

/**
 * Empty-transcript welcome. The visual centre follows the Codex-style desktop shell: the product
 * mark (the same sparkles glyph as the sidebar tile) and heading in the middle of the column, with
 * the four suggestion rows pinned just above the composer. The heading stays the literal
 * `vi.welcome.greeting`; the project name is a separate line so the transcript's empty state
 * never invents copy.
 */
export function WelcomeView({ onSuggestion, disabled = false, projectName }: WelcomeViewProps) {
    return (
        <div className="mx-auto flex h-full w-full max-w-[730px] flex-col px-4 pb-3">
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <div
                    aria-hidden="true"
                    className="mb-7 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent text-bg-main shadow-premium"
                >
                    <Sparkles size={30} />
                </div>
                <h1 className="text-[32px] font-normal leading-tight text-text-primary">
                    {vi.welcome.greeting}
                </h1>
                <p className="mt-3 max-w-[520px] text-ui-base leading-6 text-text-secondary">
                    {projectName
                        ? vi.welcome.projectHint.replace('{project}', projectName)
                        : vi.welcome.subtitle}
                </p>
            </div>

            <div className="grid grid-cols-1 gap-1.5 pb-2 sm:grid-cols-2">
                {vi.welcome.suggestions.map((suggestion) => (
                    <button
                        key={suggestion}
                        type="button"
                        disabled={disabled}
                        onClick={() => onSuggestion(suggestion)}
                        className="flex h-10 w-full items-center rounded-xl border border-border bg-bg-card px-4 text-left text-[13px] text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed"
                    >
                        {suggestion}
                    </button>
                ))}
            </div>
        </div>
    );
}

export default WelcomeView;
