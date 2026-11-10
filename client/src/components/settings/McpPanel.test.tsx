import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Settings › MCP. Toàn bộ dữ liệu ở đây PHẢI đến từ một `McpStatus` thật (`server/.../serviceGateway.ts`),
 * không có dòng version bịa và không có link tải plugin bên thứ ba. Test feed đúng shape của
 * `types.ts` `McpStatus` và asserts trên DOM, không trên state nội bộ.
 */

const mockFns = vi.hoisted(() => ({
    status: vi.fn(),
    reconnect: vi.fn(),
    setPath: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/api')>();
    return {
        ...actual,
        api: { ...actual.api, mcp: { status: mockFns.status, reconnect: mockFns.reconnect, setPath: mockFns.setPath } },
    };
});

import { McpPanel } from './McpPanel';
import { ApiError } from '../../lib/api';
import type { McpStatus } from '../../types';

const connectedStatus: McpStatus = {
    connected: true,
    studioLinked: true,
    server: { source: 'studio-builtin', path: 'C:\\Users\\me\\AppData\\Local\\Roblox\\rbx-studio-mcp.exe', version: null },
    studio: { id: 'dec497bc-1111-2222', name: 'Place1' },
    toolCount: 35,
    lastError: null,
    logs: ['handshake ok', 'tools/list: 14'],
};

const disconnectedStatus: McpStatus = {
    connected: false,
    studioLinked: false,
    server: { source: 'none', path: null, version: null },
    studio: null,
    toolCount: 0,
    lastError: null,
    logs: [],
};

function renderPanel(): void {
    render(<McpPanel />);
}

beforeEach(() => {
    mockFns.status.mockReset().mockResolvedValue(connectedStatus);
    mockFns.reconnect.mockReset().mockResolvedValue(connectedStatus);
    mockFns.setPath.mockReset().mockResolvedValue(connectedStatus);
});

afterEach(() => {
    cleanup();
});

describe('SettingsModal › MCP panel', () => {
    it('renders connected state from the real McpStatus fields (source, path, logs)', async () => {
        const { container } = render(<McpPanel />);

        expect(await screen.findByText('Đã kết nối')).toBeInTheDocument();
        expect(screen.getByText('Đã nối')).toBeInTheDocument();
        // `source: 'studio-builtin'` -> nhãn tiếng Việt dựng sẵn, KHÔNG một chuỗi hardcode nào.
        expect(screen.getByText('MCP dựng sẵn trong Studio')).toBeInTheDocument();
        // Đường dẫn thực thi resolve in ra đúng giá trị fixture.
        expect(screen.getByText(/rbx-studio-mcp\.exe/)).toBeInTheDocument();
        // Hai dòng log được nối bằng `'\n'` trong một `<pre>` — assert textContent vì matcher text
        // chuẩn hoá khoảng trắng, nên không so được chuỗi có dấu xuống dòng.
        const pre = container.querySelector('pre');
        expect(pre).not.toBeNull();
        expect(pre?.textContent).toBe('handshake ok\ntools/list: 14');
    });

    it('shows an explained empty version when server.version is null and never invents one', async () => {
        renderPanel();
        // version === null (resolver 1.1.0 chưa tồn tại) -> lời giải thích thật, không đoán số.
        expect(await screen.findByText('Chưa đọc được từ kết quả initialize.')).toBeInTheDocument();
        // Không một dòng version cũ nào được bịa lại: không "2.6.0", không "v2.6.0".
        expect(document.body.innerHTML).not.toMatch(/2\.6\.0/);
    });

    it('prints the version the server actually reports when it is present', async () => {
        mockFns.status.mockResolvedValue({ ...connectedStatus, server: { ...connectedStatus.server, version: '1.2.3' } });
        renderPanel();
        // Đọc TỪ payload: nếu panel hardcode, nhánh này sẽ không đổi theo fixture.
        expect(await screen.findByText('1.2.3')).toBeInTheDocument();
        expect(screen.queryByText('Chưa đọc được từ kết quả initialize.')).toBeNull();
    });

    it('saves a path override through PUT api.mcp.setPath with the trimmed value', async () => {
        renderPanel();
        const pathInput = await screen.findByLabelText('Đường dẫn MCP (tùy chọn)');
        fireEvent.change(pathInput, { target: { value: '  C:\\custom\\mcp.exe  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Lưu đường dẫn' }));

        await waitFor(() => expect(mockFns.setPath).toHaveBeenCalledTimes(1));
        expect(mockFns.setPath).toHaveBeenCalledWith('C:\\custom\\mcp.exe');
    });

    it('reconnects through api.mcp.reconnect', async () => {
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Kết nối lại' }));
        await waitFor(() => expect(mockFns.reconnect).toHaveBeenCalledTimes(1));
    });

    it('keeps the current status and explains the rejection when setPath returns MCP_PATH_REJECTED', async () => {
        mockFns.setPath.mockRejectedValue(new ApiError(400, 'MCP_PATH_REJECTED'));
        renderPanel();
        const pathInput = await screen.findByLabelText('Đường dẫn MCP (tùy chọn)');
        fireEvent.change(pathInput, { target: { value: 'C:\\not-allowed\\mcp.exe' } });
        fireEvent.click(screen.getByRole('button', { name: 'Lưu đường dẫn' }));

        // Server từ chối chuỗi ngoài allowlist và KHÔNG ghi gì -> thông báo lỗi code-driven, trạng thái cũ còn nguyên.
        expect(await screen.findByText(/Đường dẫn server MCP không hợp lệ/)).toBeInTheDocument();
        expect(screen.getByText('Đã kết nối')).toBeInTheDocument();
    });

    it('shows the Vietnamese Studio guidance only while disconnected', async () => {
        mockFns.status.mockResolvedValue(disconnectedStatus);
        renderPanel();
        // connected: false -> hướng dẫn "Assistant › Manage MCP Servers" xuất hiện.
        expect(await screen.findByText(/Mở Roblox Studio › Assistant › Manage MCP Servers/)).toBeInTheDocument();
        expect(screen.getByText('Chưa kết nối')).toBeInTheDocument();
    });

    it('does not show the guidance and points at the live bridge once connected', async () => {
        renderPanel();
        await screen.findByText('Đã kết nối');
        expect(screen.queryByText(/Manage MCP Servers/)).toBeNull();
    });

    it('offers the "clear override" control only when the override is actually active (source === settings)', async () => {
        // source 'studio-builtin': không có ghi đè nào để xoá -> nút phải ẩn (§6.6.2, không nút chết).
        renderPanel();
        await screen.findByText('Đã kết nối');
        expect(screen.queryByRole('button', { name: 'Xoá ghi đè' })).toBeNull();
        cleanup();

        mockFns.status.mockResolvedValue({ ...connectedStatus, server: { source: 'settings', path: 'C:\\x.exe', version: null } });
        renderPanel();
        expect(await screen.findByRole('button', { name: 'Xoá ghi đè' })).toBeInTheDocument();
    });

    it('retires third-party plugin references entirely from the MCP surface', async () => {
        renderPanel();
        await screen.findByText('Đã kết nối');
        const html = document.body.innerHTML;
        expect(html).not.toMatch(/boshyxd/i);
        expect(html).not.toMatch(/\.rbxmx/i);
        expect(html).not.toMatch(/github\.com/i);
    });
});

describe('SettingsModal › MCP panel — live Studio identity (Task 31C)', () => {
    it('names the resolved Studio and its id, read from the payload', async () => {
        renderPanel();

        // Tên place và id đến từ `list_roblox_studios`, in nguyên giá trị payload trả về.
        expect(await screen.findByText('Place1')).toBeInTheDocument();
        expect(screen.getByText(/dec497bc/)).toBeInTheDocument();
    });

    it('says the place has no name when the server reports name: null, and prints the id once', async () => {
        mockFns.status.mockResolvedValue({
            ...connectedStatus,
            studio: { id: '573d26fa-7dbb', name: null },
        });
        renderPanel();

        expect(await screen.findByText('Place chưa có tên')).toBeInTheDocument();
        expect(screen.getAllByText(/573d26fa/)).toHaveLength(1);
    });

    it('prints the tool count after the studio.* namespace pass', async () => {
        renderPanel();

        expect(await screen.findByText('35')).toBeInTheDocument();
    });

    it('says the place is missing when the server is up but Studio is closed', async () => {
        mockFns.status.mockResolvedValue({ ...connectedStatus, studioLinked: false, studio: null });
        renderPanel();

        expect(await screen.findByText('Chưa kết nối')).toBeInTheDocument();
        expect(screen.getByText('Studio chưa mở place nào')).toBeInTheDocument();
        // Không bịa một place khi server chưa resolve được.
        expect(screen.queryByText('Place1')).toBeNull();
        // Có lối thoát thật: hướng dẫn bật MCP hiện lại khi Studio chưa link.
        expect(screen.getByText(/Manage MCP Servers/)).toBeInTheDocument();
    });

    it('turns the last error code into the Vietnamese fix, not the raw code', async () => {
        mockFns.status.mockResolvedValue({
            ...connectedStatus,
            studioLinked: false,
            studio: null,
            lastError: { code: 'STUDIO_RESTART_REQUIRED', message: 'Client proxy is out of date, restart to update' },
        });
        renderPanel();

        expect(await screen.findByText(/Khởi động lại Roblox Studio/)).toBeInTheDocument();
        // Mã trần không được lọt ra UI.
        expect(document.body.innerHTML).not.toContain('STUDIO_RESTART_REQUIRED');
    });

    it('renders nothing for the error row when the last call succeeded', async () => {
        renderPanel();

        await screen.findByText('Đã kết nối');
        expect(screen.queryByText(/Lỗi gần nhất/)).toBeNull();
    });
});
