import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Settings › Nâng cao — §6.6 yêu cầu ba mục (title model, auto priority, compaction thresholds) nhưng
 * 1.1.0 không có route nào trả `RuntimeConfig`. Panel vì thế CHỈ ĐỌC: liệt kê đúng giá trị + nơi khai
 * báo thật, và nói thẳng vì sao không có ô sửa.
 *
 * File này chỉ giữ nửa NGUỒN-KHAI-BÁO. Nửa read-only (không control sửa được, không nút "Lưu" chết,
 * copy "không sửa trong UI") nằm trong `SettingsModal.test.tsx`, nơi panel được mount BÊN TRONG hộp
 * thoại thật — phép đếm control toàn document ở đó chứng minh luôn tablist không thêm ô sửa nào. Hai
 * file cùng đếm một sự vắng mặt chính là cách một nút "Lưu" chết lọt qua mà không ai đỏ mắt.
 */
import { AdvancedPanel } from './AdvancedPanel';

// `screen` query `document.body`, nên render của test trước PHẢI bị dọn, không thì nhãn bị đếm nhân đôi.
afterEach(cleanup);

describe('SettingsModal › Advanced panel', () => {
    it('lists the three spec fields and where each is declared', () => {
        render(<AdvancedPanel />);

        expect(screen.getByText('Model đặt tiêu đề')).toBeInTheDocument();
        expect(screen.getByText('Thứ tự ưu tiên khi tự chọn model')).toBeInTheDocument();
        expect(screen.getByText('Ngưỡng nén ngữ cảnh')).toBeInTheDocument();

        // Nơi khai báo THẬT (settings.json / env), không phải một ô input rỗng.
        expect(screen.getByText('MORPHI_TITLE_MODEL')).toBeInTheDocument();
        expect(screen.getByText('settings.json → autoPriority')).toBeInTheDocument();
        // Mỗi trong ba mục đều dán nhãn "Khai báo tại" — đúng ba lần, không mục nào thiếu nguồn.
        expect(screen.getAllByText('Khai báo tại')).toHaveLength(3);
    });
});
