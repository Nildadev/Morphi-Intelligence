import { useState } from 'react';
import { AlertCircle, Check, Globe, Loader2, Trash2, UserRound } from '../icons';
import type { ProviderStatus } from '../../types';
import { ProviderLogo } from '../ProviderLogo';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';

/**
 * Một hàng provider trong Settings › Nhà cung cấp.
 *
 * BẤT BIẾN VỀ KEY: component không bao giờ nhận một key nào làm input, nên không có đường nào để nó
 * render lại key đã lưu (spec §6.6 "Không hiển thị key đã lưu"). Két sắt nằm ở Electron main
 * (`window.morphi.credentials`, preload.js:5-8); renderer chỉ biết hai sự thật boolean: két sắt CÓ key
 * hay không (`stored`, từ `credentials.status()`) và harness có dùng được key hay không
 * (`provider.configured`, từ `GET /api/providers`). Ba nhãn của spec (§6.6) suy ra từ đúng hai bit đó:
 *  - `Đã cấu hình`  — harness đang giữ key.
 *  - `Chưa cấu hình` — không có ở đâu cả.
 *  - `Lỗi`          — két sắt có key mà harness không nhận (main chưa kịp push, `server/src/index.ts:91`).
 */
export interface ProviderCardProps {
    provider: ProviderStatus;
    /** `true` khi `window.morphi.credentials.status()` báo provider này có key trong két sắt. */
    stored: boolean;
    /** Bridge IPC có tồn tại không. Dev browser thì không, nên ô key bị khoá có giải thích. */
    bridgeAvailable: boolean;
    busy: boolean;
    /** Phản hồi của lần ghi gần nhất nhất, do cha giữ để hai card không cùng hiện một thông báo. */
    feedback: { kind: 'ok' | 'err'; text: string } | null;
    onSaveKey: (key: string) => void;
    onDeleteKey: () => void;
    onSaveBaseUrl: (baseUrl: string) => void;
    /**
     * "Connect account" for a keyless provider (the DeepSeek bridge). Absent means this provider has
     * no account to connect, which is why the button is written as an optional prop: a provider that
     * cannot connect shows no button at all rather than a dead one.
     */
    onConnectAccount?: () => void;
    /** Bridge status line for a keyless provider: what the liveness probe answered. */
    bridgeStatus?: string;
}

type CardState = 'configured' | 'off' | 'error';

const STATE_STYLE: Record<CardState, string> = {
    configured: 'bg-success-bg text-success-text',
    off: 'bg-bg-inset text-text-tertiary',
    error: 'bg-danger-bg text-danger-text',
};

const stateOf = (provider: ProviderStatus, stored: boolean): CardState => {
    if (provider.configured) return 'configured';
    return stored ? 'error' : 'off';
};

function stateLabel(state: CardState): string {
    return { configured: vi.settings.configured, off: vi.settings.notConfigured, error: vi.settings.error }[state];
}

export function ProviderCard({
    provider,
    stored,
    bridgeAvailable,
    busy,
    feedback,
    onSaveKey,
    onDeleteKey,
    onSaveBaseUrl,
    onConnectAccount,
    bridgeStatus,
}: ProviderCardProps) {
    const [draft, setDraft] = useState('');
    const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? '');
    const state = stateOf(provider, stored);
    const trimmed = draft.trim();
    // Nút Lưu chết khi: không có IPC (key không đi đâu được), đang ghi, hoặc ô key rỗng. Không có
    // trường hợp "bấm rồi thất bại âm thầm".
    const canSave = bridgeAvailable && !busy && trimmed.length > 0;

    const submitKey = () => {
        if (!canSave) return;
        onSaveKey(trimmed);
        setDraft('');
    };

    return (
        <li className="space-y-4 rounded-xl border border-border bg-bg-card p-4">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <ProviderLogo provider={provider.providerId} name={provider.providerId} size={32} />
                    <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold text-text-primary">{provider.providerId}</p>
                        <p className="mt-1 text-sidebar text-text-tertiary">
                            {provider.custom ? vi.settings.customBadge : vi.settings.nativeBadge}
                            {' · '}
                            {provider.enabled ? vi.settings.providerEnabled : vi.settings.providerDisabled}
                        </p>
                    </div>
                </div>
                <span
                    className={cn(
                        'shrink-0 rounded-lg px-2.5 py-1 text-sidebar font-medium',
                        STATE_STYLE[state],
                    )}
                >
                    {stateLabel(state)}
                </span>
            </div>

            {/* Cặp `--btn-disabled-*` thay cho fade bằng opacity (§6.6.1 cấm opacity trên chữ, kể cả
             * khi control đã tắt). 4.61:1 light / 5.14:1 dark — con số chốt ở tests/tokens.test.ts. */}
            {provider.keyless ? (
                <div className="space-y-2">
                    {/* Nhà cung cấp không cần key (cầu nối DeepSeek chạy cục bộ): không có ô key nào
                      * được hiển thị cả — provider sẵn sở dụng, chỉ cần cầu nối đang chạy là models
                      * sẽ list. Thay ô key là hành động có thật: kích hoạt đăng nhập của bridge. */}
                    <p className="text-sidebar text-text-tertiary">{vi.settings.keylessProvider}</p>
                    {onConnectAccount && (
                        <div className="flex items-center gap-2">
                            {/* Connect KHÔNG qua két sắt IPC: nút chỉ POST /connect lên server, và chính
                              * server là bên probe cầu nối 127.0.0.1:8000 — dev browser (không có
                              * `window.morphi`) vẫn phải bấm được. Khác với ô key dưới đây, khoá nút theo
                              * `bridgeAvailable` sẽ tạo một nút chết không lời giải thích; cầu nối sập thì
                              * POST trả về câu trạng thái thật (unreachable) — không có trường hợp "bấm
                              * rồi thất bại âm thầm". */}
                            <button
                                type="button"
                                onClick={onConnectAccount}
                                disabled={busy}
                                aria-label={`${vi.settings.connectAccount} ${provider.providerId}`}
                                className="btn-primary shrink-0 gap-1.5 px-3 py-2"
                            >
                                {busy
                                    ? <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                                    : <UserRound size={15} aria-hidden="true" />}
                                <span>{busy ? vi.settings.bridgeChecking : vi.settings.connectAccount}</span>
                            </button>
                        </div>
                    )}
                    {bridgeStatus !== undefined && (
                        <p className="text-sidebar text-text-secondary">{bridgeStatus}</p>
                    )}
                </div>
            ) : (
            <div className="flex items-center gap-2">
                <input
                    type="password"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitKey(); } }}
                    placeholder={stored ? vi.settings.keyPlaceholder : vi.settings.newKeyPlaceholder}
                    aria-label={`${vi.settings.apiKeyFor} ${provider.providerId}`}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!bridgeAvailable || busy}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-bg-inset px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent disabled:border-[var(--btn-disabled-bg)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                />
                <button
                    type="button"
                    onClick={submitKey}
                    disabled={!canSave}
                    aria-label={`${vi.settings.saveKey} ${provider.providerId}`}
                    className="btn-primary shrink-0 gap-1.5 px-3 py-2"
                >
                    {busy
                        ? <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                        : <Check size={15} aria-hidden="true" />}
                    <span>{vi.settings.save}</span>
                </button>
                {stored && (
                    <button
                        type="button"
                        onClick={onDeleteKey}
                        disabled={busy}
                        aria-label={`${vi.settings.deleteKey} ${provider.providerId}`}
                        className="shrink-0 rounded-lg px-3 py-2 text-danger-text transition-colors hover:bg-danger-bg disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                    >
                        <Trash2 size={15} aria-hidden="true" />
                    </button>
                )}
            </div>
            )}

            {/* `baseUrl` chỉ server chấp nhận cho hàng `custom:*` (routes/providers.ts:44-48); gửi
             * lên hàng tích hợp sẵn là 400, nên ô này chỉ tồn tại khi nó thật sự ghi được. */}
            {provider.custom && (
                <div className="flex items-center gap-2">
                    <input
                        type="url"
                        value={baseUrlDraft}
                        onChange={(event) => setBaseUrlDraft(event.target.value)}
                        aria-label={`${vi.settings.baseUrlFor} ${provider.providerId}`}
                        placeholder={vi.settings.baseUrlPlaceholder}
                        spellCheck={false}
                        disabled={busy}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-bg-inset px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent disabled:border-[var(--btn-disabled-bg)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                    />
                    <button
                        type="button"
                        onClick={() => { if (baseUrlDraft.trim()) onSaveBaseUrl(baseUrlDraft.trim()); }}
                        disabled={busy || !baseUrlDraft.trim()}
                        className="shrink-0 rounded-lg px-3 py-2 text-sidebar font-semibold text-text-primary transition-colors hover:bg-bg-inset disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                    >
                        <span className="flex items-center gap-1.5">
                            <Globe size={14} aria-hidden="true" />
                            {vi.settings.saveBaseUrl}
                        </span>
                    </button>
                </div>
            )}

            {state === 'error' && (
                <p className="text-sidebar text-text-secondary">{vi.settings.keyStoredNotActive}</p>
            )}
            {feedback && (
                <p
                    role="status"
                    className={cn(
                        'flex items-start gap-2 text-sidebar',
                        feedback.kind === 'err' ? 'text-danger-text' : 'text-success-text',
                    )}
                >
                    {feedback.kind === 'err'
                        ? <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                        : <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}
                    <span>{feedback.text}</span>
                </p>
            )}
        </li>
    );
}

/**
 * Form thêm connector. Hai bước của nó là hai hành động CÓ THẬT và theo đúng thứ tự:
 * `PUT /api/providers/custom:<slug>/config` dựng hàng + mở đường dẫn (`routes/providers.ts:49-58`
 * bắt `baseUrl` cho hàng custom), rồi IPC mới ghi key. Không có key nào đi qua HTTP ở cả hai bước.
 */
export interface AddConnectorFormProps {
    existingIds: string[];
    bridgeAvailable: boolean;
    busy: boolean;
    onAdd: (input: { id: string; baseUrl: string; key: string }) => void;
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export function AddConnectorForm({ existingIds, bridgeAvailable, busy, onAdd }: AddConnectorFormProps) {
    const [slug, setSlug] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [key, setKey] = useState('');

    const cleanSlug = slug.trim().toLowerCase();
    const id = cleanSlug ? `custom:${cleanSlug}` : '';
    const duplicate = existingIds.includes(id);
    const valid = SLUG.test(cleanSlug) && /^https?:\/\/\S+$/.test(baseUrl.trim()) && key.trim().length > 0;
    // Bridge absent nghĩa là key không có chỗ nào để lưu. `addCustomProvider` sẽ tạo một connector
    // không dùng được, tức một nút dẫn vào chỗ chết (§6.6.2) — nên form khoá lại. m6: KHÔNG kèm dòng
    // "Cần chạy trong app Electron…" ở đây nữa: `SettingsModal` đã in đúng câu đó một lần ở đầu mục
    // (đo thật: hai bản sao của cùng một câu nằm trong cùng một `tabpanel` Providers); form chỉ còn là
    // nơi thực hiện luật, cờ `bridgeAvailable` vẫn là điều kiện khoá nút.
    const canAdd = bridgeAvailable && valid && !duplicate && !busy;

    const submit = () => {
        if (!canAdd) return;
        onAdd({ id, baseUrl: baseUrl.trim(), key: key.trim() });
        setSlug('');
        setBaseUrl('');
        setKey('');
    };

    return (
        <form
            className="space-y-4 rounded-xl border border-border bg-bg-inset p-4"
            onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
            <p className="text-sidebar font-semibold uppercase tracking-wide text-text-tertiary">
                {vi.settings.addConnector}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
                <input
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    aria-label={vi.settings.connectorSlug}
                    placeholder={vi.settings.connectorSlugPlaceholder}
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent"
                />
                <input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    aria-label={`${vi.settings.baseUrlFor} custom:${cleanSlug || '…'}`}
                    placeholder={vi.settings.baseUrlPlaceholder}
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent"
                />
                <input
                    type="password"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    aria-label={`${vi.settings.apiKeyFor} custom:${cleanSlug || '…'}`}
                    placeholder={vi.settings.newKeyPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent"
                />
            </div>
            <div className="flex items-center justify-between gap-3">
                <p className="text-sidebar text-text-tertiary">
                    {duplicate ? vi.settings.connectorExists : vi.settings.connectorHint}
                </p>
                <button type="submit" disabled={!canAdd} className="btn-primary shrink-0 px-3 py-2">
                    {busy
                        ? <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                        : <Globe size={15} aria-hidden="true" />}
                    <span>{vi.settings.addConnector}</span>
                </button>
            </div>
        </form>
    );
}

export default ProviderCard;
