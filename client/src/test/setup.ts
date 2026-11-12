/**
 * Setup cho mọi test React (jsdom). `vitest.config.ts` nạp file này qua `setupFiles`, NÊN component
 * test không cần tự import jest-dom — nhờ vậy nếu `setupFiles` mất thì `toBeInTheDocument`/`toHaveAttribute`
 * chết ngay và test đỏ (setup thật sự có tác dụng, không phải import trang trí).
 */
import '@testing-library/jest-dom/vitest';

/**
 * React 19 từ chối `act()` nếu môi trường không tự khai là act-environment: `Toast.test.tsx` cần `act`
 * BÊN NGOÀI (bao quanh `vi.advanceTimersByTime` để kiểm đồng hồ auto-dismiss), còn RTL chỉ bật cờ này cho
 * các helper của riêng nó ⇒ không khai thì mỗi lần bọc act là một cảnh báo "environment is not
 * configured to support act(...)" và state update rơi ra ngoài batch.
 */
declare global {
    // React 19 đọc biến toàn cục này để cho phép `act()` từ ngoài; types của nó không khai báo sẵn.
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
