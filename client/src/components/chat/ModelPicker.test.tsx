import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from './ModelPicker';
import type { ModelInfo } from '../../types';

const MODELS: ModelInfo[] = [
    { id: 'google:gemini', name: 'Gemini 2.5', provider: 'google', providerLabel: 'Google', supportsTools: true, context: 1_048_576 },
    { id: 'openai:gpt', name: 'GPT 5', provider: 'openai', providerLabel: 'OpenAI', supportsTools: true },
];

const baseProps = {
    models: MODELS,
    selectedModel: '',
    onSelect: vi.fn(),
    onOpenSettings: vi.fn(),
    onReload: vi.fn(),
};

const openMenu = () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Chọn mô hình' }));
};

afterEach(() => {
    cleanup();
});

describe('ModelPicker', () => {
    it('puts Tự động first when selectedModel is empty', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();

        const options = screen.getAllByRole('option');
        expect(options[0]).toHaveTextContent('Tự động');
        expect(options).toHaveLength(MODELS.length + 1);
    });

    it('lists exactly the models it was given, in the given order', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();

        // So cả tập lẫn thứ tự: một id bịa thêm (dù người đọc không đoán trước được tên) làm test đỏ.
        // The declared window is printed next to the name, separated by a middle dot so the row still
        // reads as one sentence; a model that declares none stays bare.
        expect(screen.getAllByRole('option').map(option => option.textContent?.trim())).toEqual([
            'Tự động',
            'Gemini 2.5 · 1M',
            'GPT 5',
        ]);
    });

    it('roves in the same order the options are painted, even across interleaved providers', () => {
        // `models` từ API không được sắp theo provider. Bản cũ dựng `options` theo thứ tự API còn DOM theo
        // thứ tự nhóm ⇒ ArrowDown nhảy không đúng chỗ mắt nhìn.
        render(
            <ModelPicker
                {...baseProps}
                models={[MODELS[0], MODELS[1], { ...MODELS[0], id: 'google:gemini-pro', name: 'Gemini Pro' }]}
            />,
        );
        openMenu();

        const painted = screen.getAllByRole('option').map(option => option.textContent?.trim());
        expect(painted).toEqual(['Tự động', 'Gemini 2.5 · 1M', 'Gemini Pro · 1M', 'GPT 5']);

        const combo = screen.getByRole('combobox', { name: 'Chọn mô hình' });
        const activeText = () => document.getElementById(combo.getAttribute('aria-activedescendant') as string)?.textContent?.trim();
        const visited: (string | undefined)[] = [];
        for (let i = 0; i < painted.length; i += 1) {
            visited.push(activeText());
            fireEvent.keyDown(combo, { key: 'ArrowDown' });
        }
        expect(visited).toEqual(painted);
    });

    it('scopes its DOM ids to the instance so two pickers cannot collide', () => {
        // Id toàn cục (`model-option-0`) khiến `aria-activedescendant` của picker này trỏ vào option của
        // picker khác, và `getElementById` cuộn nhầm bảng — lỗi chỉ lộ ra khi có picker thứ hai.
        render(
            <>
                <ModelPicker {...baseProps} />
                <ModelPicker {...baseProps} />
            </>,
        );
        const comboboxes = screen.getAllByRole('combobox', { name: 'Chọn mô hình' });
        fireEvent.click(comboboxes[0]);
        fireEvent.click(comboboxes[1]);
        expect(screen.getAllByRole('option')).toHaveLength(6);

        for (const combo of comboboxes) {
            const listboxId = combo.getAttribute('aria-controls');
            expect(listboxId).not.toBeNull();
            const listbox = document.getElementById(listboxId as string);
            expect(listbox).not.toBeNull();
            expect(listbox!.querySelectorAll('[role=option]')).toHaveLength(3);

            fireEvent.keyDown(combo, { key: 'ArrowDown' });
            const active = document.getElementById(combo.getAttribute('aria-activedescendant') as string);
            expect(active).not.toBeNull();
            // Activedescendant phải nằm TRONG listbox của chính picker này, không phải picker bên cạnh.
            expect(listbox!.contains(active as Node)).toBe(true);
        }

        const ids = [...document.querySelectorAll('[role=option]')].map(node => node.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('prints the context window each model declares, and nothing for one that declares none', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();

        // Gemini declares 1 048 576; GPT 5 declares nothing, so the row must stay clean rather than
        // show a made-up number (Task 31C: the window is per model, not a global constant).
        expect(screen.getByText(/· 1M/)).toBeInTheDocument();
        expect(screen.getAllByText(/· \d+(\.\d+)?[kM]/)).toHaveLength(1);
    });

    it('groups options under their provider labels', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();

        expect(screen.getByText('Google')).toBeInTheDocument();
        expect(screen.getByText('OpenAI')).toBeInTheDocument();
    });

    it('roves with ArrowDown/ArrowUp and wraps, then selects with Enter', () => {
        const onSelect = vi.fn();
        render(<ModelPicker {...baseProps} onSelect={onSelect} />);
        openMenu();

        const combo = screen.getByRole('combobox', { name: 'Chọn mô hình' });
        // auto -> google -> openai -> wraps back to auto
        fireEvent.keyDown(combo, { key: 'ArrowDown' });
        fireEvent.keyDown(combo, { key: 'ArrowDown' });
        fireEvent.keyDown(combo, { key: 'ArrowDown' });
        const activeId = combo.getAttribute('aria-activedescendant');
        expect(activeId).not.toBeNull();
        expect(document.getElementById(activeId as string)).toHaveTextContent('Tự động');

        fireEvent.keyDown(combo, { key: 'ArrowUp' });
        fireEvent.keyDown(combo, { key: 'Enter' });
        expect(onSelect).toHaveBeenCalledWith('openai:gpt');
    });

    it('selects with Space and closes', () => {
        const onSelect = vi.fn();
        render(<ModelPicker {...baseProps} onSelect={onSelect} />);
        openMenu();

        const combo = screen.getByRole('combobox', { name: 'Chọn mô hình' });
        fireEvent.keyDown(combo, { key: 'ArrowDown' });
        fireEvent.keyDown(combo, { key: ' ' });

        expect(onSelect).toHaveBeenCalledWith('google:gemini');
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('closes with Escape and returns focus to the trigger', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();

        const combo = screen.getByRole('combobox', { name: 'Chọn mô hình' });
        fireEvent.keyDown(combo, { key: 'Escape' });

        expect(screen.queryByRole('listbox')).toBeNull();
        expect(combo).toHaveFocus();
    });

    it('closes on Tab so DOM focus and aria-activedescendant never disagree', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();

        const combo = screen.getByRole('combobox', { name: 'Chọn mô hình' });
        fireEvent.keyDown(combo, { key: 'Tab' });

        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('points aria-controls at the listbox only while it is mounted', () => {
        render(<ModelPicker {...baseProps} />);
        const combo = screen.getByRole('combobox', { name: 'Chọn mô hình' });

        // So THEO QUAN HỆ, không theo tên: scheme id là việc riêng của component (và `useId` thêm prefix
        // theo instance), nên pin chuỗi 'model-picker-listbox' sẽ làm test đỏ vì lý do sai khi rename hợp lệ.
        expect(combo).not.toHaveAttribute('aria-controls');
        openMenu();
        const listboxId = combo.getAttribute('aria-controls');
        expect(listboxId).not.toBeNull();
        expect(document.getElementById(listboxId as string)).toBe(screen.getByRole('listbox'));
    });

    it('closes on a click outside', () => {
        render(<ModelPicker {...baseProps} />);
        openMenu();
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        fireEvent.pointerDown(document.body);

        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('shows the no-provider copy and a working settings CTA when there are zero models', () => {
        const onOpenSettings = vi.fn();
        render(<ModelPicker {...baseProps} models={[]} onOpenSettings={onOpenSettings} />);

        expect(screen.getByText('Chưa cấu hình nhà cung cấp nào')).toBeInTheDocument();
        expect(screen.getByText('Thêm khoá API để bắt đầu.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Mở Cài đặt' }));

        expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('exposes a real reload action in the menu', () => {
        const onReload = vi.fn();
        render(<ModelPicker {...baseProps} onReload={onReload} />);
        openMenu();

        fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách mô hình' }));

        expect(onReload).toHaveBeenCalledTimes(1);
    });
});
