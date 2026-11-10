import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Cpu, Database, HardDrive, Info, Keyboard, Moon, Settings2, Sun, X } from '../icons';
import { api } from '../../lib/api';
import { codeOf, errorCopy, serverMessageOf } from '../../lib/errorCopy';
import { setAiLanguage, setUiLanguage, useAiLanguage, useUiLanguage } from '../../lib/prefs';

import { useTheme } from '../../hooks/useTheme';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { ProviderStatus } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { AddConnectorForm, ProviderCard } from './ProviderCard';
import { McpPanel } from './McpPanel';
import { MemoryPanel } from './MemoryPanel';
import { AdvancedPanel } from './AdvancedPanel';

/**
 * Settings một hộp, năm mục — spec §6.6. `initialTab` tồn tại vì rail "Bộ nhớ" và CTA "Mở Cài đặt"
 * của composer không còn modal riêng: chúng mở đúng hộp này ở đúng mục (`ChatInterface`).
 *
 * Chrome theo U6/U9: radius 16px (`rounded-2xl`), nền `--color-bg-card`, viền U7-soft
 * (`border-border`), shadow nổi trên nền tối dần (`shadow-premium` trên `bg-scrim`), nhịp 32px
 * giữa các khối (`space-y-8`) và nhãn mục ở `--color-text-tertiary`. Nút chính của dialog đi theo U2:
 * màu foreground (`.btn-primary`), không phải xanh thương hiệu.
 *
 * Không dùng framer-motion ở đây: vào/ra của dialog chỉ còn opacity + scale qua transition CSS, nên
 * `prefers-reduced-motion` (index.css) tắt được bằng một luật duy nhất thay vì từng `initial/animate`
 * — và jsdom không cần mock trình tạo hoạt ảnh để test chạy được.
 */
export type SettingsTab = 'general' | 'providers' | 'mcp' | 'memory' | 'advanced';

/** Tab labels read `vi` at render time (not module load): they must follow the UI language. */
function tabs(): { id: SettingsTab; label: string; Icon: typeof Cpu }[] {
  return [
    { id: 'general', label: vi.settings.general, Icon: Settings2 },
    { id: 'providers', label: vi.settings.providers, Icon: Cpu },
    { id: 'mcp', label: vi.settings.mcp, Icon: Database },
    { id: 'memory', label: vi.settings.memory, Icon: HardDrive },
    { id: 'advanced', label: vi.settings.advanced, Icon: Keyboard },
  ];
}

type CredentialBridge = NonNullable<Window['morphi']>['credentials'];

export interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: SettingsTab;
    /** Nối tiếp hành vi `onCleared` của modal bộ nhớ cũ: phiên đang mở mất ngữ cảnh sau khi xoá. */
    onMemoryCleared?: () => void;
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <p className="mb-3 text-sidebar font-semibold uppercase tracking-wide text-text-tertiary">{children}</p>
);

/** Mục "Chung": theme sáng/tối, ngôn ngữ + phím tắt. Stream là chữ thuần từng chữ, không hiệu ứng. */
function GeneralPanel() {
    const { theme, toggle } = useTheme();
    const uiLang = useUiLanguage();
    const aiLang = useAiLanguage();

    const optionButton = (active: boolean) =>
        cn(
            'rounded-lg px-3 py-1.5 text-sidebar font-semibold transition-colors',
            active
                ? 'bg-bg-inset text-text-primary'
                : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
        );

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <SectionLabel>{vi.settings.themeSection}</SectionLabel>
                <div className="flex gap-2" role="group" aria-label={vi.settings.theme}>
                    {/* `useTheme` lưu 'light' | 'dark' (`morphi.theme`), hệ điều hành chỉ được đọc ở lần
                     * chạy ĐẦU. Một nút "Hệ thống" sẽ là control không có hành vi phía sau, nên ở đây
                     * chỉ có hai lựa chọn thật + một dòng giải thích. */}
                    <button
                        type="button"
                        aria-pressed={theme === 'light'}
                        onClick={() => { if (theme !== 'light') toggle(); }}
                        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sidebar font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                    >
                        <Sun size={15} aria-hidden="true" />
                        {vi.settings.themeLight}
                    </button>
                    <button
                        type="button"
                        aria-pressed={theme === 'dark'}
                        onClick={() => { if (theme !== 'dark') toggle(); }}
                        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sidebar font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                    >
                        <Moon size={15} aria-hidden="true" />
                        {vi.settings.themeDark}
                    </button>
                </div>
                <p className="text-sidebar leading-relaxed text-text-tertiary">{vi.settings.themeSystemNote}</p>
            </section>

            <section className="space-y-3">
                <SectionLabel>{vi.settings.languageSection}</SectionLabel>
                <p className="text-[14px] text-text-primary">{vi.settings.uiLanguage}</p>
                <div className="flex gap-2" role="group" aria-label={vi.settings.uiLanguage}>
                    <button type="button" aria-pressed={uiLang === 'vi'} onClick={() => setUiLanguage('vi')} className={optionButton(uiLang === 'vi')}>
                        {vi.settings.langVi}
                    </button>
                    <button type="button" aria-pressed={uiLang === 'en'} onClick={() => setUiLanguage('en')} className={optionButton(uiLang === 'en')}>
                        {vi.settings.langEn}
                    </button>
                </div>
                <p className="pt-3 text-[14px] text-text-primary">{vi.settings.aiLanguage}</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label={vi.settings.aiLanguage}>
                    <button type="button" aria-pressed={aiLang === 'auto'} onClick={() => setAiLanguage('auto')} className={optionButton(aiLang === 'auto')}>
                        {vi.settings.langAuto}
                    </button>
                    <button type="button" aria-pressed={aiLang === 'vi'} onClick={() => setAiLanguage('vi')} className={optionButton(aiLang === 'vi')}>
                        {vi.settings.langVi}
                    </button>
                    <button type="button" aria-pressed={aiLang === 'en'} onClick={() => setAiLanguage('en')} className={optionButton(aiLang === 'en')}>
                        {vi.settings.langEn}
                    </button>
                </div>
                <p className="text-sidebar leading-relaxed text-text-tertiary">{vi.settings.aiLanguageHint}</p>
            </section>

            <section className="space-y-3">
                <SectionLabel>{vi.settings.motionSection}</SectionLabel>
                <p className="text-[14px] leading-relaxed text-text-secondary">{vi.settings.motionNote}</p>
            </section>

            <section className="space-y-3">
                <SectionLabel>{vi.settings.shortcutsSection}</SectionLabel>
                <dl className="space-y-1">
                    {[
                        [vi.settings.shortcutSearch, 'Ctrl/⌘ + K'],
                        [vi.settings.shortcutNewChat, 'Ctrl/⌘ + N'],
                        [vi.settings.shortcutEscape, 'Esc'],
                        [vi.settings.shortcutSend, 'Enter'],
                        [vi.settings.shortcutNewline, 'Shift + Enter'],
                    ].map(([label, keys]) => (
                        <div key={label} className="flex items-baseline justify-between gap-4 py-1">
                            <dt className="text-[14px] text-text-primary">{label}</dt>
                            <dd><code className="text-sidebar text-text-secondary">{keys}</code></dd>
                        </div>
                    ))}
                </dl>
            </section>
        </div>
    );
}

/**
 * Mục "Nhà cung cấp". Key KHÔNG BAO GIỜ đi qua HTTP: `api.providers.*` chỉ chạm tới route config
 * (`routes/providers.ts`), còn key vào/ra két sắt qua `window.morphi.credentials` (IPC, `preload.js:5-8`).
 * Vì vậy danh sách `ProviderStatus` không chứa key, và `credentials.status()` cũng chỉ trả boolean.
 */
function ProvidersPanel() {
    const bridge: CredentialBridge | undefined = typeof window !== 'undefined' ? window.morphi?.credentials : undefined;
    const [providers, setProviders] = useState<ProviderStatus[]>([]);
    const [stored, setStored] = useState<Record<string, boolean>>({});
    const [persistent, setPersistent] = useState(true);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<{ id: string; kind: 'ok' | 'err'; text: string } | null>(null);
    /** Dòng trạng thái cầu nối của từng hàng keyless, để thẻ không phải tự đi hỏi server. */
    const [bridgeLines, setBridgeLines] = useState<Record<string, string>>({});

    const reload = useCallback(async () => {
        const rows = await api.providers.list();
        setProviders(rows);
        if (!bridge) return;
        const status = await bridge.status();
        const next: Record<string, boolean> = {};
        for (const provider of status.providers) {
            if (provider.configured) next[provider.providerId] = true;
        }
        setStored(next);
        // `persistent === false` là safeStorage từ chối (Linux không keyring): key vẫn lưu được nhưng
        // bay theo phiên, người dùng phải được nói thẳng.
        setPersistent(status.persistent);
    }, [bridge]);

    /**
     * Hàng keyless tự mô tả tình trạng cầu nối. Chỉ chạy khi có provider keyless: một GET /bridge
     * cho `openai` sẽ là 404, và hỏi mỗi hàng mỗi lần reload sẽ trả lỗi có chủ đích.
     */
    const loadBridgeLines = useCallback(async (rows: ProviderStatus[]) => {
        const keyless = rows.filter((provider) => provider.keyless === true);
        if (keyless.length === 0) return;
        const lines: Record<string, string> = {};
        await Promise.all(keyless.map(async (provider) => {
            try {
                const status = await api.providers.bridgeStatus(provider.providerId);
                lines[provider.providerId] = status.state === 'reachable'
                    ? vi.settings.bridgeReachable
                    : vi.settings.bridgeUnreachable;
            } catch {
                lines[provider.providerId] = vi.settings.bridgeUnreachable;
            }
        }));
        setBridgeLines(lines);
    }, []);

    useEffect(() => {
        reload()
            .catch((caught: unknown) => setFeedback({ id: '', kind: 'err', text: errorCopy(codeOf(caught)) }))
            .finally(() => setLoading(false));
    }, [reload]);

    // The bridge line follows the row list: a reload that dropped the provider drops its line too.
    useEffect(() => {
        void loadBridgeLines(providers);
    }, [loadBridgeLines, providers]);

    const write = async (id: string, action: () => Promise<{ ok: boolean }>) => {
        setBusy(id);
        try {
            const result = await action();
            setFeedback({ id, kind: result.ok ? 'ok' : 'err', text: result.ok ? vi.settings.savedMessage : vi.settings.failedMessage });
            if (result.ok) await reload();
        } catch {
            setFeedback({ id, kind: 'err', text: vi.settings.failedMessage });
        } finally {
            setBusy(null);
        }
    };

    const existingIds = useMemo(() => providers.map((p) => p.providerId), [providers]);

    /**
     * "Kết nối tài khoản" cho provider keyless: POST /connect sẽ yêu cầu cầu nói DeepSeek khởi tạo
     * session — chính là lúc bridge mở cửa sổ đăng nhập (hoặc trả 503 `login_required` nếu nó chạy
     * headless). Phản hồi của server là một câu tiếng Việt, nên nó đi thẳng vào feedback thay vì bị
     * rút gọn thành "Đã lưu" / "Thất bại": `waiting` (đăng nhập chưa xong) không phải lỗi.
     */
    const connectAccount = async (id: string) => {
        setBusy(id);
        try {
            const result = await api.providers.connect(id);
            setFeedback({ id, kind: result.state === 'unreachable' ? 'err' : 'ok', text: result.message });
            if (result.state === 'connected') {
                await reload();
                await loadBridgeLines(providers);
            }
        } catch (caught) {
            setFeedback({ id, kind: 'err', text: serverMessageOf(caught) ?? errorCopy(codeOf(caught)) });
        } finally {
            setBusy(null);
        }
    };

    /**
     * M1 — `feedback.id === ''` là tín hiệu "lỗi của CẢ PANEL, không của riêng thẻ nào": `useEffect` gọi
     * `reload()` dựng đúng một feedback với id rỗng khi danh sách tải hỏng. Trước round này chuỗi được dựng
     * rồi nằm im trong state, vì `feedback` chỉ ra DOM qua prop từng thẻ (`feedback?.id ===
     * provider.providerId`) và không provider nào có id rỗng — người dùng thấy một danh sách trống không
     * lời giải thích, form "Thêm connector" vẫn chạy, và két sắt thì không bao giờ được hỏi.
     */
    const panelError = feedback && feedback.id === '' && feedback.kind === 'err' ? feedback.text : null;

    if (loading) {
        return <p className="text-[14px] text-text-secondary">{vi.settings.providersLoading}</p>;
    }

    return (
        <div className="space-y-8">
            {/* §6.7 "live region": một lần tải hỏng là phản hồi DUY NHẤT người dùng nhận được ở mục này,
             * nên nó phải được trình đọc màn hình nói lên chứ không chỉ hiện ra. `role="alert"` đã mang
             * `aria-live=assertive` theo đặc tả ARIA; khai báo tường minh vì test cần đo được thuộc tính,
             * và vì một region kế thừa từ cha `role=tabpanel` (không phải live region) không được đảm bảo. */}
            {panelError && (
                <p
                    role="alert"
                    aria-live="assertive"
                    className="flex items-start gap-2 rounded-xl border border-border bg-danger-bg p-4 text-[14px] text-danger-text"
                >
                    <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                    {panelError}
                </p>
            )}
            {!bridge && (
                <p className="flex items-start gap-2 rounded-xl border border-border bg-warning-bg p-4 text-[14px] text-warning-text">
                    <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                    {vi.settings.electronRequired}
                </p>
            )}
            {bridge && !persistent && (
                <p className="flex items-start gap-2 rounded-xl border border-border bg-warning-bg p-4 text-[14px] text-warning-text">
                    <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                    {vi.settings.ephemeralKeys}
                </p>
            )}

            <ul className="space-y-3">
                {providers.map((provider) => (
                    <ProviderCard
                        key={provider.providerId}
                        provider={provider}
                        stored={stored[provider.providerId] === true}
                        bridgeAvailable={bridge !== undefined}
                        busy={busy === provider.providerId}
                        feedback={feedback?.id === provider.providerId ? { kind: feedback.kind, text: feedback.text } : null}
                        onSaveKey={(key) => { void write(provider.providerId, () => bridge!.set(provider.providerId, key)); }}
                        onDeleteKey={() => { void write(provider.providerId, () => bridge!.delete(provider.providerId)); }}
                        onSaveBaseUrl={(baseUrl) => {
                            void write(provider.providerId, async () => {
                                await api.providers.updateConfig(provider.providerId, { baseUrl });
                                return { ok: true };
                            });
                        }}
                        onConnectAccount={provider.keyless ? () => { void connectAccount(provider.providerId); } : undefined}
                        bridgeStatus={bridgeLines[provider.providerId]}
                    />
                ))}
            </ul>

            {/* Gate bằng ĐÚNG điều kiện của alert (M1): khi danh sách chưa tải được thì `existingIds` rỗng
             * nên form không phát hiện được connector trùng, key vừa dán cũng không có thẻ nào hiển thị
             * trạng thái — người dùng bấm "Thêm" mà không kiểm chứng được gì. Bảng đen đã nói lỗi ở trên,
             * và trở lại mục này (tab khác rồi quay lại) là đường nạp lại thật, không phải một nút chết. */}
            {!panelError && (
                <AddConnectorForm
                    existingIds={existingIds}
                    bridgeAvailable={bridge !== undefined}
                    busy={busy === '__add__'}
                    onAdd={({ id, baseUrl, key }) => {
                        void write('__add__', async () => {
                            // Hai bước, đúng thứ tự: server dựng hàng + endpoint trước (đòi `baseUrl` cho
                            // hàng custom), rồi IPC ghi key. Không bước nào gửi key lên HTTP.
                            await api.providers.updateConfig(id, { baseUrl, enabled: true });
                            const result = await bridge!.set(id, key);
                            return { ok: result.ok };
                        });
                    }}
                />
            )}
        </div>
    );
}

export function SettingsModal({ isOpen, onClose, initialTab = 'general', onMemoryCleared }: SettingsModalProps) {
    const [tab, setTab] = useState<SettingsTab>(initialTab);
    const containerRef = useFocusTrap<HTMLDivElement>(isOpen, onClose);

    // Đổi `initialTab` khi hộp ĐANG mở là thật (rail "Bộ nhớ" bấm lần hai): cha chỉ đổi state, và
    // người dùng phải thấy mục vừa chọn chứ không phải mục họ đang đọc dở. Đồng bộ NGAY TRONG RENDER
    // theo mẫu "adjust state when a prop changes" của react.dev: bản `useEffect` vừa vi phạm
    // `react-hooks/set-state-in-effect` vừa thừa một lần render, và render-time thì panel đổi cùng lần
    // render mà cha truyền xuống — không bao giờ vẽ mục cũ một frame.
    const [syncedInitialTab, setSyncedInitialTab] = useState(initialTab);
    if (isOpen && syncedInitialTab !== initialTab) {
        setSyncedInitialTab(initialTab);
        setTab(initialTab);
    }

    if (!isOpen) return null;

    const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const entries = tabs();
        const index = entries.findIndex((entry) => entry.id === tab);
        if (index === -1) return;
        const move = (next: number) => {
            event.preventDefault();
            const id = entries[next % entries.length].id;
            setTab(id);
            // m8 (APG "manual activation"): selection đổi thì FOCUS phải đi theo. `setTab` lật
            // `tabIndex` của nút vừa nhận focus thành -1 trong lúc nó vẫn đang focused, nên vòng Tab
            // kế tiếp nhảy khỏi vị trí người dùng đang nhìn — roving tabindex và vòng focus lệch nhau.
            document.getElementById(`settings-tab-${id}`)?.focus();
        };
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') move(index + 1);
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') move((index + entries.length - 1) % entries.length);
        else if (event.key === 'Home') move(0);
        else if (event.key === 'End') move(entries.length - 1);
    };

    const panelId = `settings-panel-${tab}`;

    return (
        <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
            <div
                aria-hidden="true"
                data-testid="settings-backdrop"
                className="absolute inset-0 bg-scrim"
                onClick={onClose}
            />
            <div
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-label={vi.settings.title}
                className="relative flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-sidebar shadow-premium"
            >
                <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4">
                    <h2 className="text-[16px] font-semibold text-text-primary">{vi.settings.title}</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={vi.settings.close}
                        className="btn-ghost shrink-0 p-1.5"
                    >
                        <X size={18} aria-hidden="true" />
                    </button>
                </header>

                <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                    <nav
                        role="tablist"
                        aria-orientation="vertical"
                        aria-label={vi.settings.tabsAria}
                        onKeyDown={onTabListKeyDown}
                        className="shrink-0 gap-0.5 border-b border-border p-2 md:w-48 md:flex-col md:border-b-0 md:border-r"
                    >
                        {tabs().map(({ id, label, Icon }) => {
                            // m7: `aria-controls` là QUAN HỆ "tab này điều khiển panel nào", tính theo
                            // ĐÚNG tab đang được render, không phải panel đang hiện. Bản cũ cấp một
                            // `panelId` duy nhất cho cả năm nút, nên bốn tab không active tuyên bố điều
                            // khiển cái panel của tab khác (đo thật trên trình duyệt: tab "Bộ nhớ" mang
                            // `aria-controls="settings-panel-mcp"`, rồi cả năm tab cùng trỏ một id).
                            // Chỉ một panel được render là chủ ý của APG "dynamic tabs"; id vẫn theo đúng
                            // khuôn `settings-panel-<id>` để test soi được cả năm tab chứ không chỉ tab chọn.
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    id={`settings-tab-${id}`}
                                    aria-selected={tab === id}
                                    aria-controls={`settings-panel-${id}`}
                                    tabIndex={tab === id ? 0 : -1}
                                    onClick={() => setTab(id)}
                                    className={cn(
                                        'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sidebar font-medium transition-colors',
                                        tab === id ? 'bg-bg-inset text-text-primary' : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
                                    )}
                                >
                                    <Icon size={15} aria-hidden="true" />
                                    {label}
                                </button>
                            );
                        })}
                    </nav>

                    <div
                        role="tabpanel"
                        id={panelId}
                        aria-labelledby={`settings-tab-${tab}`}
                        tabIndex={0}
                        className="min-w-0 flex-1 overflow-y-auto p-6 focus-visible:outline-none"
                    >
                        {tab === 'general' && <GeneralPanel />}
                        {tab === 'providers' && <ProvidersPanel />}
                        {tab === 'mcp' && <McpPanel />}
                        {tab === 'memory' && <MemoryPanel onCleared={onMemoryCleared} />}
                        {tab === 'advanced' && <AdvancedPanel />}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default SettingsModal;
