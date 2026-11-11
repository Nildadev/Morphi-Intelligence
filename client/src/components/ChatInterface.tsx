import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Header } from './layout/Header';
import { Titlebar } from './layout/Titlebar';
import { WelcomeView } from './chat/WelcomeView';
import { ChatView } from './chat/ChatView';
import { Composer } from './chat/Composer';
import { Sidebar, readSidebarCollapsed, writeSidebarCollapsed } from './layout/Sidebar';
import { SearchPalette } from './layout/SearchPalette';
import { AppShell, DESKTOP_QUERY, useMediaQuery } from './layout/AppShell';
import { SidePanel } from './layout/SidePanel';
import { ChildSessionPanel } from './chat/ChildSessionPanel';
import { HistoryPanel } from './chat/HistoryPanel';
import { Rail, type RailAction } from './layout/Rail';
import { SettingsModal, type SettingsTab } from './settings/SettingsModal';
import { CreateProjectModal } from './CreateProjectModal';
import { ConfirmModal } from './ConfirmModal';
import { ToastContainer, useToasts } from './Toast';
import { ChevronDown, Flag, ListChecks, X } from './icons';
import type { ChatAttachment, DerivedStep, ModelInfo, PermissionMode, Project, ReasoningEffort, SessionDetail, SessionSummary, SkillMeta } from '../types';
import { latestTodos } from './chat/PlanPanel';
import { vi } from '../i18n/vi';
import { cn } from '../utils';
import { ApiError, api } from '../lib/api';
import { initialChatState } from '../lib/chatReducer';
import type { ChatAction, ChatState } from '../lib/chatReducer';
import { chatReducer, decisionFrame, errorFrameOf } from '../lib/chatUiReducer';
import type { ChatUiAction } from '../lib/chatUiReducer';
import { codeOf, errorCopy } from '../lib/errorCopy';
import { useAiLanguage } from '../lib/prefs';

/** Rail chỉ mang `SessionSummary`. `SessionDetail extends SessionSummary` nên projection truyền thẳng vào
 *  cũng compile — nhưng nó kèm `messages`/`steps`/`skills`, tức bản sao transcript ở nơi không cần. */
const summaryOf = ({
    id, projectId, projectName, title, createdAt, lastUpdated, isPinned, status, modelSelection, goalId,
}: SessionDetail): SessionSummary => ({
    id, projectId, projectName, title, createdAt, lastUpdated, isPinned, status, modelSelection, goalId,
});

export const ChatInterface: React.FC = () => {
    const [projects, setProjects] = useState<Project[]>([]);
    const [currentProjectId, setCurrentProjectId] = useState<string | undefined>(undefined);
    /** `SessionSummary` cho rail — không kèm `messages`; projection chỉ fetch khi mở phiên. */
    const [summaries, setSummaries] = useState<SessionSummary[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(undefined);
    /** Active goal for the open session, hydrated from the server projection (SessionDetail.goal). */
    const [activeGoal, setActiveGoal] = useState<string | null>(null);
    /** Plan mode for the open session, hydrated from the server projection (SessionDetail.planActive). */
    const [planActive, setPlanActive] = useState(false);
    /** Durable todo list for the composer panel (last `todo/write` wins). */
    const [todos, setTodos] = useState<Array<{ title: string; status: 'todo' | 'doing' | 'done' }>>([]);
    const [todosOpen, setTodosOpen] = useState(true);
    /** Direct subagent children of the open session (deepseek header team tree). */
    const [subagentTree, setSubagentTree] = useState<import('../types').SubagentTreeEntry[]>([]);
    const subagentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const startSubagentPolling = (sessionId: string) => {
        if (subagentPollRef.current) clearInterval(subagentPollRef.current);
        subagentPollRef.current = setInterval(() => {
            void (async () => {
                try {
                    const tree = await api.sessions.subagentTree(sessionId);
                    if (activeSessionIdRef.current === sessionId) setSubagentTree(tree);
                    if (activeSessionIdRef.current === sessionId) await reloadSession(sessionId);
                    if (!tree.some((entry) => entry.status === 'running')) {
                        if (subagentPollRef.current) clearInterval(subagentPollRef.current);
                        subagentPollRef.current = null;
                    }
                } catch {
                    // Best-effort polling; the next reload still shows the settled card.
                }
            })();
        }, 1500);
    };
    /**
     * Session-navigation history for the titlebar back/forward buttons. `back` is a stack of
     * previously open session ids (top = most recent); `forward` mirrors it after a back. Only
     * explicit open paths record (select session/project, create) — back/forward themselves move
     * through the stacks without re-recording. Boot never records (no current session yet).
     */
    const [navHistory, setNavHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
    const recordNavigation = (fromId: string | undefined, toId: string) => {
        if (!fromId || fromId === toId) return;
        setNavHistory(prev => ({ back: [...prev.back, fromId], forward: [] }));
    };
    const purgeNavigation = (ids: string[]) => {
        if (ids.length === 0) return;
        const doomed = new Set(ids);
        setNavHistory(prev => ({
            back: prev.back.filter(id => !doomed.has(id)),
            forward: prev.forward.filter(id => !doomed.has(id)),
        }));
    };
    const [chat, dispatch] = useReducer(chatReducer, initialChatState);
    /**
     * Docked right-hand panel for a subagent child session. Opening it must NOT touch the main
     * pane: the parent transcript keeps its scroll, its live draft and its running stream.
     */
    /** Call ids of the turn whose Studio-undo request is in flight (drives the summary button). */
    const [undoTurnBusy, setUndoTurnBusy] = useState<string[]>([]);
    const [sidePanel, setSidePanel] = useState<
        { kind: 'child'; title: string; childSessionId: string } | { kind: 'history'; title: string } | null
    >(null);
    const [childDetail, setChildDetail] = useState<SessionDetail | null>(null);
    const [childLoading, setChildLoading] = useState(false);
    const [childFailed, setChildFailed] = useState(false);
    /**
     * Sessions with a live turn. Deepseek-style: a turn belongs to its session, not to the pane —
     * switching chats keeps the SSE open and the server keeps producing. `streaming` below is only
     * the active session's slice of this set.
     */
    const [runningSessions, setRunningSessions] = useState<ReadonlySet<string>>(() => new Set());
    const runningSessionsRef = useRef<Set<string>>(new Set());
    /** One controller per running session; Stop only aborts the active one. */
    const controllersRef = useRef<Map<string, AbortController>>(new Map());
    /** Per-session "Stop was pressed before the stream existed" flags (`'__new__'` covers session creation). */
    const cancelRequestedRef = useRef<Set<string>>(new Set());
    /** Per-session send gates, so a running turn in chat A never blocks sending in chat B. */
    const turnInFlightRef = useRef<Set<string>>(new Set());
    /** Last known reducer state per session, used to restore a background chat instantly. */
    const cachedStatesRef = useRef<Map<string, ChatState>>(new Map());
    const chatRef = useRef(chat);
    chatRef.current = chat;
    /**
     * Session whose first HTTP round-trip (`ensureSession`) is still in flight. `'__new__'` is the
     * pre-session window. The composer only shows its starting state for the matching session.
     */
    const [startingSessionId, setStartingSessionId] = useState<string | null>(null);
    const startingSessionRef = useRef<string | null>(null);
    const markStarting = (id: string | null) => {
        startingSessionRef.current = id;
        setStartingSessionId(id);
    };
    const [composerDraft, setComposerDraft] = useState<{ text: string; nonce: number } | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    /**
     * Mục Settings đang mở. `MemoryManagerModal` không còn tồn tại (Task 24): rail "Bộ nhớ" và
     * CTA "Mở Cài đặt" cùng mở MỘT hộp ở hai mục khác nhau, nên tab là state của hộp, không phải
     * của modal riêng.
     */
    const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
    const [showCreateProject, setShowCreateProject] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    // Below the desktop breakpoint the sidebar is a drawer; it starts closed (the chat owns the
    // narrow space) and opens only on demand via the titlebar toggle.
    const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
        try {
            return window.matchMedia(DESKTOP_QUERY).matches;
        } catch {
            return true;
        }
    });
    const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
    const [focusProjectsSignal, setFocusProjectsSignal] = useState(0);
    const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
    const [mcpConnected, setMcpConnected] = useState<boolean | null>(null);
    const [models, setModels] = useState<ModelInfo[]>([]);
    /** `/api/skills` catalogue for the "/" palette; an empty list is a valid state. */
    const [skills, setSkills] = useState<SkillMeta[]>([]);
    /** `''` là lựa chọn "tự động" duy nhất có thật: không gửi field `model` nào, server tự quyết. */
    const [selectedModel, setSelectedModel] = useState('');
    /**
     * Mức suy nghĩ đã chọn cho lượt kế tiếp. `''` = không gửi gì. Chỉ model tự khai `efforts` mới
     * đặt được, nên đổi sang model không suy nghĩ thì lựa chọn cũ bị xoá thay vì gửi một mức vô nghĩa.
     */
    const [effort, setEffort] = useState<ReasoningEffort | ''>('');
    /**
     * Chế độ duyệt tool cho lượt kế tiếp (`ask` | `balanced` | `full`). Mặc định `balanced` — trùng
     * với hành vi cũ trước khi có selector, nên người dùng chưa từng thấy nút này vẫn nhận quyền cũ.
     * Lưu localStorage để lần mở sau nhớ lựa chọn rủi ro của họ.
     */
    const [permission, setPermission] = useState<PermissionMode>(() => {
        const saved = localStorage.getItem('morphi.permissionMode');
        return saved === 'ask' || saved === 'full' ? saved : 'balanced';
    });
    useEffect(() => {
        localStorage.setItem('morphi.permissionMode', permission);
    }, [permission]);

    /** Settings → AI reply language; `auto` omits the field so the server follows the message. */
    const aiLanguage = useAiLanguage();
    const turnLanguage = aiLanguage === 'auto' ? undefined : aiLanguage;

    // Keep the chosen effort valid for the selected model (Task 31D fix): a model that declares a
    // level set only accepts levels from that set, so we never send a knob it never offered. When the
    // model changes, keep the current level if it still applies, otherwise fall back to its first
    // level. A model with no efforts keeps `''` (no level sent).
    useEffect(() => {
        const model = models.find((candidate) => candidate.id === selectedModel);
        if (!model?.efforts?.length) {
            if (effort !== '') setEffort('');
            return;
        }
        if (effort === '' || !model.efforts.includes(effort)) setEffort(model.efforts[0]);
    }, [selectedModel, models, effort]);

    // Vòng context window (Task 31): tổng token đã dùng từ lịch sử tin nhắn và context của model đang
    // chọn. `formatContextWindow` trong ContextRing lo định dạng. Auto (`''`) dùng context lớn nhất
    // của catalogue as proxy để vòng luôn hiện thay vì biến mất.
    const contextWindow = useMemo(() => {
        const selected = models.find(model => model.id === selectedModel);
        const fallbackTotal = models.reduce((max, model) => Math.max(max, model.context ?? 0), 0);
        const used = chat.messages.reduce(
            (sum, message) => sum + (message.usage?.totalTokens ?? 0),
            0,
        );
        return {
            usedTokens: used,
            totalTokens: selected?.context ?? fallbackTotal,
            modelName: selected?.name ?? vi.composer.modelAuto,
        };
    }, [models, selectedModel, chat.messages]);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    // Giữ `currentSessionId` trong một ref ĐỒNG BỘ để nút Stop hủy được tin nhắn ĐẦU TIÊN, trước khi
    // React kịp render lại với session id mới.
    const activeSessionIdRef = useRef<string | undefined>(undefined);
    const currentProjectIdRef = useRef<string | undefined>(undefined);
    const { toasts, showToast, dismissToast } = useToasts();

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const setSessionRunning = (sessionId: string, running: boolean) => {
        const next = new Set(runningSessionsRef.current);
        if (running) next.add(sessionId);
        else next.delete(sessionId);
        runningSessionsRef.current = next;
        setRunningSessions(next);
    };

    /** Fold one live frame into the session it belongs to, whether it is on screen or in the background. */
    const applyFrame = (sessionId: string, frame: ChatAction) => {
        if (activeSessionIdRef.current === sessionId) {
            dispatch(frame);
            return;
        }
        const previous = cachedStatesRef.current.get(sessionId) ?? initialChatState;
        cachedStatesRef.current.set(sessionId, chatReducer(previous, frame));
    };

    /** Apply a projection/reducer-only action to the session it belongs to (active pane or cache). */
    const applyProjection = (sessionId: string, action: ChatUiAction) => {
        if (activeSessionIdRef.current === sessionId) {
            dispatch(action);
            return;
        }
        const previous = cachedStatesRef.current.get(sessionId) ?? initialChatState;
        cachedStatesRef.current.set(sessionId, chatReducer(previous, action));
    };

    // Keep the active pane's snapshot fresh so switching away never loses the last rendered frame.
    useEffect(() => {
        if (currentSessionId) cachedStatesRef.current.set(currentSessionId, chat);
    }, [chat, currentSessionId]);

    /** Abort one session's turn (used by Stop, undo, delete, memory clear). */
    const abortSession = (sessionId: string) => {
        cancelRequestedRef.current.add(sessionId);
        controllersRef.current.get(sessionId)?.abort();
    };

    const abortAllTurns = () => {
        for (const sessionId of controllersRef.current.keys()) abortSession(sessionId);
        cancelRequestedRef.current.add('__new__');
    };

    /** The active pane's live state only; other sessions keep running in `runningSessions`. */
    const streaming = currentSessionId !== undefined && runningSessions.has(currentSessionId);
    const starting = startingSessionId !== null
        && (startingSessionId === currentSessionId || startingSessionId === '__new__');

    const checkMcp = useCallback(async () => {
        try {
            // `GET /api/mcp/status` mới là route trả `connected`/`studioLinked`; fetch cũ đọc
            // `/api/tools`, nơi hai field đó đã bị bỏ từ Task 17.
            const status = await api.mcp.status();
            // "Đã kết nối" chỉ tính khi bridge MCP đã link được vào Roblox Studio. `connected`
            // của bridge (Morphi server đã spawn MCP) là chưa đủ.
            setMcpConnected(status.connected === true && status.studioLinked === true);
        } catch {
            setMcpConnected(false);
        }
    }, []);

    const loadModels = useCallback(async () => {
        // The registry refreshes the catalogue asynchronously (and re-pulls it after every
        // credential push), so the first GET right after a boot can legitimately beat the cache.
        // Retry briefly on an empty list instead of pinning the "no provider" state.
        for (let attempt = 0; ; attempt++) {
            try {
                const list = await api.models.list();
                if (list.length > 0) {
                    setModels(list);
                    return;
                }
            } catch (error) {
                if (attempt >= 9) {
                    showToast('error', errorCopy(codeOf(error)), vi.composer.modelsError);
                    return;
                }
            }
            if (attempt >= 9) return;
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    }, [showToast]);

    /** Skills are an optional catalogue: a failed fetch leaves the palette with commands only. */
    const loadSkills = useCallback(async () => {
        try {
            setSkills(await api.skills.list());
        } catch {
            setSkills([]);
        }
    }, []);

    /**
     * Mirror the open session into the sidebar list. Gates: only once the session carries a real
     * message and it is not a subagent child (children open from the team menu, never the list).
     * Runs both on the turn-end reload and as soon as the first `user/message` lands, so a chat
     * that already has a question (and an answer) does not stay invisible until the turn settles.
     */
    const syncSummary = useCallback((detail: SessionDetail) => {
        setSummaries(prev => {
            const existing = prev.find(s => s.id === detail.id);
            if (existing) {
                return prev.map(s => (s.id === detail.id
                    ? { ...s, title: detail.title, lastUpdated: detail.lastUpdated, status: detail.status }
                    : s));
            }
            if (detail.messages.length === 0 || detail.isSubagent === true) return prev;
            return [summaryOf(detail), ...prev];
        });
    }, []);

    const reloadSession = useCallback(async (id: string) => {
        // `runTurn` calls this in `finally` even after the user switched away: the projection must
        // reconcile the session it belongs to, never overwrite the pane that is currently open.
        try {
            const detail = await api.sessions.get(id);
            applyProjection(id, {
                type: 'session/reload',
                messages: detail.messages,
                // A persisted `turn/end.error` is authoritative and restores on reopen. An absent
                // error must NOT erase a live transport/HTTP failure (409, socket, …) that the
                // server never wrote to the log; `turn/start` is what clears that one.
                ...(detail.error === undefined ? {} : { error: detail.error }),
                // A live background turn owns its un-settled draft; a settled reload has an empty
                // draft already, so this is a no-op for finished turns.
                preserveDraft: runningSessionsRef.current.has(id),
            });
            if (activeSessionIdRef.current === id) {
                // The latest `goal/changed` event, hydrated by the store — the goal bar's source.
                setActiveGoal(detail.goal ?? null);
                setPlanActive(detail.planActive === true);
                setTodos(detail.todos ?? []);
                // Subagent team tree (running children show live via polling).
                api.sessions.subagentTree(id).then((tree) => {
                    if (activeSessionIdRef.current === id) setSubagentTree(tree);
                }).catch(() => undefined);
            }
            // `session/title` có thể đến sau `turn/end` (auto-title không chặn stream) hoặc không đến
            // hẳn, nên rail cập nhật từ projection chứ không chờ frame.
            syncSummary(detail);
        } catch (error) {
            // Phiên bị xoá (Memory clear / delete) lúc stream đang chạy: không còn gì để reload.
            if (error instanceof ApiError && (error.code === 'SESSION_NOT_FOUND' || error.status === 404)) return;
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi tải lại phiên');
        }
    }, [showToast, syncSummary]);

    /** Mở một phiên: `SessionDetail` chỉ được fetch ở đây, không phải từ danh sách rail. */
    const openSession = useCallback(async (id: string) => {
        const previous = activeSessionIdRef.current;
        if (previous !== id) {
            // Deepseek-style background chats: switching panes NEVER aborts the outgoing turn.
            // Keep its last rendered state in the cache; the still-open SSE keeps folding frames
            // into that cache until the turn settles.
            if (previous) cachedStatesRef.current.set(previous, chatRef.current);
            activeSessionIdRef.current = id;
            setCurrentSessionId(id);
            const cached = cachedStatesRef.current.get(id);
            if (cached) {
                dispatch({ type: 'session/restore', state: cached });
            } else {
                // Live-only state belongs to the session that produced it; a fresh pane starts empty.
                dispatch({ type: 'session/open', messages: [] });
            }
        }
        await reloadSession(id);
    }, [reloadSession]);

    const resetTranscript = useCallback(() => {
        // Clears the pane, not the turns: background chats keep running and keep their cache.
        if (subagentPollRef.current) clearInterval(subagentPollRef.current);
        subagentPollRef.current = null;
        activeSessionIdRef.current = undefined;
        setCurrentSessionId(undefined);
        setActiveGoal(null);
        setPlanActive(false);
        setTodos([]);
        setSubagentTree([]);
        dispatch({ type: 'session/open', messages: [] });
    }, []);

    // The sidebar groups chats under every project header, so it needs ALL summaries,
    // not just the current project's. Selection still resolves the first chat per project.
    const loadSummaries = useCallback(async (): Promise<SessionSummary[]> => {
        const data = await api.sessions.list();
        setSummaries(data);
        return data;
    }, []);

    const handleSelectProject = useCallback(async (projectId: string) => {
        currentProjectIdRef.current = projectId;
        setCurrentProjectId(projectId);
        try {
            const data = await loadSummaries();
            const first = data.filter(session => session.projectId === projectId)[0];
            if (first) {
                recordNavigation(activeSessionIdRef.current, first.id);
                await openSession(first.id);
            } else {
                resetTranscript();
            }
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi tải phiên');
        }
    }, [loadSummaries, openSession, resetTranscript, showToast]);

    const loadProjects = useCallback(async () => {
        try {
            const data = await api.projects.list();
            setProjects(data);
            if (data.length > 0 && !currentProjectIdRef.current) {
                void handleSelectProject(data[0].id);
            }
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Không kết nối được tới server harness');
        }
    }, [handleSelectProject, showToast]);

    useEffect(() => { scrollToBottom(); }, [chat.messages.length, chat.draft.content]);

    /**
     * Boot. Dep của effect này ổn định vì `showToast` đã được memo trong `useToasts` — cả chuỗi
     * `reloadSession` → `openSession` → `handleSelectProject` → `loadProjects` giữ nguyên identity sau
     * render, nên effect chạy ĐÚNG MỘT lần thay vì tự chạy lại sau mỗi lần `setProjects(mảng mới)`.
     */
    useEffect(() => {
        void loadProjects();
        void checkMcp();
        void loadModels();
        void loadSkills();
    }, [checkMcp, loadModels, loadProjects, loadSkills]);

    /**
     * Poll MCP + abort lúc unmount, tách riêng vì hai thứ này chỉ sống theo mount/unmount. Chung effect
     * với boot thì mỗi lần callback đổi identity là interval bị reset VÀ các controller đang chạy bị abort
     * giữa chừng — tức stream vừa mở bị ngắt ngay commit kế tiếp.
     */
    useEffect(() => {
        const intervalId = setInterval(() => { void checkMcp(); }, 5000);
        return () => {
            clearInterval(intervalId);
            // Unmount is app teardown: every live SSE belongs to this renderer, so abort them all
            // (the server's `res.on('close')` then stops the turns).
            for (const controller of controllersRef.current.values()) controller.abort();
        };
    }, [checkMcp]);

    const handleReconnectMcp = async () => {
        try {
            await api.mcp.reconnect();
            showToast('info', 'Đang kết nối lại với Roblox Studio MCP…', 'MCP');
            setTimeout(checkMcp, 3000);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi MCP');
        }
    };

    const handleSelectSession = (id: string) => {
        recordNavigation(activeSessionIdRef.current, id);
        void openSession(id);
    };

    /**
     * Opens a child session in the docked side panel. The existing entry points (the subagent row
     * and the header's team menu) used to swap the main pane; that would discard the parent's
     * scroll position and hide the turn the child belongs to, so they now fill the panel instead.
     * The main transcript — and any turn still streaming into it — is left untouched.
     */
    const handleOpenChildSession = useCallback((childSessionId: string) => {
        const child = subagentTree.find((entry) => entry.childSessionId === childSessionId);
        setSidePanel({
            kind: 'child',
            title: child?.task ?? child?.memberName ?? vi.chat.subagentTitle,
            childSessionId,
        });
    }, [subagentTree]);

    useEffect(() => {
        if (sidePanel === null || sidePanel.kind !== 'child') {
            setChildDetail(null);
            setChildFailed(false);
            return undefined;
        }
        let cancelled = false;
        setChildLoading(true);
        setChildFailed(false);
        api.sessions.get(sidePanel.childSessionId).then((detail) => {
            if (cancelled) return;
            setChildDetail(detail);
            setChildLoading(false);
        }).catch(() => {
            if (cancelled) return;
            setChildDetail(null);
            setChildLoading(false);
            setChildFailed(true);
        });
        return () => {
            cancelled = true;
        };
    }, [sidePanel]);

    /**
     * Một lượt (stream hoặc regenerate) từ đầu tới cuối. `onEvent` chỉ dispatch frame; mọi state
     * transcript đều đi qua reducer. Khi kết thúc — kể cả abort trước byte đầu tiên, resolved với
     * 0 frame — projection được reload, vì đó mới là bản authoritative.
     */
    const runTurn = useCallback(async (
        sessionId: string,
        start: (onEvent: (frame: ChatAction) => void, signal: AbortSignal) => Promise<void>,
    ) => {
        const controller = new AbortController();
        controllersRef.current.set(sessionId, controller);
        setSessionRunning(sessionId, true);
        // A fresh session only enters the sidebar once it carries a real message; the frame IS the
        // durable proof, so sync the summary immediately instead of waiting for `turn/end`.
        let summarySynced = false;
        try {
            // Stop bấm trong cửa sổ `starting`: lượt này không được phép chạy nữa, nhưng phải đi qua
            // `finally` để reconcile phiên vừa được `ensureSession` tạo ra (Ruling T22-6/C13).
            if (cancelRequestedRef.current.has(sessionId) || cancelRequestedRef.current.has('__new__')) return;
            // Frames belong to the session that produced them. The active pane gets the reducer;
            // a background session folds into its cache and is restored when the user returns.
            await start((frame) => {
                if (cancelRequestedRef.current.has(sessionId) || cancelRequestedRef.current.has('__new__')) return;
                applyFrame(sessionId, frame);
                if (frame.type === 'user/message' && !summarySynced) {
                    summarySynced = true;
                    api.sessions.get(sessionId)
                        .then((detail) => syncSummary(detail))
                        .catch(() => undefined);
                }
            }, controller.signal);
        } catch (error) {
            if (!cancelRequestedRef.current.has(sessionId) && !cancelRequestedRef.current.has('__new__')) {
                applyFrame(sessionId, errorFrameOf(error));
            }
        } finally {
            controllersRef.current.delete(sessionId);
            // Reload while the session still counts as running: a partial draft survives, while a
            // settled turn already cleared its draft on `turn/end`.
            await reloadSession(sessionId);
            setSessionRunning(sessionId, false);
            cancelRequestedRef.current.delete(sessionId);
            cancelRequestedRef.current.delete('__new__');
        }
    }, [reloadSession, syncSummary]);

    const handleStop = () => {
        // Đọc ref trước: với tin nhắn đầu, session id đã được gán ĐỒNG BỘ ngay trong `handleSend`,
        // trước khi React render lại.
        const activeId = activeSessionIdRef.current ?? currentSessionId;
        if (!activeId) {
            // Cửa sổ `starting` trước khi phiên đầu tiên tồn tại: chưa có stream để abort, còn
            // `api.chat.cancel` thì nhắm vào một lượt chưa tồn tại. Ghi cờ — `runTurn` kiểm tra cờ trước
            // khi bắt đầu và trước mỗi frame, nên bấm Stop là lượt không chạy.
            cancelRequestedRef.current.add('__new__');
            return;
        }
        abortSession(activeId);
        // Không tự xoá bong bóng/draft thủ công: transport phát `turn/end reason:'cancelled'` khi
        // reader nhận AbortError, còn abort trước byte đầu tiên thì resolve với 0 frame — lần reload
        // trong `finally` mới là bản reconcile đúng cho cả hai trường hợp.
        void api.chat.cancel(activeId).catch(() => { });
    };

    const handleRegenerate = async (assistantMessageId: string) => {
        const sessionId = activeSessionIdRef.current ?? currentSessionId;
        if (!sessionId || streaming || starting || turnInFlightRef.current.has(sessionId)) return;
        turnInFlightRef.current.add(sessionId);
        cancelRequestedRef.current.delete(sessionId);
        try {
            await runTurn(sessionId, (onEvent, signal) =>
                api.chat.regenerate({
                    sessionId,
                    assistantMessageId,
                    ...(turnLanguage === undefined ? {} : { language: turnLanguage }),
                }, onEvent, signal));
        } finally {
            turnInFlightRef.current.delete(sessionId);
            cancelRequestedRef.current.delete(sessionId);
        }
    };

    const handleUndoMessage = async (userMessageId: string) => {        const sessionId = activeSessionIdRef.current ?? currentSessionId;
        if (!sessionId || streaming || starting || turnInFlightRef.current.has(sessionId)) return;
        // Capture the text BEFORE the revert: the undone user message lands back in the
        // composer so the user can edit and resend it instead of retyping.
        const undone = chat.messages.find((message) => message.id === userMessageId && message.role === 'user');
        turnInFlightRef.current.add(sessionId);
        try {
            abortSession(sessionId);
            const detail = await api.sessions.undoMessage(sessionId, userMessageId);
            if (activeSessionIdRef.current === sessionId) {
                dispatch({ type: 'session/undo', messages: detail.messages });
                await reloadSession(sessionId);
                if (undone) setComposerDraft({ text: undone.content, nonce: Date.now() });
            }
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Không thể hoàn tác');
        } finally {
            turnInFlightRef.current.delete(sessionId);
            cancelRequestedRef.current.delete(sessionId);
        }
    };

    /**
     * Undo the Studio changes of one turn — the "Hoàn tác" button on the end-of-message script
     * summary. This is the workspace half of undo: `handleUndoMessage` reverts the conversation,
     * this restores the scripts the turn wrote.
     *
     * The toast reports what the server actually did, never a generic "done": a refused turn
     * (drift), a partial restore and "nothing restorable" are three different outcomes and the
     * user has to know which one they got.
     */
    const handleUndoTurn = async (callIds: string[]) => {        const sessionId = activeSessionIdRef.current ?? currentSessionId;
        if (!sessionId || callIds.length === 0) return;
        setUndoTurnBusy(callIds);
        try {
            const result = await api.sessions.undoTurn(sessionId, callIds);
            if (result.drift.length > 0) {
                showToast('error', vi.chat.undoDrift, vi.chat.undoTurn);
            } else if (result.restored.length === 0) {
                showToast('warning', vi.chat.undoNothing, vi.chat.undoTurn);
            } else if (result.failed.length > 0) {
                showToast(
                    'error',
                    `${vi.chat.undoPartial} ${result.failed.map((entry) => entry.reason).join('; ')}`,
                    vi.chat.undoTurn,
                );
            } else {
                showToast('success', vi.chat.undoRestored, vi.chat.undoTurn);
            }
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), vi.chat.undoTurn);
        } finally {
            setUndoTurnBusy([]);
        }
    };

    const handleClearQueued = async () => {
        const sessionId = activeSessionIdRef.current ?? currentSessionId;
        if (!sessionId) return;
        try {
            await api.chat.clearQueue(sessionId);
            dispatch({ type: 'transport/queued-clear', payload: {} });
            showToast('info', vi.composer.clearedQueued);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Không huỷ được hàng đợi');
        }
    };

    const ensureSession = async (model?: string, existingId?: string): Promise<string> => {
        // Tin nhắn đầu tiên: project + session được tạo TRƯỚC khi stream, và id luôn là id server trả
        // về (`POST /api/sessions` -> 201 `SessionDetail`), nên không còn id tạm nào có thể trôi.
        let projectId = currentProjectIdRef.current;
        if (!projectId) {
            const project = await api.projects.create({ name: 'My Project' });
            currentProjectIdRef.current = project.id;
            setProjects(prev => [project, ...prev]);
            setCurrentProjectId(project.id);
            projectId = project.id;
        }
        const existing = existingId ?? activeSessionIdRef.current ?? currentSessionId;
        if (existing) return existing;
        // Không tự đặt title từ tin nhắn: `routes/chat.ts` chỉ sinh auto-title khi còn `DEFAULT_TITLE`.
        const detail = await api.sessions.create({ projectId, ...(model ? { model } : {}) });
        activeSessionIdRef.current = detail.id;
        setCurrentSessionId(detail.id);
        setSummaries(prev => [summaryOf(detail), ...prev]);
        return detail.id;
    };

    /**
     * Toàn bộ phần chờ HTTP của một lượt. Tách khỏi `handleSend` để hàm đó trả lời ĐỒNG BỘ "có nhận tin
     * nhắn này không" — `Composer` cần câu trả lời trước khi xoá textarea.
     */
    const sendTurn = async (
        text: string,
        model?: string,
        level?: ReasoningEffort,
        mode?: PermissionMode,
        attachments?: ChatAttachment[],
    ) => {
        const key = activeSessionIdRef.current ?? '__new__';
        const existingAtStart = activeSessionIdRef.current ?? currentSessionId;
        // The `starting` window starts BEFORE `ensureSession`'s HTTP round-trip, so Stop renders
        // immediately and a second send in the same session is refused synchronously.
        markStarting(key);
        turnInFlightRef.current.add(key);
        cancelRequestedRef.current.delete(key);
        let sessionId: string | undefined;
        try {
            try {
                sessionId = await ensureSession(model, existingAtStart);
            } catch (error) {
                showToast('error', errorCopy(codeOf(error)), 'Lỗi khi tạo phiên');
                return;
            }
            // A `const` capture: the SSE callback runs later, when TypeScript can no longer prove a
            // mutable `let` still holds the resolved id.
            const turnSessionId = sessionId;
            // The pre-session gate moves to the real id so a second send cannot slip in between
            // `ensureSession` resolving and `runTurn` registering its controller.
            if (key === '__new__') {
                // Stop pressed while the session row was being created: carry the flag onto the
                // real id so `runTurn` refuses to start the stream.
                const cancelledBeforeStart = cancelRequestedRef.current.has('__new__');
                turnInFlightRef.current.delete('__new__');
                turnInFlightRef.current.add(turnSessionId);
                cancelRequestedRef.current.delete('__new__');
                if (cancelledBeforeStart) cancelRequestedRef.current.add(turnSessionId);
                markStarting(turnSessionId);
            }
            // Không có bong bóng user optimistic: `user/message` là hàng bền và là nguồn duy nhất.
            // `runTurn` đặt session vào `runningSessions` ĐỒNG BỘ tới `await` đầu tiên, nên tới
            // lúc nó trả promise thì lượt đã chạy thật — gỡ `starting` ngay tại đây để textarea mở lại
            // cho steer/queue trong lúc streaming (trước đây gỡ ở finally là khóa cả lượt).
            const turn = runTurn(turnSessionId, (onEvent, signal) => api.chat.stream(
                {
                    sessionId: turnSessionId,
                    message: text,
                    ...(model ? { model } : {}),
                    ...(level ? { effort: level } : {}),
                    ...(mode && mode !== 'balanced' ? { permissionMode: mode } : {}),
                    ...(turnLanguage === undefined ? {} : { language: turnLanguage }),
                    ...(attachments && attachments.length > 0 ? { attachments } : {}),
                },
                onEvent,
                signal,
            ));
            markStarting(null);
            await turn;
        } finally {
            turnInFlightRef.current.delete(key);
            if (sessionId) turnInFlightRef.current.delete(sessionId);
            cancelRequestedRef.current.delete(sessionId ?? key);
            if (startingSessionRef.current === sessionId || startingSessionRef.current === key) markStarting(null);
        }
    };

    /**
     * Parameterised slash commands: `/goal <text>`, `/subagent <text>`, `/workflow <text>`,
     * `/plan [off|<text>]`. They are dispatched before the busy gate (goals/plan toggles are
     * independent events, not turns; `/plan <text>` then flows on as a normal send).
     * Everything else — and `/workflow` — flows on as a normal send.
     */
    const COMMAND_PREFIX = /^\/(goal|subagent|workflow|plan)(?:\s+([\s\S]*))?$/;

    const handleGoal = async (objective: string) => {
        try {
            const sessionId = await ensureSession();
            const result = await api.sessions.setGoal(sessionId, objective);
            setActiveGoal(result.objective);
            showToast('info', `${vi.composer.goalSet}: ${objective}`);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi đặt mục tiêu');
        }
    };

    const handleClearGoal = async () => {
        const id = activeSessionIdRef.current ?? currentSessionId;
        if (!id) return;
        try {
            await api.sessions.clearGoal(id);
            setActiveGoal(null);
            showToast('info', vi.composer.goalCleared);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi xoá mục tiêu');
        }
    };

    const handleClearPlanMode = async () => {
        const id = activeSessionIdRef.current ?? currentSessionId;
        if (!id) return;
        try {
            await api.sessions.clearPlanMode(id);
            setPlanActive(false);
            showToast('info', vi.composer.planOff);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi đổi chế độ kế hoạch');
        }
    };

    const handleSubagent = async (task: string) => {
        try {
            const sessionId = await ensureSession();
            await api.sessions.runSubagent(sessionId, task);
            // Card appears immediately (subagent/start is durable); poll keeps it live.
            if (activeSessionIdRef.current === sessionId) {
                await reloadSession(sessionId);
                startSubagentPolling(sessionId);
            }
            showToast('info', vi.composer.subagentStarted);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi chạy subagent');
        }
    };

    const handleSteer = async (text: string, model?: string, level?: ReasoningEffort, mode?: PermissionMode, attachments?: ChatAttachment[]): Promise<boolean> => {
        const sessionId = activeSessionIdRef.current ?? currentSessionId;
        if (!sessionId) return false;
        if (attachments && attachments.length > 0) {
            showToast('warning', 'Ảnh không chèn được vào lượt đang chạy — gửi lại sau khi lượt hiện tại kết thúc.');
        }
        try {
            await api.chat.stream(
                {
                    sessionId,
                    message: text,
                    ...(model ? { model } : {}),
                    ...(level ? { effort: level } : {}),
                    ...(mode && mode !== 'balanced' ? { permissionMode: mode } : {}),
                    ...(turnLanguage === undefined ? {} : { language: turnLanguage }),
                },
                (frame) => {
                    if (activeSessionIdRef.current === sessionId) dispatch(frame);
                },
                new AbortController().signal,
            );
            return true;
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi gửi chèn');
            return false;
        }
    };

    /**
     * KHÔNG `async`: khoá đồng bộ phải xảy ra ngay tại đây, để tin nhắn thứ hai của CÙNG phiên bị từ chối
     * ở cửa này chứ không phải ở `runTurn`, và để `Composer` giữ được nội dung khi kết quả là `false`.
     * Phiên khác vẫn gửi được vì khoá là per-session.
     */
    const handleSend = (
        text: string,
        model?: string,
        level?: ReasoningEffort,
        mode?: PermissionMode,
        attachments?: ChatAttachment[],
    ): boolean => {
        const command = text.match(COMMAND_PREFIX);
        if (command) {
            const [, name, rawArg] = command;
            const arg = (rawArg ?? '').trim();
            if (name === 'goal') {
                if (!arg) { showToast('warning', vi.composer.goalUsage); return true; }
                void handleGoal(arg);
                return true;
            }
            if (name === 'subagent') {
                if (!arg) { showToast('warning', vi.composer.subagentUsage); return true; }
                void handleSubagent(arg);
                return true;
            }
            if (name === 'workflow') {
                if (!arg) { showToast('warning', vi.composer.workflowUsage); return true; }
                // The morphi-workflow skill fires on its `/workflow` trigger inside the message.
                text = `morphi-workflow ${arg}`;
            }
            if (name === 'plan') {
                // Deepseek `plan-mode`: bare `/plan` enters, `/plan off` leaves, `/plan <text>`
                // enters and the text becomes the next request under plan guidance.
                if (arg.toLowerCase() === 'off') {
                    void handleClearPlanMode();
                    return true;
                }
                if (planActive && !arg) {
                    showToast('info', vi.composer.planOn);
                    return true;
                }
                // Enable synchronously before the turn starts so the prompt folds it.
                if (!planActive) {
                    const sessionId = activeSessionIdRef.current ?? currentSessionId;
                    if (sessionId) {
                        void api.sessions.setPlanMode(sessionId, true).then(() => setPlanActive(true)).catch(() => undefined);
                    } else {
                        void (async () => {
                            try {
                                const ensured = await ensureSession();
                                await api.sessions.setPlanMode(ensured, true);
                                setPlanActive(true);
                            } catch {
                                // The turn itself will surface a real error.
                            }
                        })();
                    }
                }
                if (!arg) {
                    if (!planActive) showToast('info', vi.composer.planOn);
                    return true;
                }
                text = arg;
            }
        }
        // Prompt queue: while a turn streams, the next message is a steer (deepseek inbox).
        if (streaming && !starting) {
            void handleSteer(text, model, level, mode, attachments);
            return true;
        }
        const activeId = activeSessionIdRef.current ?? currentSessionId;
        if (starting || (activeId ? turnInFlightRef.current.has(activeId) : turnInFlightRef.current.has('__new__'))) return false;
        void sendTurn(text, model, level, mode, attachments);
        return true;
    };

    const handleNewSession = async () => {
        const projectId = currentProjectIdRef.current;
        if (!projectId) { setShowCreateProject(true); return; }
        const fromId = activeSessionIdRef.current;
        try {
            const detail = await api.sessions.create({ projectId });
            // Switching chats is a pane change, not a cancellation: a running turn in `fromId`
            // keeps streaming into its cache (deepseek background chats).
            if (fromId) cachedStatesRef.current.set(fromId, chatRef.current);
            if (subagentPollRef.current) clearInterval(subagentPollRef.current);
            subagentPollRef.current = null;
            recordNavigation(fromId, detail.id);
            setActiveGoal(null);
            setPlanActive(false);
            setTodos([]);
            setSubagentTree([]);
            // The row joins the sidebar only once the first message lands (reloadSession upserts
            // it) — an abandoned "new chat" never occupies a slot in the list.
            activeSessionIdRef.current = detail.id;
            setCurrentSessionId(detail.id);
            dispatch({ type: 'session/open', messages: detail.messages });
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi tạo phiên');
        }
    };

    /** A project header's `+`: switch to that project, then open a new chat inside it. */
    const handleNewSessionInProject = async (projectId: string) => {
        currentProjectIdRef.current = projectId;
        setCurrentProjectId(projectId);
        await handleNewSession();
    };

    /** Mọi lối vào Settings đi qua đây: chọn mục TRƯỚC khi mở để hiệu ứng `initialTab` trong modal chạy. */
    const openSettings = useCallback((tab: SettingsTab) => {
        setSettingsTab(tab);
        setShowSettings(true);
    }, []);

    /** Đích của rail là hành động THẬT, không phải view placeholder (mục thừa kế 1 / §6.6.2). */
    const handleRailAction = (action: RailAction) => {
        switch (action) {
            case 'newChat':
                void handleNewSession();
                break;
            case 'search':
                setShowSearch(true);
                break;
            case 'projects':
                setFocusProjectsSignal(signal => signal + 1);
                break;
            case 'memory':
                openSettings('memory');
                break;
            // Git-like history (Phase 4): the Studio checkpoints of the OPEN session, in the same
            // docked panel the subagent uses. A session must exist — the list is per-session.
            case 'history':
                if (currentSessionId == null) {
                    openSettings('general');
                    break;
                }
                setSidePanel({ kind: 'history', title: vi.history.title });
                break;
            case 'settings':
                openSettings('general');
                break;
        }
    };

    const handleCreateProject = async (name: string) => {
        try {
            const project = await api.projects.create({ name });
            setProjects(prev => [project, ...prev]);
            await handleSelectProject(project.id);
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi tạo project');
        }
    };

    const handleDeleteProject = (id: string) => setProjectToDelete(id);

    const confirmDeleteProject = async () => {
        if (!projectToDelete) return;
        try {
            // Deleting a project kills its sessions server-side; abort any live turns it owns.
            for (const summary of summaries) {
                if (summary.projectId === projectToDelete) abortSession(summary.id);
            }
            await api.projects.delete(projectToDelete);
            // Sessions of the deleted project stop existing: they leave the nav history too.
            purgeNavigation(summaries.filter(s => s.projectId === projectToDelete).map(s => s.id));
            setProjectToDelete(null);
            if (currentProjectIdRef.current === projectToDelete) {
                currentProjectIdRef.current = undefined;
                setCurrentProjectId(undefined);
                setSummaries([]);
                resetTranscript();
            }
            void loadProjects();
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi xoá project');
        }
    };

    const handleDeleteSession = async (id: string) => {
        try {
            abortSession(id);
            await api.sessions.delete(id);
            purgeNavigation([id]);
            if (activeSessionIdRef.current === id) resetTranscript();
            await loadSummaries();
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi xoá phiên');
        }
    };

    const handleTogglePin = async (id: string) => {
        try {
            // `/pin` không nhận body nghĩa là "flip cờ đang lưu"; client chỉ cần cờ mới để cập nhật rail.
            const { isPinned } = await api.sessions.pin(id);
            setSummaries(prev => prev.map(s => (s.id === id ? { ...s, isPinned } : s)));
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi khi ghim phiên');
        }
    };

    // Chống trùng nằm ở CHỦ CỦA REQUEST vì chỉ nó thấy kết quả. `decidingRef` giữ approval đang có một
    // request bay ⇒ Escape auto-repeat / click đúp chỉ còn một `POST /api/approvals/:id`, và `finally`
    // nhả chốt ⇒ khi POST lỗi (network, 409, 5xx) dialog vẫn còn và approval đó bấm lại được — pin tại
    // `ChatInterface.test.tsx` ("lets the user retry a decision after the POST fails…"). Chốt đặt trong
    // modal (round 2) không làm được nửa thứ hai vì modal không thấy kết quả POST.
    const decidingRef = useRef<string | null>(null);

    const handleApproval = async (
        approvalId: string,
        decision: 'allow' | 'deny',
        scope: 'once' | 'session',
        feedback?: string,
    ) => {
        if (decidingRef.current === approvalId) return;
        decidingRef.current = approvalId;
        try {
            // Phán quyết 1: bộ ba gửi đi phải tường minh. Server chỉ ghi session-allow cho đúng
            // `{decision:'allow', scope:'session'}` (approval.ts:85-95).
            await api.approvals.decide(approvalId, { decision, scope });
            // Hợp đồng Task 18: chỉ chốt step ở local SAU KHI route trả về; lần reload kế tiếp dựng lại
            // đúng frame đó từ `session_events`, nên thứ tự này là toàn bộ tính đúng đắn của bong bóng.
            dispatch(decisionFrame(approvalId, decision));
            // A plan was approved → plan mode is off server-side (`exit_plan_mode`); reflect that
            // without waiting for a session reload.
            const pending = chat.pendingApproval;
            if (decision === 'allow' && pending?.name === 'exit_plan_mode') setPlanActive(false);
            // Rejected with feedback: the turn is still live, so this queues as an inbox steer and the
            // model revises the plan on its next step.
            if (decision === 'deny' && feedback !== undefined && feedback !== '') {
                await handleSteer(feedback);
            }
        } catch (error) {
            showToast('error', errorCopy(codeOf(error)), 'Lỗi phê duyệt');
        } finally {
            decidingRef.current = null;
        }
    };

    /** Bong bóng live: text chưa bền, có thể bị attempt khác dưới cùng `turnId` thay. */
    const draftSteps: DerivedStep[] = chat.draft.content !== ''
        ? [{ type: 'text', content: chat.draft.content }, ...chat.draft.steps]
        : chat.draft.steps;
    const hasDraft = draftSteps.length > 0 || chat.draft.reasoning !== '';
    // Todo panel lives above the composer and must update live during a turn (todo_write
    // result arrives via SSE) — deriving from the transcript keeps it attached to the prompt
    // instead of waiting for the post-turn reload (deepseek: standing plan).
    const displayTodos = useMemo(
        () => latestTodos(chat.messages) ?? todos,
        [chat.messages, todos],
    );
    const lastMessageIndex = chat.messages.length - 1;
    /** Một lượt đang mở — tính cả cửa sổ `starting` trước khi stream thực sự chạy. */
    const busy = streaming || starting;
    // "Đang chạy tool" phải đến từ trạng thái của CHÍNH cuộc gọi, không từ số dòng progress: lượt chạy
    // tool xong rồi viết câu trả lời dài sẽ dán nhãn "Đang chạy tool" suốt lúc model đang soạn — T22-8
    // bắt mỗi nhãn một sự thật, và vùng này là live region nên AT đọc theo. `chatReducer` gắn `tool/call`
    // vào HÀNG BỀN đang mở khi đã có hàng owner (`owningRowIndex`), nên phải xem cả draft lẫn hàng cuối;
    // `busy` là thứ giữ nhãn này không bật khi reload trả về một call mồ côi còn nguyên `running`.
    const openTurnSteps: DerivedStep[] = busy
        ? [...chat.draft.steps, ...(chat.messages[lastMessageIndex]?.steps ?? [])]
        : [];
    const runningToolCall = openTurnSteps.some(step => step.type === 'call' && step.call.status === 'running');
    const showWelcome = chat.messages.length === 0 && !hasDraft && !chat.error;

    // Hai chế độ ẩn sidebar khác nhau: >=760px là `sidebarCollapsed` (rail thu gọn), <760px là
    // drawer `sidebarOpen`. Một nút "bật/tắt" phải thao tác đúng cái đang điều khiển màn hình.
    const isDesktopUi = useMediaQuery(DESKTOP_QUERY);
    const sidebarVisible = isDesktopUi ? !sidebarCollapsed : sidebarOpen;
    const toggleSidebar = () => {
        if (isDesktopUi) {
            setSidebarCollapsed(sidebarVisible);
            // Titlebar là nút bật/tắt DUY NHẤT; nó không chạm key nên đường này tự ghi ở đây.
            writeSidebarCollapsed(sidebarVisible);
        } else {
            setSidebarOpen(!sidebarVisible);
        }
    };

    // Entering the narrow width closes the drawer so the chat reclaims the space; widening back
    // reopens the inline sidebar automatically unless the user collapsed it (that state is
    // persisted, so the reopen respects it). An explicitly opened drawer behind the titlebar
    // toggle is untouched while the width stays narrow.
    useEffect(() => {
        if (!isDesktopUi) setSidebarOpen(false);
    }, [isDesktopUi]);

    /** Titlebar back: move the current id onto `forward`, open the top of `back` (no re-record). */
    const goBack = () => {
        const target = navHistory.back[navHistory.back.length - 1];
        if (!target) return;
        const current = activeSessionIdRef.current;
        setNavHistory(prev => ({
            back: prev.back.slice(0, -1),
            forward: current ? [...prev.forward, current] : prev.forward,
        }));
        void openSession(target);
    };

    /** Titlebar forward: mirror of goBack. */
    const goForward = () => {
        const target = navHistory.forward[navHistory.forward.length - 1];
        if (!target) return;
        const current = activeSessionIdRef.current;
        setNavHistory(prev => ({
            forward: prev.forward.slice(0, -1),
            back: current ? [...prev.back, current] : prev.back,
        }));
        void openSession(target);
    };

    /** A client command chosen from the composer's "/" palette. Every id maps to a real action. */
    const handleRunCommand = (command: string) => {
        switch (command) {
            case 'new-chat':
                void handleNewSession();
                break;
            case 'clear':
                resetTranscript();
                break;
            case 'settings':
                openSettings('general');
                break;
            case 'help':
                openSettings('advanced');
                break;
            case 'search':
                setShowSearch(true);
                break;
            case 'sidebar':
                toggleSidebar();
                break;
            default:
                break;
        }
    };

    return (
        <>
            <AppShell
                titlebar={(
                    <Titlebar
                        canGoBack={navHistory.back.length > 0}
                        canGoForward={navHistory.forward.length > 0}
                        onBack={goBack}
                        onForward={goForward}
                        onToggleSidebar={toggleSidebar}
                        sidebarCollapsed={sidebarCollapsed}
                        onNewChat={() => { void handleNewSession(); }}
                        onNewProject={() => setShowCreateProject(true)}
                        onShowHelp={() => openSettings('advanced')}
                        onWindowCommand={(action) => { void window.morphi?.window?.command(action); }}
                    />
                )}
                rail={<Rail
                    onAction={handleRailAction}
                    projects={projects}
                    currentProjectId={currentProjectId}
                    onSelectProject={(id) => { void handleSelectProject(id); }}
                    onNewProject={() => setShowCreateProject(true)}
                    sessions={summaries}
                    currentSessionId={currentSessionId}
                    onSelectSession={handleSelectSession}
                />}
                sidebar={(
                    <Sidebar
                        projects={projects}
                        sessions={summaries}
                        currentProjectId={currentProjectId}
                        currentSessionId={currentSessionId}
                        onSelectProject={handleSelectProject}
                        onNewProject={() => setShowCreateProject(true)}
                        onSelectSession={handleSelectSession}
                        onNewSession={handleNewSession}
                        onNewSessionInProject={(id) => { void handleNewSessionInProject(id); }}
                        onDelete={handleDeleteSession}
                        onTogglePin={handleTogglePin}
                        onDeleteProject={handleDeleteProject}
                        onSearch={() => setShowSearch(true)}
                        connected={mcpConnected}
                        runningSessionIds={runningSessions}
                        focusProjectsSignal={focusProjectsSignal}
                    />
                )}
                sidebarOpen={sidebarOpen}
                sidebarCollapsed={sidebarCollapsed}
                onCloseSidebar={() => setSidebarOpen(false)}
                onSearch={() => setShowSearch(true)}
                onNewChat={() => { void handleNewSession(); }}
            >
                <div className="flex h-full min-h-0 bg-bg-main">
                    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
                    <ToastContainer toasts={toasts} onDismiss={dismissToast} />

                    <Header
                        projectName={projects.find(p => p.id === currentProjectId)?.name}
                        sessionTitle={summaries.find(s => s.id === currentSessionId)?.title || chat.title || undefined}
                        mcpConnected={mcpConnected}
                        busy={busy}
                        runningTool={runningToolCall}
                        onReconnectMcp={handleReconnectMcp}
                        onShowHelp={() => openSettings('advanced')}
                        onNewChat={() => { void handleNewSession(); }}
                        subagents={subagentTree}
                        onOpenChildSession={handleOpenChildSession}
                        onInterruptChild={(childId) => {
                            const parentId = activeSessionIdRef.current ?? currentSessionId;
                            if (!parentId) return;
                            void api.sessions.interruptSubagent(parentId, childId).then(() => {
                                if (activeSessionIdRef.current === parentId) return reloadSession(parentId);
                            });
                        }}
                    />

                    {activeGoal ? (
                        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-card px-4 py-2">
                            <Flag size={14} aria-hidden="true" className="shrink-0 text-brand-text" />
                            <p className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                                <span className="font-medium">{vi.composer.goalStrip}: </span>
                                {activeGoal}
                            </p>
                            <button
                                type="button"
                                aria-label={vi.composer.clearGoal}
                                onClick={() => { void handleClearGoal(); }}
                                className="btn-ghost shrink-0 p-1"
                            >
                                <X size={14} aria-hidden="true" />
                            </button>
                        </div>
                    ) : null}

                    {planActive ? (
                        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-card px-4 py-2">
                            <ListChecks size={14} aria-hidden="true" className="shrink-0 text-brand-text" />
                            <p className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                                {vi.composer.planStrip} — {vi.composer.planOn}
                            </p>
                            <button
                                type="button"
                                aria-label={vi.composer.clearPlan}
                                onClick={() => { void handleClearPlanMode(); }}
                                className="btn-ghost shrink-0 p-1"
                            >
                                <X size={14} aria-hidden="true" />
                            </button>
                        </div>
                    ) : null}

                    {/* Messages: the scroll viewport must own a definite height (`h-full`), otherwise
                        the transcript grows past the flex row, paints over the composer and the
                        welcome view's `h-full` resolves against `auto` (no vertical centring). */}
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                        <div className="h-full overflow-y-auto sidebar-scrollbar">
                        {showWelcome ? (
                            <WelcomeView
                                onSuggestion={(text) => { handleSend(text, selectedModel || undefined, effort || undefined, permission); }}
                                disabled={busy}
                                projectName={projects.find(p => p.id === currentProjectId)?.name}
                            />
                        ) : (
                            <ChatView
                                messages={chat.messages}
                                draft={chat.draft}
                                draftSteps={draftSteps}
                                hasDraft={hasDraft}
                                pendingApproval={chat.pendingApproval}
                                error={chat.error}
                                toolProgress={chat.toolProgress}
                                busy={busy}
                                streaming={streaming}
                                onRegenerate={(assistantMessageId) => { void handleRegenerate(assistantMessageId); }}
                                onUndoMessage={(userMessageId) => { void handleUndoMessage(userMessageId); }}
                                onUndoTurn={(callIds) => { void handleUndoTurn(callIds); }}
                                undoTurnBusyCallIds={undoTurnBusy}
                                onApprovalDecision={(approvalId, decision, scope, feedback) => {
                                    void handleApproval(approvalId, decision, scope, feedback);
                                }}
                                onOpenSettings={() => openSettings('providers')}
                                onOpenChildSession={handleOpenChildSession}
                                endRef={messagesEndRef}
                            />
                        )}
                        </div>
                        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-bg-main to-transparent" />
                        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-bg-main to-transparent" />
                    </div>

                    {/* Composer */}
                    {displayTodos.length > 0 ? (
                        <div className="mx-auto w-full max-w-[730px] shrink-0 px-4 pt-2">
                            <div className="overflow-hidden rounded-xl border border-border bg-bg-card">
                                <button
                                    type="button"
                                    aria-expanded={todosOpen}
                                    onClick={() => setTodosOpen(value => !value)}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-inset"
                                >
                                    <ListChecks size={14} aria-hidden="true" className="shrink-0 text-text-secondary" />
                                    <span className="flex-1 text-[13px] font-semibold text-text-primary">
                                        {vi.chat.planTitle} · {displayTodos.filter((todo) => todo.status === 'done').length}/{displayTodos.length}
                                    </span>
                                    <ChevronDown size={14} aria-hidden="true" className={cn('shrink-0 text-text-tertiary transition-transform', todosOpen && 'rotate-180')} />
                                </button>
                                {todosOpen ? (
                                    <ul className="space-y-0.5 border-t border-border px-3 py-2">
                                        {displayTodos.map((todo, index) => (
                                            <li key={index} className="flex items-center gap-2 text-[13px] leading-relaxed">
                                                <span
                                                    aria-hidden="true"
                                                    className={cn(
                                                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px]',
                                                        todo.status === 'done' && 'border-success-text bg-success-bg text-success-text',
                                                        todo.status === 'doing' && 'border-warning-text bg-warning-bg text-warning-text',
                                                        todo.status === 'todo' && 'border-border text-transparent',
                                                    )}
                                                >
                                                    {todo.status === 'done' ? '✓' : todo.status === 'doing' ? '~' : '·'}
                                                </span>
                                                <span className={cn(
                                                    'min-w-0 flex-1',
                                                    todo.status === 'done' ? 'text-text-tertiary line-through' : 'text-text-primary',
                                                )}>
                                                    {todo.title}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                    <div className="shrink-0 pb-4 pt-2">
                        <Composer
                            onSend={handleSend}
                            onStop={handleStop}
                            disabled={starting}
                            streaming={streaming}
                            starting={starting}
                            models={models}
                            selectedModel={selectedModel}
                            onSelectModel={(id) => {
                                setSelectedModel(id);
                            }}
                            effort={effort}
                            onSelectEffort={setEffort}
                            permission={permission}
                            onSelectPermission={setPermission}
                            onOpenSettings={() => openSettings('providers')}
                            onReloadModels={() => { void loadModels(); }}
                            usedTokens={contextWindow.usedTokens}
                            totalTokens={contextWindow.totalTokens}
                            modelName={contextWindow.modelName}
                            skills={skills}
                            onRunCommand={handleRunCommand}
                            onNotify={(message) => showToast('warning', message)}
                            externalDraft={composerDraft}
                            queuedMessages={chat.queued?.messages ?? []}
                            onClearQueued={() => { void handleClearQueued(); }}
                        />
                    </div>
                    </div>
                    {sidePanel !== null ? (
                        <SidePanel
                            title={sidePanel.title}
                            onClose={() => setSidePanel(null)}
                        >
                            {sidePanel.kind === 'history' && currentSessionId != null ? (
                                <HistoryPanel sessionId={currentSessionId} busy={streaming || starting} />
                            ) : sidePanel.kind === 'child' ? (
                                <ChildSessionPanel
                                    detail={childDetail}
                                    loading={childLoading}
                                    failed={childFailed}
                                />
                            ) : null}
                        </SidePanel>
                    ) : null}
                </div>
            </AppShell>

            <SearchPalette
                open={showSearch}
                sessions={summaries}
                projects={projects}
                onClose={() => setShowSearch(false)}
                onSelectSession={(id) => { setShowSearch(false); handleSelectSession(id); }}
                onSelectProject={(id) => { setShowSearch(false); void handleSelectProject(id); }}
            />

            <SettingsModal
                isOpen={showSettings}
                initialTab={settingsTab}
                // Saving credentials in Settings invalidates the server's model cache; the next
                // GET /api/models therefore has to be forced on close.
                onClose={() => { setShowSettings(false); void loadModels(); }}
                onMemoryCleared={() => {
                    abortAllTurns();
                    currentProjectIdRef.current = undefined;
                    setProjects([]);
                    setCurrentProjectId(undefined);
                    setSummaries([]);
                    resetTranscript();
                }}
            />
            <CreateProjectModal isOpen={showCreateProject} onClose={() => setShowCreateProject(false)} onCreate={handleCreateProject} />
            <ConfirmModal
                isOpen={!!projectToDelete}
                onClose={() => setProjectToDelete(null)}
                onConfirm={confirmDeleteProject}
                title={vi.confirm.deleteProject}
                message={vi.confirm.deleteProjectBody}
                confirmText={vi.confirm.deleteProject}
                variant="danger"
            />
        </>
    );
};
