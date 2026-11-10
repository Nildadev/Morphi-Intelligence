import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type ClipboardEvent,
    type KeyboardEvent,
} from 'react';
import { AlertTriangle, ArrowUp, Brain, Check, FileText, Folder, Globe, Plus, ShieldCheck, Sparkles, Square, TriangleAlert, X } from '../icons';
import type { ChatAttachment, ModelInfo, PermissionMode, ReasoningEffort, SkillMeta } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { ModelPicker } from './ModelPicker';
import { ContextRing } from './ContextRing';
import { SlashPalette } from './SlashPalette';
import { ImageLightbox } from './ImageLightbox';
import { SLASH_COMMANDS, SLASH_ARG_COMMANDS, slashCommandDescription, type SlashItem } from './slashCommands';

export interface ComposerProps {
    /** `false` means the parent rejected the turn — the draft must stay in the textarea. */
    onSend: (
        text: string,
        model?: string,
        effort?: ReasoningEffort,
        permission?: PermissionMode,
        attachments?: ChatAttachment[],
    ) => boolean | void;
    onStop: () => void;
    disabled?: boolean;
    streaming?: boolean;
    /** Stop during this window restores the submitted draft (Ruling T22-6/C13). */
    starting?: boolean;
    models: ModelInfo[];
    selectedModel: string;
    onSelectModel: (id: string) => void;
    /** Chosen reasoning level; `''` means "send no knob at all". */
    effort: ReasoningEffort | '';
    onSelectEffort: (effort: ReasoningEffort | '') => void;
    /** Chosen approval mode for the next turn; sent to the server's approval gate. */
    permission: PermissionMode;
    onSelectPermission: (mode: PermissionMode) => void;
    onOpenSettings: () => void;
    onReloadModels?: () => void;
    /** Tokens the conversation has spent against the selected model's window (sum of message usage). */
    usedTokens: number;
    /** The selected model's declared context window in tokens; hides the ring when absent. */
    totalTokens: number;
    /** Model display name, shown in the ring's hover detail. */
    modelName: string;
    /** Server skill catalogue, shown as the "Kỹ năng" section of the "/" palette. */
    skills?: SkillMeta[];
    /** Runs a client command chosen from the "/" palette (new-chat, clear, settings, …). */
    onRunCommand?: (command: string) => void;
    /** Client-side rejections that need the user's attention (e.g. an image pasted for a
     *  text-only model). The parent shows it (toast); the composer never stages silently. */
    onNotify?: (message: string) => void;
    /** Text to restore into the textarea (e.g. after undoing a user message). */
    externalDraft?: { text: string; nonce: number } | null;
    /** Steering messages waiting in the server inbox, oldest first (queue card above the input). */
    queuedMessages?: string[];
    /** Drops the server inbox wait; the card disappears once the clear is confirmed. */
    onClearQueued?: () => void;
}

/**
 * Bottom composer (Ruling U5/T22-7): one card with the textarea row and the toolbar row, 730px
 * column, 20px radius, 200px auto-grow cap.
 *
 * Composer controls (per the latest redesign):
 * - The `+` button opens a file/image picker (and clipboard images can be pasted straight into the
 *   textarea); staged attachments show as removable chips above the textarea.
 * - The **permission pill** sits immediately to the right of the `+` button.
 * - The **effort pill** reveals a custom-styled draggable slider (no native range chrome).
 * - The send control is foreground-coloured (Ruling U2/T22-5), never accent-as-text, and uses
 *   the up-arrow icon shared with the other chat shells.
 *
 * Model selection (Task 31D):
 * - Clicking the **model name** (the `ModelPicker` chip) opens the model list.
 * - Clicking the **effort pill** reveals a draggable slider (one stop per level the model declares) to pick the reasoning level.
 * - Clicking the **permission pill** reveals the three approval modes (ask / balanced / full).
 */
/** Label maps read `vi` lazily so they follow the UI language set in Settings. */
const effortLabel = (level: ReasoningEffort): string => ({
    minimal: vi.composer.effortMinimal ?? 'Tối thiểu',
    low: vi.composer.effortLow,
    medium: vi.composer.effortMedium,
    high: vi.composer.effortHigh,
    xhigh: vi.composer.effortXHigh ?? 'Rất cao',
    max: vi.composer.effortMax ?? 'Tối đa',
})[level];

const permissionLabel = (mode: PermissionMode): string => ({
    ask: vi.composer.permissionAsk,
    balanced: vi.composer.permissionBalanced,
    full: vi.composer.permissionFull,
})[mode];

const permissionHint = (mode: PermissionMode): string => ({
    ask: vi.composer.permissionAskHint,
    balanced: vi.composer.permissionBalancedHint,
    full: vi.composer.permissionFullHint,
})[mode];

/** Brand green is the safe default; full access reads as amber so the risk is visible at a glance. */
const PERMISSION_ICON_COLOR: Record<PermissionMode, string> = {
    ask: 'var(--text-secondary)',
    balanced: 'var(--brand-text)',
    full: '#f59e0b',
};

/** A file or image held in the composer before the user sends the turn. */
interface StagedAttachment {
    id: string;
    name: string;
    mime: string;
    size: number;
    /** Full `data:` URL, used for the preview thumbnail. */
    dataUrl: string;
    kind: 'image' | 'file';
}

const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsDataURL(file);
    });

export function Composer({
    onSend,
    onStop,
    disabled = false,
    streaming = false,
    starting = false,
    models,
    selectedModel,
    onSelectModel,
    effort,
    onSelectEffort,
    permission,
    onSelectPermission,
    onOpenSettings,
    onReloadModels,
    usedTokens,
    totalTokens,
    modelName,
    skills = [],
    onRunCommand = () => {},
    onNotify,
    externalDraft = null,
    queuedMessages = [],
    onClearQueued,
}: ComposerProps) {
    const [text, setText] = useState('');
    const [effortOpen, setEffortOpen] = useState(false);
    const [permissionOpen, setPermissionOpen] = useState(false);
    const [confirmFull, setConfirmFull] = useState(false);
    const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
    const [preview, setPreview] = useState<StagedAttachment | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const effortButtonRef = useRef<HTMLButtonElement>(null);
    const permissionButtonRef = useRef<HTMLButtonElement>(null);
    const submittedRef = useRef('');
    /** `"/"` palette: the row the keyboard currently highlights. */
    const [slashActiveIndex, setSlashActiveIndex] = useState(0);
    /** When the user hits Escape we hide the palette until the text changes again. */
    const [slashDismissed, setSlashDismissed] = useState(false);

    useEffect(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.style.height = 'auto';
        if (text !== '') element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    }, [text]);

    useEffect(() => {
        if (externalDraft === null) return;
        setText(externalDraft.text);
        setSlashDismissed(false);
        setSlashActiveIndex(0);
        requestAnimationFrame(() => {
            const element = textareaRef.current;
            if (!element) return;
            element.focus();
            element.setSelectionRange(element.value.length, element.value.length);
        });
    }, [externalDraft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

    // Chỉ model tự khai `efforts` mới có slider này: model không khai thì không có gì để chọn.
    const efforts = models.find(model => model.id === selectedModel)?.efforts ?? [];

    useEffect(() => {
        if (!effortOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setEffortOpen(false);
        };
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setEffortOpen(false);
            effortButtonRef.current?.focus();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [effortOpen]);

    useEffect(() => {
        if (!permissionOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPermissionOpen(false);
        };
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setPermissionOpen(false);
            permissionButtonRef.current?.focus();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [permissionOpen]);

    // `submittedRef` chỉ là bản nháp của CHÍNH lượt đang mở. Khi `starting` rơi về false, lượt đó đã
    // kết thúc — giữ lại bản nháp thì một lượt sau do WelcomeView khởi động sẽ khôi lời tin nhắn cũ.
    useEffect(() => {
        if (!starting) submittedRef.current = '';
    }, [starting]);

    const stageFiles = async (files: FileList | File[]) => {
        const incoming = Array.from(files);
        if (incoming.length === 0) return;
        // Only vision models (catalogue `input_modalities` says `image`) may receive image
        // attachments. Unknown/auto stays permissive; an explicit text-only model is refused
        // up front with a reason, not silently dropped at the provider.
        const selected = selectedModel ? models.find(model => model.id === selectedModel) : undefined;
        const imagesAllowed = selected?.supportsImages !== false;
        // Notify synchronously for the obvious case (File.type present), so the user sees the
        // refusal without waiting for the file to be read. Files with an empty type are classified
        // only after their bytes arrive below.
        if (!imagesAllowed && incoming.some((file) => (file.type || '').startsWith('image/'))) {
            onNotify?.(vi.composer.imageUnsupported);
        }
        const resolved = await Promise.all(incoming.map(async (file) => {
            const dataUrl = await readFileAsDataUrl(file);
            // Clipboard screenshots can carry no File.type in Electron/Chromium; parse the data URL
            // so the preview and `mime` still come from the real bytes instead of the empty field.
            const dataUrlMime = /^data:([^;,]+)?/i.exec(dataUrl)?.[1] ?? '';
            const mime = file.type || dataUrlMime || 'application/octet-stream';
            const kind: 'image' | 'file' = (file.type || dataUrlMime).startsWith('image/') ? 'image' : 'file';
            return {
                file,
                attachment: {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    name: file.name || (kind === 'image' ? `image.${mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'}` : 'attachment'),
                    mime,
                    size: file.size,
                    dataUrl,
                    kind,
                } satisfies StagedAttachment,
            };
        }));
        const images = resolved.filter(({ attachment }) => attachment.kind === 'image');
        if (!imagesAllowed && images.length > 0 && !incoming.some((file) => (file.type || '').startsWith('image/'))) {
            onNotify?.(vi.composer.imageUnsupported);
        }
        const staged = (imagesAllowed ? resolved : resolved.filter(({ attachment }) => attachment.kind !== 'image'))
            .map(({ attachment }) => attachment);
        setAttachments(prev => [...prev, ...staged]);
    };

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) void stageFiles(event.target.files);
        // Reset so picking the same file again still fires `change`.
        event.target.value = '';
    };

    /** Paste images (or any file) straight from the clipboard into the attachment tray. */
    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const item of Array.from(items)) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) {
            event.preventDefault();
            void stageFiles(files);
        }
    };

    const removeAttachment = (id: string) => {
        setAttachments(prev => prev.filter(attachment => attachment.id !== id));
    };

    const submit = () => {
        const value = text.trim();
        if ((!value && attachments.length === 0) || disabled) return;
        const payload: ChatAttachment[] = attachments.map(attachment => ({
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
            // `dataUrl` is `data:<mime>;base64,<data>`; ship only the base64 payload.
            data: attachment.dataUrl.includes(',') ? attachment.dataUrl.split(',')[1] : attachment.dataUrl,
        }));
        const accepted = onSend(value, selectedModel || undefined, effort || undefined, permission, payload);
        if (accepted === false) return;
        submittedRef.current = value;
        setText('');
        setAttachments([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
    };

    const handleStop = () => {
        if (starting && submittedRef.current) {
            setText(current => (current === '' ? submittedRef.current : current));
        }
        onStop();
    };

    /** Typing re-opens the palette and resets the highlight to the first row of the new filter. */
    const handleComposerChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
        const value = event.target.value;
        setText(value);
        setSlashDismissed(false);
        if (value.startsWith('/')) setSlashActiveIndex(0);
    };

    /** A palette row was chosen: commands run immediately (text cleared), skills are inserted.
     *  Parameterised commands (goal/subagent/workflow) keep the typed text as their argument and
     *  run on Enter via ChatInterface's handleSend dispatch.
     *
     *  A skill is inserted as its SLASH TRIGGER, not its catalogue name: the server matches skills
     *  by substring against `triggers` (`/brainstorm`), and `morphi-brainstorm` is the file name —
     *  inserting it produced text that matched no trigger, and the user's typed slash was gone.
     *  Falls back to the name only if a skill declares no slash trigger at all. */
    const handleSlashSelect = (item: SlashItem) => {
        if (item.kind === 'command') {
            if (SLASH_ARG_COMMANDS.includes(item.id)) {
                const token = SLASH_COMMANDS.find((command) => command.id === item.id)?.token ?? item.id;
                // Keep whatever follows the token as the argument (`/goal foo` → `/goal foo`).
                const remainder = text.startsWith('/') ? text.slice(1 + token.length) : '';
                setText(`/${token}${remainder}`);
            } else {
                setText('');
                onRunCommand(item.id);
            }
        } else {
            const skill = skills.find((entry) => entry.name === item.id);
            const trigger = skill?.triggers.find((entry) => entry.startsWith('/'));
            setText(`${trigger ?? item.id} `);
        }
        setSlashDismissed(true);
        setSlashActiveIndex(0);
        textareaRef.current?.focus();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const fullClass = (event: KeyboardEvent) =>
            (event.ctrlKey || event.metaKey) && event.key === 'Enter';
        if (slashOpen && !fullClass(event)) {
            const length = slashItems.length;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashActiveIndex(index => (index + 1) % length);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashActiveIndex(index => (index - 1 + length) % length);
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                const item = slashItems[slashActiveIndex];
                if (item) handleSlashSelect(item);
                return;
            }
            if (event.key === 'Tab') {
                event.preventDefault();
                const item = slashItems[slashActiveIndex];
                if (item) handleSlashSelect(item);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setSlashDismissed(true);
                return;
            }
        }
        if (event.key !== 'Enter') return;
        if (event.shiftKey) {
            event.preventDefault();
            const element = event.currentTarget;
            const start = element.selectionStart ?? text.length;
            const end = element.selectionEnd ?? text.length;
            const next = `${text.slice(0, start)}\n${text.slice(end)}`;
            setText(next);
            requestAnimationFrame(() => {
                element.selectionStart = start + 1;
                element.selectionEnd = start + 1;
            });
            return;
        }
        event.preventDefault();
        submit();
    };

    // One stop per level the model actually declares (data-driven): a model that omits a level never
    // shows an invalid tick. `currentEffort` is the level in effect, falling back to the first declared
    // level when the stored effort is stale or empty. "None" is not a universal option — only a model's
    // own declared levels are offered (Task 31D fix).
    const currentEffort = effort !== '' && efforts.includes(effort) ? effort : efforts[0];
    const sliderIndex = efforts.indexOf(currentEffort);
    const sliderPercent = efforts.length > 1 ? (sliderIndex / (efforts.length - 1)) * 100 : 0;

    // `/` palette: opens when the text starts with "/". The server skill catalogue and the built-in
    // client commands are filtered by the keyword typed after the slash; each becomes one row.
    const slashQuery = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
    const slashItems = useMemo<SlashItem[]>(() => {
        if (slashQuery === null) return [];
        const query = slashQuery;
        const commandItems: SlashItem[] = SLASH_COMMANDS
            .filter((command) => command.token.toLowerCase().includes(query))
            .map((command) => ({
                key: `command:${command.id}`,
                kind: 'command',
                section: 'commands',
                id: command.id,
                label: `/${command.token}`,
                description: slashCommandDescription(command.id),
                icon: command.icon,
            }));
        // A skill row advertises its SLASH TRIGGER (`/brainstorm`), because that is the string the
        // user types and the server matches. The catalogue name (`morphi-brainstorm`) stays in the
        // row id but never in the label: showing it made the palette look like it inserted text
        // that could not possibly trigger the skill. Filtering accepts either form.
        const skillItems: SlashItem[] = skills
            .map((skill) => ({ skill, trigger: skill.triggers.find((entry) => entry.startsWith('/')) }))
            .filter(({ skill, trigger }) => skill.name.toLowerCase().includes(query)
                || (trigger ?? '').toLowerCase().replace(/^\//, '').includes(query))
            .map(({ skill, trigger }) => ({
                key: `skill:${skill.name}`,
                kind: 'skill',
                section: 'skills',
                id: skill.name,
                label: trigger ?? skill.name,
                description: skill.description,
                icon: Sparkles,
            }));
        // Skills first: this order must match SECTION_ORDER in SlashPalette so the highlighted
        // `slashActiveIndex` points at the row the user actually sees at the top.
        return [...skillItems, ...commandItems];
    }, [slashQuery, skills]);

    const slashOpen = slashQuery !== null && !slashDismissed && slashItems.length > 0;

    // Keep the highlighted row inside the valid range as the filtered list shrinks while typing.
    useEffect(() => {
        setSlashActiveIndex((index) => Math.min(index, Math.max(0, slashItems.length - 1)));
    }, [slashItems.length]);

    const showStop = streaming || starting;
    const canSend = !disabled && (text.trim() !== '' || attachments.length > 0);

    return (
        <div className="mx-auto w-full max-w-[730px] px-4">
            <div ref={rootRef} className="relative">
                {/* Hidden file picker driven by the `+` button and clipboard paste. */}
                <input
                    ref={fileInputRef}
                    type="file"
                    data-testid="composer-file-input"
                    accept="image/*,application/pdf,text/*"
                    multiple
                    className="hidden"
                    onChange={handleFileChange}
                />

                {/* Slider kéo chọn mức suy nghĩ (Task 31D). Chỉ model khai `efforts` mới có. */}
                {effortOpen && efforts.length > 0 ? (
                    <div
                        role="dialog"
                        aria-label={vi.composer.effortTitle}
                        // The panel grows with the model's declared levels — six cramped labels
                        // were the old fixed 280px width's fault, not the data's.
                        className="absolute bottom-full left-0 z-50 mb-2 w-max min-w-[420px] max-w-[min(90vw,560px)] rounded-2xl border border-border bg-bg-card p-5 shadow-premium"
                    >
                        <div className="pb-1 text-[13px] font-semibold text-text-primary">{vi.composer.effortTitle}</div>
                        <p className="pb-4 text-[12px] text-text-tertiary">{effortLabel(currentEffort)}</p>
                        {/* Custom track + thumb + ticks; a visually-hidden native range owns the
                            real interaction (keyboard, screen-reader, drag) so the control stays
                            accessible while the chrome is fully our own. */}
                        <div className="relative h-8">
                            <div className="absolute inset-x-4 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-bg-inset" />
                            <div
                                className="absolute left-4 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-brand-text"
                                style={{
                                    width: `calc((100% - 32px) * ${sliderPercent} / 100)`,
                                }}
                            />
                            {efforts.map((level, index) => (
                                <span
                                    key={level}
                                    className="absolute top-1/2 -translate-y-1/2"
                                    style={{ left: `calc(16px + (100% - 32px) * ${(index / (efforts.length - 1)) * 100} / 100)` }}
                                >
                                    <span
                                        className={cn(
                                            'block h-3.5 w-3.5 -translate-x-1/2 rounded-full transition-colors',
                                            sliderIndex === index
                                                ? 'bg-brand-text ring-4 ring-brand-text/20'
                                                : index < sliderIndex
                                                    ? 'bg-brand-text'
                                                    : 'border border-border bg-bg-card',
                                        )}
                                    />
                                </span>
                            ))}
                            <div
                                className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-primary shadow-md ring-2 ring-bg-card"
                                style={{ left: `calc(16px + (100% - 32px) * ${sliderPercent} / 100)` }}
                            />
                            <input
                                type="range"
                                min={0}
                                max={Math.max(0, efforts.length - 1)}
                                step={1}
                                value={sliderIndex}
                                aria-label={vi.composer.effortTitle}
                                aria-valuetext={effortLabel(currentEffort)}
                                onChange={(event) => onSelectEffort(efforts[Number(event.target.value)])}
                                className="absolute inset-y-0 left-4 right-4 h-8 w-auto cursor-pointer opacity-0"
                            />
                        </div>
                        <div className="relative mt-3 h-8">
                            {efforts.map((level, index) => (
                                <button
                                    key={level}
                                    type="button"
                                    onClick={() => onSelectEffort(level)}
                                    className={cn(
                                        'absolute top-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] transition-colors',
                                        index === 0 && 'left-0',
                                        index === efforts.length - 1 && 'right-0',
                                        index > 0 && index < efforts.length - 1 && '-translate-x-1/2',
                                        currentEffort === level
                                            ? 'bg-brand-text/15 font-semibold text-text-primary'
                                            : 'text-text-tertiary hover:text-text-secondary',
                                    )}
                                    style={{
                                        left: index === 0 || index === efforts.length - 1
                                            ? undefined
                                            : `calc(16px + (100% - 32px) * ${(index / (efforts.length - 1)) * 100} / 100)`,
                                    }}
                                >
                                    {effortLabel(level)}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}

                {/* Ba chế độ duyệt tool (Task 31D). Gửi kèm mỗi lượt qua `permissionMode`. */}
                {permissionOpen ? (
                    <div
                        role="dialog"
                        aria-label={vi.composer.permissionTitle}
                        className="absolute bottom-full left-0 z-50 mb-2 w-[300px] rounded-xl border border-border bg-bg-card p-1 shadow-premium"
                    >
                        <div className="px-2 pb-1 pt-2 text-[13px] font-semibold text-text-primary">{vi.composer.permissionTitle}</div>
                        <div role="radiogroup" aria-label={vi.composer.permissionTitle}>
                            {(['ask', 'balanced', 'full'] as const).map(mode => (
                                <button
                                    key={mode}
                                    type="button"
                                    role="radio"
                                    aria-checked={permission === mode}
                                    onClick={() => {
                                        if (mode === 'full' && permission !== 'full') {
                                            setConfirmFull(true);
                                            setPermissionOpen(false);
                                            return;
                                        }
                                        onSelectPermission(mode);
                                        setPermissionOpen(false);
                                        permissionButtonRef.current?.focus();
                                    }}
                                    className={cn(
                                        'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left',
                                        permission === mode ? 'bg-bg-inset' : 'hover:bg-bg-inset',
                                    )}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-[13px] font-medium text-text-primary">{permissionLabel(mode)}</span>
                                        <span className="block text-[12px] text-text-secondary">{permissionHint(mode)}</span>
                                    </span>
                                    {permission === mode ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-text-primary" /> : null}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}

                {/* Palette "/" : panel tối hiện trên ô nhập, chia 2 nhóm "Kỹ năng" và "Lệnh". */}
                {slashOpen ? (
                    <SlashPalette
                        items={slashItems}
                        activeIndex={slashActiveIndex}
                        onActiveIndexChange={setSlashActiveIndex}
                        onSelect={handleSlashSelect}
                    />
                ) : null}

                {/* Steering queue (Codex-style): messages sent while a turn runs wait here and
                    are drained by the loop at the next step boundary. The card sits directly
                    above the input so the wait is visible in the composer, not a toast line. */}
                {queuedMessages.length > 0 ? (
                    <div className="mb-2 rounded-[16px] border border-border bg-bg-card p-2 shadow-premium">
                        <div className="flex items-center justify-between px-1 pb-1.5">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                                {vi.composer.queuedTitle.replace('{count}', String(queuedMessages.length))}
                            </span>
                            {onClearQueued ? (
                                <button
                                    type="button"
                                    aria-label={vi.composer.clearQueued}
                                    title={vi.composer.clearQueued}
                                    onClick={onClearQueued}
                                    className="flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-inset hover:text-text-primary"
                                >
                                    <X size={13} aria-hidden="true" />
                                </button>
                            ) : null}
                        </div>
                        <div className="space-y-2">
                            {queuedMessages.map((message, index) => (
                                <div key={index} className="rounded-xl bg-bg-inset px-3 py-2">
                                    <p className="break-words text-[13px] leading-relaxed text-text-primary">{message}</p>
                                    <p className="pt-1 text-[11px] text-text-tertiary">{vi.composer.queuedHint}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                <div className="flex min-h-[112px] flex-col rounded-[22px] border border-border bg-bg-card shadow-premium transition-colors">
                    {attachments.length > 0 ? (
                        <div className="flex flex-wrap gap-2 px-4 pt-3">
                            {attachments.map(attachment => (
                                <div
                                    key={attachment.id}
                                    className="group relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-inset"
                                >
                                    {attachment.kind === 'image' && attachment.dataUrl ? (
                                        <button
                                            type="button"
                                            aria-label={`${vi.composer.previewAttachment}: ${attachment.name}`}
                                            onClick={() => setPreview(attachment)}
                                            className="h-full w-full cursor-zoom-in"
                                        >
                                            <img src={attachment.dataUrl} alt={attachment.name} className="h-full w-full object-cover" />
                                        </button>
                                    ) : (
                                        <FileText size={22} aria-hidden="true" className="text-text-secondary" />
                                    )}
                                    {/* Overlay sits on arbitrary image pixels: theme tokens go black-on-black
                                        in dark mode, so pin white on black/70 (≥7:1 even over a white image).
                                        Keep the chip info and remove control visible instead of hover-only so
                                        the user never has to guess where the delete control is. */}
                                    <button
                                        type="button"
                                        aria-label={vi.composer.removeAttachment}
                                        onClick={() => removeAttachment(attachment.id)}
                                        className="absolute right-0.5 top-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-overlay-strong text-overlay-fg shadow-md transition-colors hover:bg-overlay"
                                    >
                                        <X size={12} aria-hidden="true" />
                                    </button>
                                    <span className="pointer-events-none absolute bottom-0 left-0 right-0 truncate bg-overlay-strong px-1 text-[10px] leading-3 text-overlay-fg">
                                        {attachment.name}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    <div className="flex flex-1 items-start px-4 pt-3">
                        <textarea
                            ref={textareaRef}
                            value={text}
                            onChange={handleComposerChange}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            placeholder={vi.welcome.placeholder}
                            aria-label={vi.composer.autoGrowAria}
                            rows={1}
                            disabled={disabled}
                            className="max-h-[200px] min-h-[24px] w-full resize-none border-0 bg-transparent py-1 text-[15px] leading-6 text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:outline-none sidebar-scrollbar"
                        />
                    </div>

                    <div className="flex items-center justify-between px-3 pb-2 pt-1">
                        <div className="flex items-center gap-1">
                            {/* `+` mở hộp chọn file/ảnh (theo yêu cầu mới); ảnh cũng có thể dán từ clipboard. */}
                            <button
                                type="button"
                                aria-label={vi.composer.attach}
                                title={vi.composer.attach}
                                onClick={() => fileInputRef.current?.click()}
                                className="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary"
                            >
                                <Plus size={18} aria-hidden="true" />
                            </button>

                            {/* Chọn quyền thực thi (Task 31D) — đặt ngay bên phải nút cộng. */}
                            <button
                                ref={permissionButtonRef}
                                type="button"
                                aria-label={vi.composer.permissionTitle}
                                aria-haspopup="dialog"
                                aria-expanded={permissionOpen}
                                onClick={() => {
                                    setEffortOpen(false);
                                    setPermissionOpen(open => !open);
                                }}
                                className="flex h-8 items-center gap-1.5 rounded-full px-2 text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary"
                            >
                                <ShieldCheck size={17} aria-hidden="true" style={{ color: PERMISSION_ICON_COLOR[permission] }} />
                                <span className="text-[12px] font-semibold" style={{ color: PERMISSION_ICON_COLOR[permission] }}>{permissionLabel(permission)}</span>
                            </button>

                            {/* Task 31D: thay công tắc bật/tắt bằng slider kéo chọn mức effort. Chỉ model
                                tự khai `efforts` mới có; model không khai thì im lặng. */}
                            {efforts.length > 0 ? (
                                <button
                                    ref={effortButtonRef}
                                    type="button"
                                    aria-label={vi.composer.effortTitle}
                                    aria-haspopup="dialog"
                                    aria-expanded={effortOpen}
                                    onClick={() => {
                                        setPermissionOpen(false);
                                        setEffortOpen(open => !open);
                                    }}
                                    className={cn(
                                        'flex h-8 items-center gap-1.5 rounded-full px-2 transition-colors',
                                        effort
                                            ? 'bg-bg-inset text-text-primary'
                                            : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
                                    )}
                                >
                                    <Brain size={17} aria-hidden="true" />
                                    <span className="text-[12px] font-medium">
                                        {effortLabel(currentEffort)}
                                    </span>
                                </button>
                            ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                            {/* Vòng context window (Task 31): đặt cạnh ModelPicker, hiện % còn lại,
                                hover để xem chi tiết. Số token thô không in ra hàng — chỉ vòng % là đủ. */}
                            {totalTokens > 0 ? (
                                <ContextRing
                                    usedTokens={usedTokens}
                                    totalTokens={totalTokens}
                                    modelName={modelName}
                                />
                            ) : null}

                            {/* `rootRef` của popover coi mọi pointerdown BÊN TRONG composer là "không ở
                                ngoài", nên bấm chip model khi popover đang mở sẽ để cả hai panel cùng
                                `absolute bottom-full z-50` đè lên nhau. Chip model đóng popover hộ. */}
                            <span onPointerDown={() => { setEffortOpen(false); setPermissionOpen(false); }}>
                                <ModelPicker
                                    models={models}
                                    selectedModel={selectedModel}
                                    onSelect={onSelectModel}
                                    onOpenSettings={onOpenSettings}
                                    onReload={onReloadModels}
                                />
                            </span>

                            {/*
                              One action slot, morphing like the Codex composer: while a turn runs the
                              square is Stop, but the moment the user types (or stages an attachment) the
                              same circle becomes Send — the steer/queue button. Two side-by-side
                              buttons were noise; one button does both jobs.
                            */}
                            {showStop && !canSend ? (
                                <button
                                    type="button"
                                    aria-label={vi.composer.stop}
                                    onClick={handleStop}
                                    className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-text-primary text-bg-main transition-colors hover:bg-text-secondary"
                                >
                                    <Square size={12} fill="currentColor" aria-hidden="true" />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    aria-label={showStop ? (vi.composer.steer ?? 'Gửi chèn') : vi.composer.send}
                                    title={showStop ? (vi.composer.steer ?? 'Gửi chèn') : undefined}
                                    onClick={submit}
                                    disabled={!canSend}
                                    className={cn(
                                        'flex h-[30px] w-[30px] items-center justify-center rounded-full bg-brand text-bg-main transition-all hover:brightness-110',
                                        !canSend && 'cursor-not-allowed bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-fg)]',
                                    )}
                                >
                                    <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            {confirmFull ? (
                <div role="dialog" aria-modal="true" aria-label={vi.composer.confirmFullTitle} className="fixed inset-0 z-[500] flex items-center justify-center p-3 sm:p-4">
                    <div aria-hidden="true" className="absolute inset-0 bg-scrim-soft" onClick={() => setConfirmFull(false)} />
                    <div className="relative max-h-[90dvh] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-bg-card p-5 shadow-premium sm:p-6">
                        <p className="flex items-center gap-2.5 text-[17px] font-bold text-text-primary">
                            <TriangleAlert size={20} aria-hidden="true" className="shrink-0 text-warning-text" />
                            {vi.composer.confirmFullTitle}
                        </p>
                        <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">{vi.composer.confirmFullBody}</p>
                        <div className="mt-4 space-y-3 rounded-xl bg-bg-inset p-4">
                            {[
                                { Icon: Folder, title: vi.composer.confirmFullFiles, hint: vi.composer.confirmFullFilesHint },
                                { Icon: FileText, title: vi.composer.confirmFullTerminal, hint: vi.composer.confirmFullTerminalHint },
                                { Icon: Globe, title: vi.composer.confirmFullInternet, hint: vi.composer.confirmFullInternetHint },
                            ].map(({ Icon, title, hint }) => (
                                <div key={title} className="flex items-start gap-3">
                                    <Icon size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-brand-text" />
                                    <span className="min-w-0">
                                        <span className="block text-[14px] font-semibold text-text-primary">{title}</span>
                                        <span className="block text-[12px] leading-relaxed text-text-secondary">{hint}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                        <p className="mt-4 text-[13px] leading-relaxed text-text-secondary">
                            {vi.composer.confirmFullRisk}{' '}
                            <button
                                type="button"
                                onClick={() => onOpenSettings()}
                                className="font-medium text-brand-text underline underline-offset-2"
                            >
                                {vi.composer.confirmFullLearnMore}
                            </button>
                        </p>
                        <div className="mt-5 flex justify-end gap-2">
                            <button type="button" onClick={() => setConfirmFull(false)} className="rounded-full border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-bg-inset">
                                {vi.composer.confirmFullCancel}
                            </button>
                            <button
                                type="button"
                                onClick={() => { onSelectPermission('full'); setConfirmFull(false); permissionButtonRef.current?.focus(); }}
                                className="flex items-center gap-1.5 rounded-full bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text hover:brightness-110"
                            >
                                <AlertTriangle size={15} aria-hidden="true" />
                                {vi.composer.confirmFullConfirm}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {preview ? (
                <ImageLightbox src={preview.dataUrl} name={preview.name} onClose={() => setPreview(null)} />
            ) : null}
        </div>
    );
}

export default Composer;
