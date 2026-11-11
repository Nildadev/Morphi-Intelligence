import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Git-like history panel (Phase 4).
 *
 * The panel's contract is "never a dead button and never a silent overwrite":
 *  - a non-restorable row shows the SERVER's reason and a disabled control;
 *  - restore is preview-then-confirm, so drift is visible before anything is written;
 *  - a drifted preview cannot be confirmed;
 *  - `restore-failed` is reported, never rounded up to success.
 *
 * The rows below are built so a hard-coded label or a boolean that ignores the payload cannot pass.
 */

const mockFns = vi.hoisted(() => ({
    checkpoints: vi.fn(),
    previewRestore: vi.fn(),
    restore: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/api')>();
    return {
        ...actual,
        api: {
            ...actual.api,
            sessions: {
                ...actual.api.sessions,
                checkpoints: mockFns.checkpoints,
                previewRestore: mockFns.previewRestore,
                restore: mockFns.restore,
            },
        },
    };
});

import { HistoryPanel } from './HistoryPanel';
import type { WorkspaceCheckpoint } from '../../types';

const row = (over: Partial<WorkspaceCheckpoint> = {}): WorkspaceCheckpoint => ({
    id: 'ckp_1',
    sessionId: 's1',
    createdAt: Date.UTC(2026, 0, 2, 3, 4),
    label: null,
    baseEventSeq: null,
    rootHash: 'root',
    status: 'recorded',
    manifest: {
        tool: 'multi_edit',
        callId: 'call_1',
        argsHash: 'h',
        targets: ['ServerScriptService.Main'],
        outcome: 'ok',
        preState: null,
        restorable: true,
        restoreReason: 'ok',
    },
    ...over,
});

beforeEach(() => {
    mockFns.checkpoints.mockReset().mockResolvedValue([row()]);
    mockFns.previewRestore.mockReset();
    mockFns.restore.mockReset();
});

afterEach(() => cleanup());

describe('HistoryPanel', () => {
    it('lists the checkpoints of the OPEN session and a failed load is reported', async () => {
        mockFns.checkpoints.mockRejectedValueOnce(new Error('offline'));
        const first = render(<HistoryPanel sessionId="s1" />);
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        first.unmount();

        mockFns.checkpoints.mockResolvedValue([row({ label: 'Sửa điểm khởi tạo' })]);
        render(<HistoryPanel sessionId="s1" />);
        expect(await screen.findByText('Sửa điểm khởi tạo')).toBeInTheDocument();
        expect(mockFns.checkpoints).toHaveBeenCalledWith('s1');
    });

    it('says so when the session has no checkpoints yet', async () => {
        mockFns.checkpoints.mockResolvedValue([]);
        render(<HistoryPanel sessionId="s1" />);
        expect(await screen.findByText(/chưa có|Chưa có/i)).toBeInTheDocument();
    });

    it('shows the server reason and disables restore for a non-restorable row', async () => {
        // A dead button that fails on click is exactly what the plan forbids.
        mockFns.checkpoints.mockResolvedValue([
            row({
                manifest: {
                    ...row().manifest,
                    restorable: false,
                    restoreReason: 'Không đọc được nguồn hiện tại của ServerScriptService.Main — không có bản sao để khôi phục.',
                },
            }),
        ]);
        render(<HistoryPanel sessionId="s1" />);

        expect(await screen.findByText(/không có bản sao để khôi phục/)).toBeInTheDocument();
        const button = screen.getByRole('button', { name: /khôi phục/i });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(mockFns.previewRestore).not.toHaveBeenCalled();
    });

    it('previews before writing, and shows the inverse plan plus drift', async () => {
        mockFns.previewRestore.mockResolvedValue({
            checkpointId: 'ckp_1',
            clean: false,
            drift: ['ServerScriptService.Main đã đổi — không khôi phục để tránh ghi đè.'],
            steps: [{ path: 'ServerScriptService.Main', action: 'restore-script', summary: 'Khôi phục nguồn cũ của ServerScriptService.Main' }],
            notes: [],
        });
        render(<HistoryPanel sessionId="s1" />);

        fireEvent.click(await screen.findByRole('button', { name: /khôi phục/i }));

        expect(await screen.findByText('Khôi phục nguồn cũ của ServerScriptService.Main')).toBeInTheDocument();
        expect(screen.getByText(/đã đổi/)).toBeInTheDocument();
        // Drift is a refusal: the confirm button exists but cannot be used, and nothing was written.
        const confirm = screen.getByRole('button', { name: /khôi phục ngay/i });
        expect(confirm).toBeDisabled();
        expect(mockFns.restore).not.toHaveBeenCalled();
    });

    it('applies a clean preview and reports the verified result', async () => {
        mockFns.previewRestore.mockResolvedValue({
            checkpointId: 'ckp_1',
            clean: true,
            drift: [],
            steps: [{ path: 'ServerScriptService.Main', action: 'restore-script', summary: 'Khôi phục nguồn cũ của ServerScriptService.Main' }],
            notes: [],
        });
        mockFns.restore.mockResolvedValue({
            checkpointId: 'ckp_1',
            status: 'restored',
            applied: 1,
            failed: [],
            skipped: [],
        });
        mockFns.checkpoints.mockResolvedValue([row()]);
        render(<HistoryPanel sessionId="s1" />);

        fireEvent.click(await screen.findByRole('button', { name: /khôi phục/i }));
        fireEvent.click(await screen.findByRole('button', { name: /khôi phục ngay/i }));

        await waitFor(() => expect(mockFns.restore).toHaveBeenCalledWith('s1', 'ckp_1'));
        expect(await screen.findByRole('status')).toBeInTheDocument();
    });

    it('reports restore-failed with the server reason instead of pretending success', async () => {
        mockFns.previewRestore.mockResolvedValue({
            checkpointId: 'ckp_1',
            clean: true,
            drift: [],
            steps: [{ path: 'ServerScriptService.Main', action: 'restore-script', summary: 'Khôi phục nguồn cũ của ServerScriptService.Main' }],
            notes: [],
        });
        mockFns.restore.mockResolvedValue({
            checkpointId: 'ckp_1',
            status: 'restore-failed',
            applied: 0,
            failed: [{ path: 'ServerScriptService.Main', reason: 'Đã ghi nhưng nội dung đọc lại không khớp bản sao.' }],
            skipped: [],
        });
        render(<HistoryPanel sessionId="s1" />);

        fireEvent.click(await screen.findByRole('button', { name: /khôi phục/i }));
        fireEvent.click(await screen.findByRole('button', { name: /khôi phục ngay/i }));

        expect(await screen.findByText(/không khớp bản sao/)).toBeInTheDocument();
    });
});
