/**
 * Chuỗi UI tập trung tại đây (spec §6.7). Component mới đọc từ `vi`, không hardcode tiếng Anh.
 * Danh từ kỹ thuật (model, provider, MCP, API key, token, tool) giữ nguyên vì là tên riêng.
 *
 * `errors` là nguồn copy cho 5 code mà Task 19 bỏ tiếng Anh (Ruling P20-5); `errorCopy.ts` gộp nó vào
 * bảng `ERROR_COPY`. Các key khác (`nav`, `welcome`, `composer`, ...) phục vụ AppShell/Rail và Task 21-24.
 */
import { en } from './en';

export const vi = {
    nav: {
        ariaLabel: 'Điều hướng chính',
        chat: 'Trò chuyện',
        projects: 'Dự án',
        memory: 'Bộ nhớ',
        // Git-like history (Phase 4): the Studio checkpoint browser in the "Thêm" menu.
        history: 'Lịch sử thay đổi',
        studio: 'Studio',
        settings: 'Cài đặt',
        newChat: 'Cuộc trò chuyện mới',
        search: 'Tìm kiếm',
        close: 'Đóng',
        back: 'Quay lại',
        forward: 'Tới',
    },

    menu: {
        file: 'Tệp',
        edit: 'Chỉnh sửa',
        view: 'Xem',
        help: 'Trợ giúp',
        closeWindow: 'Đóng cửa sổ',
        quit: 'Thoát',
        undo: 'Hoàn tác',
        redo: 'Làm lại',
        cut: 'Cắt',
        copy: 'Sao chép',
        paste: 'Dán',
        selectAll: 'Chọn tất cả',
        reload: 'Tải lại',
        zoomIn: 'Phóng to',
        zoomOut: 'Thu nhỏ',
        zoomReset: 'Thu phóng mặc định',
        devtools: 'Công cụ phát triển',
        fullscreen: 'Toàn màn hình',
        helpGuide: 'Trợ giúp / Hướng dẫn',
        about: 'Về Morphi Intelligence',
    },

    sidebar: {
        more: 'Thêm',
        notifications: 'Thông báo',
        connection: 'Kết nối',
        newProject: 'Dự án mới',
        pin: 'Ghim',
        unpin: 'Bỏ ghim',
        delete: 'Xoá',
        deleteProject: 'Xoá dự án',
        untitled: 'Chưa đặt tên',
        noProjects: 'Chưa có dự án',
        noSessions: 'Chưa có cuộc trò chuyện',
        recents: 'Gần đây',
        running: 'Đang chạy',
        version: 'v1.1.0',
        projectMenu: 'Menu dự án',
        newChatInProject: 'Cuộc trò chuyện mới trong dự án này',
        collapseProject: 'Thu gọn dự án',
        expandProject: 'Mở rộng dự án',
        groups: {
            pinned: 'Đã ghim',
            today: 'Hôm nay',
            yesterday: 'Hôm qua',
            last7: '7 ngày qua',
            older: 'Cũ hơn',
        },
    },

    search: {
        ariaLabel: 'Tìm kiếm cuộc trò chuyện và dự án',
        placeholder: 'Tìm kiếm cuộc trò chuyện hoặc dự án…',
        results: 'Gần đây',
        all: 'Tất cả',
        chats: 'Cuộc trò chuyện',
        projects: 'Dự án',
        empty: 'Không tìm thấy kết quả',
        close: 'Đóng',
        shortcut: 'Ctrl K',
    },

    welcome: {
        greeting: 'Hôm nay bạn muốn xây gì?',
        subtitle: 'Morphi chạy agent, tool và bộ nhớ ngay trong dự án của bạn.',
        projectHint: 'Bắt đầu một việc gì đó trong {project}.',
        placeholder: 'Hỏi Morphi bất cứ điều gì…',
        hintEnter: 'Enter để gửi, Shift+Enter để xuống dòng.',
        firstMessage: 'Tin nhắn đầu tiên',
        suggestions: ['Tạo hệ thống combat', 'Thiết kế DataStore', 'Debug placement', 'Tạo cutscene'],
    },

    header: {
        ariaLabel: 'Đầu trang',
        toggleSidebar: 'Bật/tắt thanh bên',
        thinking: 'Đang nghĩ',
        tool: 'Đang chạy tool',
        mcp: 'Roblox Studio MCP',
        themeToDark: 'Chuyển sang giao diện tối',
        themeToLight: 'Chuyển sang giao diện sáng',
        toolsOpen: 'Mở danh sách tool',
        help: 'Trợ giúp và hướng dẫn',
        agentTeam: 'Nhóm tác nhân',
        subagentsCount: '{count} subagent',
        members: 'Thành viên',
        currentChat: 'Cuộc trò chuyện hiện tại',
        active: 'Đang chạy',
        inactive: 'Không hoạt động',
        noSharedTasks: 'Chưa có tác vụ chung. Tạo qua cuộc trò chuyện.',
    },

    composer: {
        send: 'Gửi',
        stop: 'Dừng tạo',
        steer: 'Gửi chèn',
        queued: 'Đã xếp hàng',
        queuedTitle: 'Tin nhắn trong hàng đợi ({count})',
        queuedHint: 'Định tuyến ở bước tiếp theo · tự tắt sau khi gửi',
        clearQueued: 'Huỷ hàng đợi',
        clearedQueued: 'Đã huỷ hàng đợi',
        attach: 'Đính kèm',
        voice: 'Nhập bằng giọng nói',
        modelAuto: 'Tự động',
        thinking: 'Đang suy nghĩ…',
        generating: 'Đang tạo…',
        modelMenu: 'Chọn mô hình',
        noProviderTitle: 'Chưa cấu hình nhà cung cấp nào',
        noProviderHint: 'Thêm khoá API để bắt đầu.',
        openSettings: 'Mở Cài đặt',
        autoGrowAria: 'Khung nhắn tin',
        // Task 31C: thay công tắc bật/tắt bằng mức effort theo model (chỉ hiện khi model khai).
        effortTitle: 'Mức suy nghĩ',
        effortOff: 'Không suy nghĩ',
        effortLow: 'Thấp',
        effortMedium: 'Vừa',
        effortHigh: 'Cao',
        effortMinimal: 'Tối thiểu',
        effortXHigh: 'Rất cao',
        effortMax: 'Tối đa',
        effortUnavailable: 'Model này không có mức suy nghĩ',
        refreshModels: 'Tải lại danh sách mô hình',
        modelSearch: 'Tìm model',
        modelSearchClear: 'Xoá tìm kiếm',
        modelNoResults: 'Không tìm thấy model phù hợp',
        imageUnsupported: 'Model này không nhận ảnh. Chọn model hỗ trợ ảnh hoặc không đính kèm ảnh.',
        modelsError: 'Không tải được danh sách mô hình',
        // Quyền thực thi tool (Task 31D): ba chế độ gửi kèm mỗi lượt qua `permissionMode`.
        permissionTitle: 'Quyền thực thi',
        permissionAsk: 'Hỏi trước',
        permissionBalanced: 'Duyệt giúp tôi',
        permissionFull: 'Toàn quyền',
        permissionAskHint: 'Morphi hỏi trước khi sửa place hoặc chạy lệnh rủi ro.',
        permissionBalancedHint: 'Chỉ hỏi những hành động rủi ro trung bình trở lên.',
        permissionFullHint: 'Không hỏi trước ở bất kỳ tool nào — chỉ bỏ cửa sổ duyệt, không mở thêm khả năng.',
        // Dialog xác nhận toàn quyền theo layout Codex: icon cảnh báo + danh sách 3 phạm vi +
        // dòng rủi ro + Huỷ/Xác nhận. Nhãn nút và hàng "Tìm hiểu thêm" có consumer dưới đây.
        // `full` chỉ bỏ qua approval (approval.ts:59), không thêm capability: phải nói đúng
        // những tool thật (read_file chỉ đọc trong workspace; không có terminal/cài phần mềm).
        confirmFullTitle: 'Bật toàn quyền?',
        confirmFullBody: 'AI sẽ chạy tool mà không xin duyệt trước. Toàn quyền không mở thêm khả năng mới — vẫn chỉ những tool Morphi thật sự có. Điều này có thể gồm nhưng không giới hạn ở:',
        confirmFullFiles: 'Place Roblox Studio',
        confirmFullFilesHint: 'Sửa script, chèn instance/asset, chạy Luau và Playtest trong place đang mở — thay đổi thật vào place, không cần duyệt',
        confirmFullTerminal: 'Tệp workspace (chỉ đọc)',
        confirmFullTerminalHint: 'Đọc tệp trong thư mục làm việc của Morphi. Không có tool ghi/xoá tệp — AI không sửa được tệp ngoài Studio',
        confirmFullInternet: 'Internet',
        confirmFullInternetHint: 'Tìm kiếm web và tải URL (`web_fetch`, `http_get`), ảnh gửi lên Roblox. Không có terminal, cài phần mềm hay plugin',
        confirmFullRisk: 'Điều này có rủi ro như lộ hoặc bị lợi dụng dữ liệu nhạy cảm và prompt injection. Bạn có thể tắt bất cứ lúc nào.',
        confirmFullLearnMore: 'Tìm hiểu thêm',
        confirmFullCancel: 'Huỷ',
        confirmFullConfirm: 'Xác nhận',
        effortClear: 'Tắt suy nghĩ',
        removeAttachment: 'Bỏ đính kèm',
        previewAttachment: 'Xem ảnh',
        previewClose: 'Đóng xem trước',
        attachmentsTitle: 'Tệp đã đính kèm',
        // Trình gợi ý lệnh/skill khi gõ "/" (Task 31E): popover hiện trên composer, lọc theo từ khoá.
        slash: {
            ariaLabel: 'Gợi ý lệnh và kỹ năng',
            skillsHeader: 'Kỹ năng',
            commandsHeader: 'Lệnh',
            newChat: 'Cuộc trò chuyện mới',
            clear: 'Xoá nội dung cuộc trò chuyện hiện tại',
            settings: 'Mở Cài đặt',
            help: 'Mở trợ giúp / hướng dẫn',
            search: 'Mở tìm kiếm phiên và dự án',
            sidebar: 'Ẩn / hiện thanh bên',
            goal: 'Đặt mục tiêu cho cuộc trò chuyện này',
            subagent: 'Chạy một subagent làm việc riêng (phiên con)',
            workflow: 'Chạy vòng lặp workflow cho việc này',
            plan: 'Bật/tắt chế độ lập kế hoạch: agent sẽ khám phá và trình kế hoạch để duyệt trước khi thực hiện',
        },
        goalStrip: 'Mục tiêu',
        clearGoal: 'Bỏ mục tiêu',
        goalSet: 'Mục tiêu đã đặt',
        goalCleared: 'Đã xoá mục tiêu',
        goalUsage: 'Cách dùng: /goal <mục tiêu cần đạt được>',
        subagentRunning: 'Subagent đang chạy…',
        subagentDone: 'Subagent xong',
        subagentFailed: 'Subagent gặp lỗi',
        subagentStarted: 'Đã khởi chạy subagent',
        subagentUsage: 'Cách dùng: /subagent <việc cần giao>',
        workflowUsage: 'Cách dùng: /workflow <việc cần làm>',
        planStrip: 'Chế độ kế hoạch',
        clearPlan: 'Tắt chế độ kế hoạch',
        planOn: 'Đã bật chế độ kế hoạch',
        planOff: 'Đã tắt chế độ kế hoạch',
        planUsage: 'Cách dùng: /plan (bật), /plan off (tắt), /plan <việc cần lập kế hoạch>',
    },

    statuses: {
        idle: 'Sẵn sàng',
        running: 'Agent đang chạy',
        waitingApproval: 'Đang chờ phê duyệt',
        cancelled: 'Đã dừng',
        error: 'Gặp lỗi',
        connected: 'Đã kết nối',
        connecting: 'Đang kết nối',
        disconnected: 'Chưa kết nối',
        queued: 'Tin nhắn đã xếp hàng — lượt trước đang chạy.',
        stopped: 'Đã dừng lượt trả lời.',
        noSignal: 'Luồng kết thúc mà không có tín hiệu hoàn tất.',
    },

    // Task 23 — transcript surfaces. Technical nouns (tool, token, provider) stay as-is.
    chat: {
        thinking: 'Đã suy nghĩ',
        thinkingSeconds: '{seconds} giây',
        workedFor: 'Đã làm trong',
        working: 'Đang làm việc…',
        // Tổng kết thay đổi của một lượt (kiểu ZCode "N files changed +A −D"). Đây là SCRIPT
        // trong Studio (đường dẫn instance như `ServerScriptService/Combat`), không phải tệp trên
        // đĩa. Tiếng Việt không biến đổi hình thái theo số nên một mẫu dùng cho mọi N;
        // `scriptsChangedOne` chỉ để câu đọc tự nhiên ở N=1.
        scriptsChangedOne: '1 script đã thay đổi',
        scriptsChangedMany: '{count} script đã thay đổi',
        scriptsChangedLabel: 'Các script đã thay đổi trong lượt này',
        diffEmpty: 'Không có nội dung để diff.',
        linesAdded: 'dòng thêm',
        linesRemoved: 'dòng bớt',
        thinkingActive: 'Đang suy nghĩ…',
        completedIn: 'Hoàn tất trong',
        // M6: nhãn cho khoảng trống giữa "đã gửi" và "chunk đầu tiên". Không nói "đang suy nghĩ" vì
        // client không có bằng chứng model đang reasoning — chỉ biết là chưa có gì về.
        waitingResponse: 'Đang chờ phản hồi…',
        copy: 'Sao chép',
        copied: 'Đã sao chép',
        // I2: nhãn truy cập phải là tiếng Việt và CHỨA nhãn nhìn thấy (WCAG 2.5.3 "label in name").
        // Bản cũ `aria-label="Copy code"` cạnh chữ "Sao chép" khiến trình đọc màn hình thông báo một
        // cái tên không có ký tự nào trong nhãn trên nút.
        copyCode: 'Sao chép code',
        // 2.5.3: tên truy cập phải CHỨA nhãn nhìn thấy ở cả hai trạng thái. Nhãn lật thành
        // 'Đã sao chép' khi copy xong, nên 'Sao chép code' sẽ không còn là super-string của nó.
        copiedCode: 'Đã sao chép code',
        copyResponse: 'Sao chép câu trả lời',
        regenerateResponse: 'Tạo lại câu trả lời',
        subagentRunning: 'Subagent đang chạy',
        subagentDone: 'Subagent xong',
        subagentFailed: 'Subagent thất bại',
        subagentCancelled: 'Subagent đã dừng',
        jobDone: 'Tác vụ nền đã xong',
        jobStopped: 'Tác vụ nền đã dừng',
        jobFailed: 'Tác vụ nền thất bại',
        subagentStarted: 'Đã khởi chạy subagent',
        subagentTitle: 'Subagent',
        sidePanelClose: 'Đóng bảng phiên con',
        sidePanelLoading: 'Đang tải phiên con…',
        sidePanelLoadError: 'Không tải được phiên con.',
        sidePanelEmpty: 'Phiên con chưa có nội dung.',
        promptRailLabel: 'Danh sách câu hỏi trong cuộc trò chuyện',
        promptRailJumpTo: 'Tới câu hỏi {index}',
        args: 'Tham số',
        result: 'Kết quả',
        truncated: 'Kết quả đã bị cắt bớt ở 50.000 ký tự.',
        toolFallback: 'Dùng tool',
        statusRunning: 'Đang chạy',
        statusDone: 'Hoàn tất',
        statusError: 'Lỗi',
        statusCancelled: 'Đã huỷ',
        planTitle: 'Kế hoạch',
        todo: 'Chưa làm',
        doing: 'Đang làm',
        done: 'Xong',
        warning: 'Cảnh báo',
        retry: 'Thử lại',
        openSettings: 'Mở Cài đặt',
        // M4: `approvalTitle` bị xoá vì ApprovalModal dùng `vi.approval.title` (grep: 0 chỗ đọc khoá
        // này) — hai bản sao của một nhãn là cách nhãn lệch nhau mà không ai biết.
        approvalCardTitle: 'Yêu cầu phê duyệt',
        approvalWarning: 'Tool này có thể thay đổi dự án của bạn. Hãy kiểm tra tham số trước khi cho phép.',
        approvalPending: 'Đang chờ',
        approvalAllowed: 'Đã cho phép',
        approvalDenied: 'Đã từ chối',
        approvalExpired: 'Đã hết hạn',
        toolLabels: {
            run_command: 'Chạy lệnh',
            read_file: 'Đọc tệp',
            write_file: 'Ghi tệp',
            search_web: 'Tìm trên web',
            web_fetch: 'Truy cập trang web',
            web_search: 'Tìm kiếm web',
            get_project_structure: 'Phân tích cấu trúc dự án',
            get_file_tree: 'Duyệt cây tệp',
            start_playtest: 'Bắt đầu playtest',
            get_playtest_output: 'Đọc kết quả playtest',
            lint_luau: 'Kiểm tra Luau',
            get_services: 'Xem các service',
            get_selection: 'Xem vùng chọn',
            get_instance_children: 'Xem các instance con',
            get_instance_properties: 'Đọc thuộc tính',
            set_property: 'Cập nhật thuộc tính',
            mass_set_property: 'Cập nhật hàng loạt thuộc tính',
            set_script_source: 'Cập nhật mã script',
            edit_script_lines: 'Sửa nội dung script',
            insert_script_lines: 'Chèn mã script',
            execute_luau: 'Chạy mã Luau',
            create_object: 'Tạo object',
            delete_object: 'Xoá object',
            search_objects: 'Tìm object',
            todo_write: 'Cập nhật kế hoạch',
        },
    },

    settings: {
        title: 'Cài đặt',
        general: 'Chung',
        providers: 'Nhà cung cấp',
        mcp: 'MCP',
        memory: 'Bộ nhớ',
        advanced: 'Nâng cao',
        theme: 'Giao diện',
        themeLight: 'Sáng',
        themeDark: 'Tối',
        save: 'Lưu',
        configured: 'Đã cấu hình',
        notConfigured: 'Chưa cấu hình',
        reconnect: 'Kết nối lại',
        keylessProvider: 'Không cần API key — đăng nhập bằng session DeepSeek trên máy bạn (cầu nối 127.0.0.1:8000).',
        // Cầu nối DeepSeek (`https://github.com/sums001/Deepseek-API`) không có endpoint đăng nhập:
        // sign-in là `python -m deepseek.auth` mở browser, hoặc là server tự mở cửa sổ đó ở request
        // đầu tiên khi `SERVER_INTERACTIVE_LOGIN=1`. Nút này chỉ kích hoạt đường ấy — không có, và
        // cũng không thể có, một nút "lưu key" cho provider này.
        connectAccount: 'Kết nối tài khoản',
        bridgeChecking: 'Đang kiểm tra cầu nối…',
        bridgeReachable: 'Cầu nối đang chạy.',
        bridgeUnreachable: 'Cầu nối chưa chạy.',

        // Task 24 — phần còn lại của surface Settings. Chuỗi tập trung ở đây theo spec §6.7.
        // m3: mười ba key chết (`themeSystem`, `language`, `cancel`, `reset`, `saved`, `apiKey`,
        // `baseUrl`, `panelAria`, `sectionLabel`, `providersSection`, `memorySection`,
        // `advancedSection`, `retryableNote`) đã bị xoá cùng lúc modal cũ bị gỡ ở Step 1 — từ điển không
        // được tiếp tục tuyên bố một lựa chọn "Ngôn ngữ" hay một hành động "Đặt lại" mà UI không có (review
        // đếm 11; `cancel` và `retryableNote` cũng chết, nên 13). Luật "mọi key phải có consumer thật" do
        // `src/i18n/vi.settings.test.ts` canh, soi gương mẫu P20-1.
        tabsAria: 'Mục cài đặt',
        close: 'Đóng cài đặt',
        error: 'Lỗi',

        themeSection: 'Giao diện',
        // `useTheme` lưu light/dark chớ không lưu "hệ thống": lần chạy đầu MỚI đọc OS, sau đó giá trị
        // đã ghi thắng. Nói "hệ thống" như một nút bấm sẽ là một control không có hành vi thật.
        themeSystemNote: 'Lần chạy đầu theo giao diện của hệ điều hành; từ lần sau app nhớ lựa chọn của bạn.',
        languageSection: 'Ngôn ngữ',
        uiLanguage: 'Ngôn ngữ giao diện',
        aiLanguage: 'Ngôn ngữ AI trả lời',
        aiLanguageHint: 'AI ưu tiên trả lời bằng ngôn ngữ này kể cả khi tin nhắn bằng ngôn ngữ khác.',
        langAuto: 'Tự động (theo tin nhắn)',
        langVi: 'Tiếng Việt',
        langEn: 'English',
        motionSection: 'Chuyển động',
        motionNote: 'Hiệu ứng tự tắt khi hệ điều hành bật prefers-reduced-motion.',
        shortcutsSection: 'Phím tắt',
        shortcutSearch: 'Tìm kiếm',
        shortcutNewChat: 'Cuộc trò chuyện mới',
        shortcutEscape: 'Đóng hộp hội thoại',
        shortcutSend: 'Gửi tin nhắn',
        shortcutNewline: 'Xuống dòng',

        electronRequired: 'Cần chạy trong app Electron để lưu API key. Khi dev, đặt key của provider trong .env (GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, CEREBRAS_API_KEY, TOGETHER_API_KEY).',
        ephemeralKeys: 'Hệ thống không mở được safeStorage, nên key chỉ sống tới khi đóng app.',
        keyStoredNotActive: 'Key đã nằm trong két sắt nhưng harness chưa nhận. Khởi động lại server nếu tình trạng này kéo dài.',
        keyPlaceholder: '••••••••',
        newKeyPlaceholder: 'Dán API key mới',
        apiKeyFor: 'API key cho',
        saveKey: 'Lưu key',
        deleteKey: 'Xoá key',
        baseUrlFor: 'Base URL cho',
        // m5: hai ô base URL (`ProviderCard.tsx`) từng hardcode `https://gateway.example/v1` ngay trong
        // component, đúng kiểu mà comment của `mcpPathPlaceholder` bên dưới cấm (§6.7). Chuỗi hiển thị
        // phải đi qua từ điển kể cả khi nó là một ví dụ kỹ thuật không dịch.
        baseUrlPlaceholder: 'https://gateway.example/v1',
        saveBaseUrl: 'Lưu base URL',
        customBadge: 'Connector',
        nativeBadge: 'Tích hợp sẵn',
        providerEnabled: 'Đang bật',
        providerDisabled: 'Đang tắt',
        addConnector: 'Thêm connector',
        connectorSlug: 'Tên viết tắt (slug)',
        connectorSlugPlaceholder: 'vd: mygateway',
        connectorHint: 'Connector tự hợp lưu chỉ khi có Base URL; key vẫn đi qua IPC, không qua HTTP.',
        connectorExists: 'Connector này đã tồn tại.',
        savedMessage: 'Đã lưu.',
        failedMessage: 'Không lưu được.',

        mcpSection: 'Roblox Studio MCP',
        sourceSettings: 'Ghi đè trong cài đặt',
        sourceBuiltin: 'MCP dựng sẵn trong Studio',
        sourceBinary: 'MCP nhị phân của Studio',
        sourceNone: 'Chưa phát hiện',
        mcpConnected: 'Trạng thái bridge',
        mcpStudio: 'Bản ghi Studio',
        mcpStudioLinked: 'Đã nối',
        mcpStudioUnlinked: 'Chưa nối',
        // Task 31C Step 1: tên place + id do `list_roblox_studios` trả về, không phải chuỗi đoán.
        mcpStudioName: 'Place đang mở',
        mcpStudioNone: 'Studio chưa mở place nào',
        // Server trả `name: null` cho place chưa đặt tên; đó là sự thật, không phải lỗi.
        mcpStudioUnnamed: 'Place chưa có tên',
        mcpToolCount: 'Số tool Studio',
        mcpLastError: 'Lỗi gần nhất',
        mcpSource: 'Nguồn server',
        mcpPathLabel: 'Đường dẫn thực thi',
        mcpPathUnknown: 'Chưa phát hiện đường dẫn thực thi.',
        mcpVersion: 'Phiên bản server',
        mcpVersionUnknown: 'Chưa đọc được từ kết quả initialize.',
        mcpOverride: 'Đường dẫn MCP (tùy chọn)',
        mcpOverrideHint: 'Để trống thì Morphi tự phát hiện. Server chỉ nhận đường dẫn nằm trong allowlist và từ chối chuỗi lạ.',
        // Ví dụ đường dẫn là danh từ kỹ thuật, không phải câu cần dịch — nó vẫn nằm trong từ điển vì
        // §6.7 cấm chuỗi hiển thị hardcoded trong component.
        mcpPathPlaceholder: 'C:\\Users\\<tên bạn>\\AppData\\Local\\Roblox\\rbx-studio-mcp.exe',
        savePath: 'Lưu đường dẫn',
        clearOverride: 'Xoá ghi đè',
        logs: 'Nhật ký gần nhất',
        logsEmpty: 'Chưa có dòng log nào.',
        guideTitle: 'Bật MCP trong Roblox Studio',
        // Roblox Studio có MCP server dựng sẵn. Không tải plugin bên thứ ba, không số phiên bản bịa.
        guideBody: 'Mở Roblox Studio › Assistant › Manage MCP Servers rồi bật server dựng sẵn của Studio. Morphi kết nối thẳng tới server đó.',

        memoryProjects: 'Dự án',
        memorySessions: 'Cuộc trò chuyện',
        memoryEvents: 'Sự kiện',
        memorySize: 'Dung lượng tệp',
        memoryBackupFound: 'Tồn tại bản sao lưu',
        memoryBackupHint: 'Định dạng cũ đã được đổi tên khi mở cơ sở dữ liệu; dữ liệu cũ vẫn còn trong tệp đó.',
        memoryLoading: 'Đang đọc thống kê…',
        providersLoading: 'Đang đọc danh sách nhà cung cấp…',
        mcpLoading: 'Đang đọc trạng thái MCP…',
        memoryReload: 'Tải lại thống kê',
        memoryClear: 'Xoá dữ liệu',
        memoryClearBody: 'Toàn bộ dự án, cuộc trò chuyện và sự kiện sẽ bị xoá. Không thể hoàn tác.',
        memoryCleared: 'Đã xoá bộ nhớ.',

        advancedReadOnly: 'Chỉ đọc',
        advancedNote: 'Từ 1.1.0 các giá trị này không sửa trong UI: khai báo trong settings.json hoặc biến môi trường rồi khởi động lại server.',
        advancedTitleModel: 'Model đặt tiêu đề',
        advancedAutoPriority: 'Thứ tự ưu tiên khi tự chọn model',
        advancedCompaction: 'Ngưỡng nén ngữ cảnh',
        advancedWhere: 'Khai báo tại',
    },

    onboarding: {
        title: 'Bắt đầu với Morphi',
        close: 'Đóng hướng dẫn',
        prev: 'Trước',
        next: 'Tiếp',
        done: 'Bắt đầu',
        skip: 'Bỏ qua',
        step: 'Bước',
        stepsAria: 'Số bước của hướng dẫn',
        slides: [
            {
                title: 'Trò chuyện với agent',
                body: 'Mô tả việc cần làm bằng tiếng Việt. Morphi tự chọn model, chia bước và gọi tool.',
            },
            {
                title: 'Tool của Roblox Studio',
                body: 'Agent đọc cây tệp, sửa script, chạy Luau và kiểm tra dự án ngay trong Studio đang mở.',
            },
            {
                title: 'Kết nối Roblox Studio MCP',
                body: 'Trong Roblox Studio, mở Assistant › Manage MCP Servers và bật server dựng sẵn. Morphi kết nối thẳng tới server đó, không cần tải plugin bên thứ ba.',
            },
            {
                title: 'Key và nhà cung cấp',
                body: 'Mở Cài đặt › Nhà cung cấp để thêm API key. Key được lưu trong két sắt của hệ điều hành và không bao giờ đi qua HTTP.',
            },
        ],
    },

    // Ruling P20-5 — phần còn thiếu của bảng `errorCopy.ts`.
    errors: {
        API_KEY_NOT_ACCEPTED: 'Nhà cung cấp từ chối API key này. Kiểm tra lại key rồi lưu lại.',
        APPROVAL_NOT_FOUND: 'Yêu cầu phê duyệt này không còn tồn tại hoặc đã được xử lý.',
        TOOL_NOT_FOUND: 'Không tìm thấy tool được yêu cầu.',
        UNKNOWN_PROVIDER: 'Nhà cung cấp này không tồn tại hoặc chưa được đăng ký.',
        // Task 31C Step 2. Mỗi code dưới đây đến từ một nhánh THẬT: `serviceGateway.ts`
        // `recordFailure()` cho bốn code đầu, `reconnect()` cho `MCP_SPAWN_FAILED`, route
        // `PUT /api/mcp/path` cho `MCP_PATH_REJECTED`. Không có bản dịch nào là dead code.
        MCP_PATH_REJECTED: 'Đường dẫn server MCP không hợp lệ hoặc không nằm trong allowlist.',
        STUDIO_NOT_CONNECTED: 'Chưa có Roblox Studio nào mở place. Mở Studio rồi bấm Kết nối lại.',
        MULTIPLE_STUDIOS: 'Có nhiều Studio đang kết nối. Đóng bớt để chỉ còn một place rồi gửi lại yêu cầu.',
        MCP_SPAWN_FAILED: 'Không khởi động được MCP server của Roblox Studio. Kiểm tra Studio đã cài đặt và bật Assistant › Manage MCP Servers.',
        MCP_TOOL_TIMEOUT: 'Studio không trả lời trong thời gian cho phép. Kiểm tra place còn mở rồi gửi lại yêu cầu.',
        STUDIO_RESTART_REQUIRED: 'Studio đang chạy bản proxy cũ. Khởi động lại Roblox Studio rồi bấm Kết nối lại.',
        MCP_TOOL_FAILED: 'Studio trả về lỗi khi chạy tool này. Xem nhật ký bên dưới để biết chi tiết.',
        // I4: `RATE_LIMIT`/`PROVIDER_ERROR` bị xoá vì không code nào tồn tại trên dây — `grep -rn
        // "RATE_LIMIT\|PROVIDER_ERROR" server/src` trả về 0 kết quả. Hai code THẬT: `http_error` chỉ
        // phát ra từ adapter (gemini.ts:127 / openaiCompatible.ts:139, `retryable` = 429 hoặc ≥500 ở
        // gemini.ts:129 / openaiCompatible.ts:141), còn `stream_error` phát ra từ nhiều chỗ với
        // retryable KHÁC NHAU: `true` ở gemini.ts:117,238 / openaiCompatible.ts:129,265 (lỗi mạng lúc
        // mở stream) còn `false` ở gemini.ts:140 / openaiCompatible.ts:152 (body rỗng) và ở
        // `loop.ts:411` (tổng hợp `stream_error` khi một `finish` tới với `reason:'error'` mà chưa có
        // failure nào trước đó — không liên quan budget). Vì vậy copy của stream_error không được HỨA
        // "thử lại" — client không biết lần này retryable là gì cho tới khi đọc payload, và ErrorCard
        // ẩn nút khi `retryable === false`. Viết hoa hay lowercase đều vô nghĩa: tra cứu theo đúng xâu
        // code.
        // `http_error` thì ĐỔI ở Task 24: trước đó frame lỗi terminate một lượt luôn phát
        // `retryable: false` cứng, nên một lời hứa "thử lại" là câu UI không bao giờ giữ. Giờ loop.ts:254
        // thăng cờ của adapter, nên 429/5xx có nút Thử lại còn 4xx thì không — và copy KHÔNG được phép
        // nhắc nút (luật `ships zero retry-promising copy across the whole table` ở
        // lib/errorCopy.test.ts:103 quét cả bảng này). Hai nhánh vì thế phải dùng hành động CỦA NGƯỜI
        // DÙNG, không dùng control: "đợi rồi gửi lại" luôn làm được kể cả khi không có nút, còn
        // "kiểm tra key/model trong Cài đặt" là nhánh 4xx. Câu cũ ("Kiểm tra API key và model đã chọn")
        // sai với rate limit: key vẫn đúng, chỉ là bị chặn tần suất.
        http_error: 'Nhà cung cấp trả về lỗi HTTP. Nếu bị giới hạn tần suất, hãy đợi một phút rồi gửi lại; nếu không, kiểm tra API key và model trong phần Cài đặt.',
        stream_error: 'Luồng trả lời từ nhà cung cấp bị gián đoạn trước khi hoàn tất.',
    },

    // Vòng trạng thái context window cạnh ModelPicker (Task 31): hiện % còn lại, hover để xem chi tiết.
    contextRing: {
        used: 'Đã dùng',
        total: 'Tổng context',
        remaining: 'Còn lại',
    },

    approval: {
        title: 'Cần phê duyệt',
        deny: 'Từ chối',
        allowOnce: 'Cho phép một lần',
        // The wire has no "always" scope: only once/session exist (approval.ts:85-95).
        allowSession: 'Cho phép trong phiên',
        wantsToRun: 'Agent muốn chạy',
        riskHigh: 'Rủi ro cao',
        riskMedium: 'Rủi ro trung bình',
        riskLow: 'Rủi ro thấp',
        pending: 'Đang xin phê duyệt.',
        planTitle: 'Đặc tả đề xuất',
        planApprove: 'Duyệt kế hoạch',
        planReject: 'Từ chối',
        planRejectReason: 'Lý do từ chối (tuỳ chọn)',
        planRejectPlaceholder: 'Nói rõ phần cần sửa để AI chỉnh lại kế hoạch…',
        planRevise: 'Gửi yêu cầu chỉnh sửa',
        planCancelReject: 'Huỷ',
    },

    goals: {
        title: 'Mục tiêu',
        newGoal: 'Mục tiêu mới',
        active: 'Đang chạy',
        completed: 'Đã hoàn thành',
        progress: 'Tiến độ',
    },

    workflows: {
        title: 'Quy trình',
        running: 'Quy trình đang chạy',
        steps: 'Các bước',
        next: 'Bước tiếp theo',
        done: 'Hoàn tất quy trình',
    },

    skills: {
        title: 'Kỹ năng',
        enable: 'Bật',
        disable: 'Tắt',
        none: 'Chưa bật kỹ năng nào.',
    },

    createProject: {
        title: 'Dự án mới',
        label: 'Tên dự án',
        placeholder: 'Nhập tên dự án…',
        cancel: 'Huỷ',
        submit: 'Tạo',
    },

    confirm: {
        confirm: 'Xác nhận',
        cancel: 'Huỷ',
        delete: 'Xoá',
        cannotUndo: 'Không thể hoàn tác.',
        clearMemory: 'Xoá toàn bộ bộ nhớ?',
        // ConfirmModal và call site của nó từng hardcode tiếng Anh ("Delete Project" / "Are you
        // sure?…") ngay trong một UI 100% tiếng Việt (§6.6.2 "một bảng màu, một ngôn ngữ").
        deleteProject: 'Xoá dự án',
        deleteProjectBody: 'Toàn bộ lịch sử hội thoại của dự án này sẽ bị xoá. Không thể hoàn tác.',
    },

    // Git-like history (Phase 4): the Studio checkpoints of one session.
    history: {
        title: 'Lịch sử thay đổi Studio',
        empty: 'Chưa có thay đổi nào được ghi cho phiên này.',
        loading: 'Đang tải lịch sử…',
        loadError: 'Không tải được lịch sử thay đổi.',
        previewError: 'Không xem trước được kế hoạch khôi phục.',
        restoreError: 'Không khôi phục được.',
        restore: 'Khôi phục',
        previewTitle: 'Kế hoạch khôi phục',
        confirmRestore: 'Khôi phục ngay',
        cancel: 'Huỷ',
        restoring: 'Đang khôi phục…',
        restored: 'Đã khôi phục và xác nhận lại nội dung.',
        restoreFailed: 'Khôi phục thất bại:',
        drift: 'Nơi làm việc đã thay đổi so với bản sao — không ghi đè:',
        statusRecorded: 'Đã ghi',
        statusRestoring: 'Đang khôi phục',
        statusRestored: 'Đã khôi phục',
        statusFailed: 'Lỗi khôi phục',
    },
} as const;

export type ViDict = typeof vi;

/** The English mirror, merged over the Vietnamese base; missing keys fall back to Vietnamese. */
const VI_PRISTINE: ViDict = JSON.parse(JSON.stringify(vi)) as ViDict;

function mergeDict(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && existing && typeof existing === 'object' && !Array.isArray(existing)) {
      mergeDict(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}

/**
 * Swap the live dictionary in place so every component reading `vi.*` re-renders with the new
 * language (a `useUiLanguage` subscription at the top of the tree triggers that re-render).
 */
export function applyUiLanguage(lang: 'vi' | 'en'): void {
  const base = JSON.parse(JSON.stringify(VI_PRISTINE)) as Record<string, unknown>;
  if (lang === 'en') mergeDict(base, en as Record<string, unknown>);
  const mutable = vi as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, base);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}
