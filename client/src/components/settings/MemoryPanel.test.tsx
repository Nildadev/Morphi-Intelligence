import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Settings › Bộ nhớ. Bốn con số in ra là bốn con số `api.memory.stats` TRẢ VỀ, không phải hằng số.
 * Test feed những giá trị đặc trưng (71/230/4096) để một bản hardcode không thể tình cờ khớp.
 */

const mockFns = vi.hoisted(() => ({ stats: vi.fn(), clear: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/api')>();
    return { ...actual, api: { ...actual.api, memory: { stats: mockFns.stats, clear: mockFns.clear } } };
});

import { MemoryPanel } from './MemoryPanel';

const baseStats = { projects: 71, sessions: 230, events: 4096, approxBytes: 5_242_880 };

beforeEach(() => {
    mockFns.stats.mockReset().mockResolvedValue({ ...baseStats });
    mockFns.clear.mockReset().mockResolvedValue({ ok: true, cleared: { projects: 0, sessions: 0, events: 0 } });
});

afterEach(() => {
    cleanup();
});

describe('SettingsModal › Memory panel', () => {
    it('prints the counts and file size straight from the stats payload (no hard-coded numbers)', async () => {
        render(<MemoryPanel />);

        expect(await screen.findByText('71')).toBeInTheDocument();
        expect(screen.getByText('230')).toBeInTheDocument();
        expect(screen.getByText('4096')).toBeInTheDocument();
        // 5 242 880 byte = 5.0 MB do `formatSize` tính; nhãn `Dung lượng tệp` đứng cạnh nó.
        expect(screen.getByText('5.0 MB')).toBeInTheDocument();
        expect(screen.getByText('Dung lượng tệp')).toBeInTheDocument();
    });

    it('recomputes every number when a different payload arrives', async () => {
        mockFns.stats.mockResolvedValue({ projects: 3, sessions: 12, events: 144, approxBytes: 2048 });
        render(<MemoryPanel />);
        expect(await screen.findByText('3')).toBeInTheDocument();
        expect(screen.getByText('12')).toBeInTheDocument();
        expect(screen.getByText('144')).toBeInTheDocument();
        // 2048 byte -> 2.0 KB (đơn vị đổi theo độ lớn thật, không cố định MB).
        expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    });

    it('names the exact legacy backup file when legacyBackup is present', async () => {
        mockFns.stats.mockResolvedValue({ ...baseStats, legacyBackup: 'memory-pre-1.1.bak' });
        render(<MemoryPanel />);
        // Nhãn "Tồn tại bản sao lưu:" có dấu hai-nhân + `<code>` tên file nên text bị tách — match theo regex.
        expect(await screen.findByText(/Tồn tại bản sao lưu/)).toBeInTheDocument();
        // Cảnh báo gọi ĐÚNG tên file của payload, không phải một cái tên bịa.
        expect(screen.getByText('memory-pre-1.1.bak')).toBeInTheDocument();
    });

    it('points the warning at a different file when the payload names a different file', async () => {
        mockFns.stats.mockResolvedValue({ ...baseStats, legacyBackup: 'another-backup-42.bak' });
        render(<MemoryPanel />);
        expect(await screen.findByText('another-backup-42.bak')).toBeInTheDocument();
        expect(screen.queryByText('memory-pre-1.1.bak')).toBeNull();
    });

    it('shows no backup warning when legacyBackup is absent', async () => {
        render(<MemoryPanel />);
        await screen.findByText('71');
        expect(screen.queryByText(/Tồn tại bản sao lưu/)).toBeNull();
    });

    it('routes "clear data" through ConfirmModal and does nothing on cancel', async () => {
        const onCleared = vi.fn();
        render(<MemoryPanel onCleared={onCleared} />);
        await screen.findByText('71');

        // Panel mở ConfirmModal, không xoá ngay: bấm nút trigger chỉ dựng hộp xác nhận.
        fireEvent.click(screen.getByRole('button', { name: 'Xoá dữ liệu' }));
        expect(await screen.findByText('Toàn bộ dự án, cuộc trò chuyện và sự kiện sẽ bị xoá. Không thể hoàn tác.')).toBeInTheDocument();
        expect(mockFns.clear).not.toHaveBeenCalled();

        // "Huỷ" (nút cancel của ConfirmModal, nhãn duy nhất) đóng hộp và KHÔNG xoá gì.
        fireEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
        await waitFor(() => expect(screen.queryByText('Toàn bộ dự án, cuộc trò chuyện và sự kiện sẽ bị xoá. Không thể hoàn tác.')).toBeNull());
        expect(mockFns.clear).not.toHaveBeenCalled();
        expect(onCleared).not.toHaveBeenCalled();
    });

    it('clears through the API only after the confirm step', async () => {
        const onCleared = vi.fn();
        render(<MemoryPanel onCleared={onCleared} />);
        await screen.findByText('71');

        fireEvent.click(screen.getByRole('button', { name: 'Xoá dữ liệu' }));
        await screen.findByText('Toàn bộ dự án, cuộc trò chuyện và sự kiện sẽ bị xoá. Không thể hoàn tác.');

        // Sau khi hộp mở có HAI nút "Xoá dữ liệu" (trigger + xác nhận); xác nhận là cái thứ hai.
        const confirmButtons = screen.getAllByRole('button', { name: 'Xoá dữ liệu' });
        fireEvent.click(confirmButtons[confirmButtons.length - 1]);

        await waitFor(() => expect(mockFns.clear).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getByText('Đã xoá bộ nhớ.')).toBeInTheDocument());
        expect(onCleared).toHaveBeenCalledTimes(1);
    });
});
