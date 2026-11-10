import { useEffect, useRef, useState } from 'react';

/**
 * Bẫy focus cho dialog (spec §6.7 "modal focus trap"). MỘT hook duy nhất vì BỐN surface cùng phải đi
 * theo một luật: ba dialog của ứng dụng (Settings, Onboarding, CreateProject) và hộp xác nhận LỒNG
 * trong Settings (`ConfirmModal`, mở từ `MemoryPanel`). Tab/Shift+Tab không được thoát ra ngoài, Esc
 * đóng, và focus phải TRẢ VỀ phần tử đã mở dialog khi đóng.
 *
 * `onEscape` được giữ trong một ref chứ không nằm trong deps: một callback có identity mới mỗi render
 * (chuyện bình thường khi caller viết `onClose={() => setOpen(false)}`) sẽ re-run effect, và cleanup
 * của lần chạy trước thì trả focus về nút mở — nghĩa là mỗi lần cha render là focus nhảy về nút cũ.
 *
 * `activeTraps` là stack module-level (Ruling M3-a): dialog mở SAU cùng là đỉnh stack và là phần tử
 * DUY NHẤT xử lý keydown. Không có nó thì hộp confirm lồng trong Settings ăn luôn Escape của Settings:
 * đo thật trên trình duyệt, một phím Esc ở bước "Không thể hoàn tác" đóng cả confirm lẫn cửa sổ Cài đặt.
 *
 * Listener gắn trên `document` ở capture phase, KHÔNG trên container: `keydown` chỉ đi theo chuỗi tổ
 * tiên của phần tử đang focus, nên một listener trên container không bao giờ chạy khi focus nằm ngoài
 * container — đó chính là nhánh "focus ở ngoài thì kéo về" bản cũ là code chết (M4), và cũng là lý do
 * hai dialog lồng nhau không tự chia được Tab.
 */
const activeTraps: HTMLElement[] = [];

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Phần tử không với tới được: bị `hidden`/`aria-hidden`, hoặc bị `disabled` theo đúng attribute. */
const isReachable = (element: Element): boolean => {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false;
    return !element.hasAttribute('disabled');
};

/**
 * `event.target` có thuộc về một modal KHÔNG đăng ký với stack không?
 *
 * Listener ở capture phase trên `document` (đầu effect) thấy mọi phím của trang, kể cả phím rơi vào
 * overlay tự quản lý: `SearchPalette.tsx` và `ApprovalModal.tsx` đều là `role="dialog"[aria-modal="true"]`
 * và tự xử lý Escape ở bubble phase mà không gọi hook này. Trước round 2, một dialog có đăng ký vẫn nuốt
 * chúng: `stopPropagation()` trong nhánh Escape khiến handler của overlay không bao giờ chạy, còn nhánh
 * `!container.contains(current)` kéo Tab của overlay về dialog của kẻ khác. Overlay không
 * còn phím nào của chính nó — và người dùng không có cách nào đóng nó bằng Esc.
 *
 * Nhận dạng bằng `closest` trên chính modal selector: overlay nằm NGOÀI stack thì nhường toàn bộ,
 * còn `ConfirmModal` (đăng ký ở `ConfirmModal.tsx:45`) vẫn ăn phím bình thường — luật cũ của
 * Ruling M3-a không đổi. Focus ở nền (`body`, không có modal tổ tiên nào) cũng không rơi vào nhánh này,
 * nên `!container.contains(current)` vẫn là nhánh sống như M4 đã chứng minh.
 */
const isOutsideStack = (target: EventTarget | null, traps: HTMLElement[]): boolean => {
    if (!(target instanceof Element)) return false;
    const modal = target.closest('[role="dialog"][aria-modal="true"]');
    return modal !== null && !traps.includes(modal as HTMLElement);
};

export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
    const containerRef = useRef<T | null>(null);
    const escapeRef = useRef(onEscape);
    escapeRef.current = onEscape;
    /**
     * Nợ M2 (round 3): "opener" PHẢI được bắt lúc RENDER, không lúc effect chạy. React áp `autoFocus` ở
     * commit phase, nên với hộp có input tự bắt focus (input `autoFocus` trong `CreateProjectModal`) thì
     * đến khi effect chạy, `document.activeElement` đã là input BÊN TRONG dialog. Bắt ở effect ⇒ `opener`
     * bị nhận nhầm là chính input ⇒ `opener?.focus?.()` lúc đóng gọi focus trên node đã bị gỡ, focus rơi
     * về `body` thay vì trả về nút "Dự án mới". Test `accessibility.test.tsx` (nợ M2) là thứ đo ra lỗi này.
     *
     * m13: bản round 3 giữ `opener` trong một ref và chạm ref ngay lúc render — `react-hooks/refs` cấm
     * đúng kiểu đó (đọc/ghi ref trong render không an toàn dưới StrictMode). Khuôn React cho phép là
     * "điều chỉnh state lúc render": `undefined` = chưa bắt, `HTMLElement | null` = đã bắt. React vẽ lại
     * trước commit nên effect vẫn thấy giá trị đúng, mà không có ref nào bị chạm trong render cả.
     */
    const [opener, setOpener] = useState<HTMLElement | null | undefined>(undefined);
    if (active && opener === undefined) {
        const current = document.activeElement;
        setOpener(current instanceof HTMLElement ? current : null);
    }
    // Đóng hộp = gỡ chốt, để lần mở SAU bắt lại opener từ đầu: giữ giá trị cũ thì đóng/mở lần hai sẽ trả
    // focus về node của lượt trước, mà node đó rất có thể đã bị gỡ khỏi DOM (focus lại rơi về body).
    if (!active && opener !== undefined) setOpener(undefined);

    useEffect(() => {
        if (!active) return undefined;
        const container = containerRef.current;
        if (!container) return undefined;
        activeTraps.push(container);

        const items = (): HTMLElement[] =>
            Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isReachable);

        // Mở dialog = focus phải vào trong nó. Nếu markup đã tự đặt focus (`autoFocus`) thì tôn trọng.
        if (!container.contains(document.activeElement)) {
            const first = items()[0];
            if (first) first.focus();
        }

        const onKeyDown = (event: KeyboardEvent) => {
            // Chỉ dialog trên đỉnh stack mới được quyền phản ứng (Ruling M3-a). Dialog nằm dưới im lặng
            // để hộp confirm lồng không bị "đóng làm hai" bởi cùng một phím Esc.
            if (activeTraps[activeTraps.length - 1] !== container) return;
            // Phím rơi vào một overlay không đăng ký thì overlay đó chủ: `stopPropagation()` bên dưới
            // sẽ cắt handler Escape của nó, còn nhánh `!container.contains(current)` sẽ kéo Tab của nó
            // về dialog của ta (m-trap, re-review §2.4).
            if (isOutsideStack(event.target, activeTraps)) return;

            if (event.key === 'Escape') {
                event.stopPropagation();
                escapeRef.current?.();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = items();
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const current = document.activeElement;
            // Focus nằm ngoài container (kể cả `body` sau một lần blur lập trình, hoặc khi AT đặt con
            // trỏ ra nền) -> Tab phải đưa nó VỀ dialog, không cho trượt sang phần tử nền phía sau.
            if (!container.contains(current)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && current === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && current === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            const index = activeTraps.indexOf(container);
            if (index >= 0) activeTraps.splice(index, 1);
            opener?.focus?.();
        };
        // `opener` CỐ Ý không nằm trong deps: nó được bắt một lần ở render đầu của lượt mở, và cho nó vào
        // deps sẽ chạy lại toàn bộ effect ngay lượt đó — cleanup trả focus về opener rồi setup lại kéo nó
        // vào dialog, tức mở hộp là focus nhảy ra rồi nhảy vào. `active` là nhịp đúng: một lần dựng bẫy
        // cho một lần mở.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    return containerRef;
}

export default useFocusTrap;
