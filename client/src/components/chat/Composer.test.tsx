import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Composer } from './Composer';
import type { ModelInfo, SkillMeta } from '../../types';

const MODELS: ModelInfo[] = [
    {
        id: 'google:gemini', name: 'Gemini', provider: 'google', providerLabel: 'Google', supportsTools: true,
        efforts: ['low', 'medium', 'high'],
    },
    { id: 'openai:gpt-4o', name: 'GPT-4o', provider: 'openai', providerLabel: 'OpenAI', supportsTools: true, supportsImages: false },
];

const baseProps = {
    onSend: vi.fn(() => true),
    onStop: vi.fn(),
    models: MODELS,
    selectedModel: '',
    onSelectModel: vi.fn(),
    effort: '' as const,
    onSelectEffort: vi.fn(),
    permission: 'balanced' as const,
    onSelectPermission: vi.fn(),
    onOpenSettings: vi.fn(),
    onReloadModels: vi.fn(),
    usedTokens: 0,
    totalTokens: 0,
    modelName: '',
};

const SKILLS: SkillMeta[] = [
    {
        name: 'writing-skills',
        description: 'Dùng khi tạo, sửa hoặc kiểm tra kỹ năng trước khi triển khai',
        triggers: [],
        source: 'project',
        active: true,
    },
    {
        name: 'deploy',
        description: 'Đóng gói và phát hành bản dựng',
        triggers: [],
        source: 'project',
        active: true,
    },
];

const textarea = () => screen.getByLabelText('Khung nhắn tin') as HTMLTextAreaElement;
const slashPalette = () => screen.queryByRole('dialog', { name: 'Gợi ý lệnh và kỹ năng' });

/** Replace jsdom's FileReader so `readAsDataURL` resolves synchronously with a fixed data URL. */
const withStubbedFileReader = (run: () => Promise<void> | void) => {
    const original = global.FileReader;
    (global as unknown as { FileReader: unknown }).FileReader = class {
        result = 'data:image/png;base64,AAAA';
        onload: (() => void) | null = null;
        readAsDataURL() { this.onload?.(); }
    };
    return Promise.resolve(run()).finally(() => {
        (global as unknown as { FileReader: unknown }).FileReader = original;
    });
};

afterEach(() => {
    cleanup();
});

describe('Composer', () => {
    it('sends trimmed text on Enter and clears the textarea when the parent accepts', () => {
        const onSend = vi.fn(() => true);
        render(<Composer {...baseProps} onSend={onSend} />);

        fireEvent.change(textarea(), { target: { value: '  xin chào  ' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });

        expect(onSend).toHaveBeenCalledWith('xin chào', undefined, undefined, 'balanced', []);
        expect(textarea()).toHaveValue('');
    });

    it('Shift+Enter inserts a newline and never sends', () => {
        const onSend = vi.fn(() => true);
        render(<Composer {...baseProps} onSend={onSend} />);

        fireEvent.change(textarea(), { target: { value: 'dòng một' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });

        expect(onSend).not.toHaveBeenCalled();
        expect(textarea().value).toContain('\n');
    });

    it('disables the send control while disabled is true', () => {
        const { rerender } = render(<Composer {...baseProps} disabled={false} />);
        fireEvent.change(textarea(), { target: { value: 'nội dung' } });
        rerender(<Composer {...baseProps} disabled />);

        expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
    });

    it('turns the same control into Stop while streaming and calls onStop', () => {
        const onStop = vi.fn();
        render(<Composer {...baseProps} streaming onStop={onStop} />);

        fireEvent.click(screen.getByRole('button', { name: 'Dừng tạo' }));

        expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('morphs Stop into Send the moment the user types while streaming', () => {
        const onSend = vi.fn(() => true);
        const onStop = vi.fn();
        render(<Composer {...baseProps} streaming onSend={onSend} onStop={onStop} />);

        expect(screen.getByRole('button', { name: 'Dừng tạo' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Gửi chèn' })).toBeNull();

        fireEvent.change(textarea(), { target: { value: 'thêm vào đây' } });

        // Same circle, new job: the Stop square is gone and the steer arrow submits the queue.
        expect(screen.queryByRole('button', { name: 'Dừng tạo' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Gửi chèn' }));
        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onStop).not.toHaveBeenCalled();
    });

    it('opens the file picker when the attach (+) button is clicked', () => {
        const spy = vi.spyOn(HTMLInputElement.prototype, 'click');
        render(<Composer {...baseProps} />);

        const plus = screen.getByRole('button', { name: 'Đính kèm' });
        const input = screen.getByTestId('composer-file-input');
        expect(input).toHaveAttribute('type', 'file');

        fireEvent.click(plus);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('stages a selected file as an attachment chip', async () => {
        await withStubbedFileReader(async () => {
            render(<Composer {...baseProps} />);
            const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
            const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
            fireEvent.change(input, { target: { files: [file] } });

            expect(await screen.findByText('shot.png')).toBeInTheDocument();
        });
    });

    it('removes a staged attachment via its remove button', async () => {
        await withStubbedFileReader(async () => {
            render(<Composer {...baseProps} />);
            const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
            fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] } });

            const remove = await screen.findByRole('button', { name: 'Bỏ đính kèm' });
            fireEvent.click(remove);

            expect(screen.queryByText('shot.png')).toBeNull();
        });
    });

    it('sends staged attachments through onSend', async () => {
        const onSend = vi.fn(() => true);
        await withStubbedFileReader(async () => {
            render(<Composer {...baseProps} onSend={onSend} />);
            const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
            fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] } });
            await screen.findByText('shot.png');

            fireEvent.change(textarea(), { target: { value: 'xem ảnh' } });
            fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });

            expect(onSend).toHaveBeenCalledTimes(1);
            const call = onSend.mock.calls[0];
            expect(call[4]).toHaveLength(1);
            expect(call[4][0]).toMatchObject({ name: 'shot.png', mime: 'image/png' });
        });
    });

    it('enables the send control with an attachment and no text', async () => {
        await withStubbedFileReader(async () => {
            render(<Composer {...baseProps} />);
            const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
            fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] } });
            await screen.findByText('shot.png');

            expect(screen.getByRole('button', { name: 'Gửi' })).toBeEnabled();
        });
    });

    it('stages an image pasted from the clipboard', async () => {
        await withStubbedFileReader(async () => {
            render(<Composer {...baseProps} />);

            const event = new Event('paste', { bubbles: true });
            Object.defineProperty(event, 'clipboardData', {
                value: {
                    items: [
                        { kind: 'file', getAsFile: () => new File([new Uint8Array([1])], 'pasted.png', { type: 'image/png' }) },
                    ],
                },
            });
            textarea().dispatchEvent(event);

            expect(await screen.findByText('pasted.png')).toBeInTheDocument();
        });
    });

    describe('attachment chip', () => {
        const stageFile = async (name: string, type: string) => {
            const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
            fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], name, { type })] } });
            return screen.findByText(name);
        };

        it('opens a full-size preview when the image chip is clicked', async () => {
            await withStubbedFileReader(async () => {
                render(<Composer {...baseProps} />);
                await stageFile('shot.png', 'image/png');

                fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh: shot.png' }));

                const dialog = screen.getByRole('dialog', { name: 'shot.png' });
                expect(within(dialog).getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'data:image/png;base64,AAAA');
            });
        });

        it('closes the preview with Escape and returns focus to the chip', async () => {
            await withStubbedFileReader(async () => {
                render(<Composer {...baseProps} />);
                await stageFile('shot.png', 'image/png');
                const chip = screen.getByRole('button', { name: 'Xem ảnh: shot.png' });
                chip.focus();
                fireEvent.click(chip);
                expect(screen.getByRole('dialog', { name: 'shot.png' })).toBeInTheDocument();

                fireEvent.keyDown(document, { key: 'Escape' });

                expect(screen.queryByRole('dialog', { name: 'shot.png' })).toBeNull();
                expect(chip).toHaveFocus();
            });
        });

        it('closes the preview from the close button', async () => {
            await withStubbedFileReader(async () => {
                render(<Composer {...baseProps} />);
                await stageFile('shot.png', 'image/png');
                fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh: shot.png' }));

                fireEvent.click(screen.getByRole('button', { name: 'Đóng xem trước' }));

                expect(screen.queryByRole('dialog', { name: 'shot.png' })).toBeNull();
            });
        });

        it('closes the preview when the backdrop is clicked', async () => {
            await withStubbedFileReader(async () => {
                render(<Composer {...baseProps} />);
                await stageFile('shot.png', 'image/png');
                fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh: shot.png' }));
                const dialog = screen.getByRole('dialog', { name: 'shot.png' });

                fireEvent.click(dialog.parentElement as HTMLElement);

                expect(screen.queryByRole('dialog', { name: 'shot.png' })).toBeNull();
            });
        });

        it('offers no preview for a non-image attachment', async () => {
            await withStubbedFileReader(async () => {
                render(<Composer {...baseProps} />);
                await stageFile('notes.txt', 'text/plain');

                expect(screen.queryByRole('button', { name: /Xem ảnh/ })).toBeNull();
            });
        });

        it('keeps the chip overlay on the fixed overlay token instead of theme tokens', async () => {
            await withStubbedFileReader(async () => {
                render(<Composer {...baseProps} />);
                await stageFile('shot.png', 'image/png');

                const remove = screen.getByRole('button', { name: 'Bỏ đính kèm' });
                expect(remove.className).toContain('text-overlay-fg');
                expect(remove.className).not.toContain('text-bg-main');
                const label = screen.getByText('shot.png');
                expect(label.className).toContain('text-overlay-fg');
                expect(label.className).toContain('bg-overlay');
            });
        });
    });

    it('keeps the text when onSend returns false', () => {
        const onSend = vi.fn(() => false);
        render(<Composer {...baseProps} onSend={onSend} />);

        fireEvent.change(textarea(), { target: { value: 'giữ lại' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });

        expect(onSend).toHaveBeenCalledWith('giữ lại', undefined, undefined, 'balanced', []);
        expect(textarea()).toHaveValue('giữ lại');
    });

    it('uses the brand-green send button (one CTA colour for the whole app)', () => {
        render(<Composer {...baseProps} />);
        fireEvent.change(textarea(), { target: { value: 'gửi' } });

        const send = screen.getByRole('button', { name: 'Gửi' });
        expect(send).toHaveClass('bg-brand');
        expect(send).toHaveClass('text-bg-main');
        // Palette-literal white text is banned (tokens.test.ts §6.6.1): the token pair above is
        // the brand surface with the app's own surface text, AA in both themes.
        expect(send).not.toHaveClass('text-white');
    });

    it('grows the textarea to its content height and stops at the 200px cap', () => {
        render(<Composer {...baseProps} />);
        const field = textarea();

        Object.defineProperty(field, 'scrollHeight', { value: 60, configurable: true });
        fireEvent.change(field, { target: { value: 'dài' } });
        expect(field.style.height).toBe('60px');

        Object.defineProperty(field, 'scrollHeight', { value: 480, configurable: true });
        fireEvent.change(field, { target: { value: 'dài hơn nữa' } });
        expect(field.style.height).toBe('200px');
        expect(field).toHaveClass('max-h-[200px]');
    });

    it('restores the submitted text when Stop is pressed during the starting window', () => {
        const onStop = vi.fn();
        const { rerender } = render(<Composer {...baseProps} onSend={vi.fn(() => true)} />);

        fireEvent.change(textarea(), { target: { value: 'tin nhắn đang chờ' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });
        expect(textarea()).toHaveValue('');

        rerender(<Composer {...baseProps} starting disabled onStop={onStop} />);
        fireEvent.click(screen.getByRole('button', { name: 'Dừng tạo' }));

        expect(onStop).toHaveBeenCalledTimes(1);
        expect(textarea()).toHaveValue('tin nhắn đang chờ');
    });

    it('does not restore the text when Stop is pressed after streaming started', () => {
        const onStop = vi.fn();
        const { rerender } = render(<Composer {...baseProps} onSend={vi.fn(() => true)} />);

        fireEvent.change(textarea(), { target: { value: 'tin nhắn đã chạy' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });

        rerender(<Composer {...baseProps} streaming disabled onStop={onStop} />);
        fireEvent.click(screen.getByRole('button', { name: 'Dừng tạo' }));

        expect(onStop).toHaveBeenCalledTimes(1);
        expect(textarea()).toHaveValue('');
    });

    it('does not restore a stale draft into a turn the composer did not start', () => {
        const onStop = vi.fn();
        const accepted = () => vi.fn(() => true);
        const { rerender } = render(<Composer {...baseProps} onSend={accepted()} />);

        // Lượt 1 do chính textarea gửi, rồi settled: `starting` true → false.
        fireEvent.change(textarea(), { target: { value: 'tin A' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });
        rerender(<Composer {...baseProps} onSend={accepted()} starting />);
        rerender(<Composer {...baseProps} onSend={accepted()} />);

        // Lượt 2 do WelcomeView khởi động — textarea không nhận chữ nào. Stop trong cửa sổ này
        // mà khôi lời 'tin A' là nhét một tin nhắn người dùng đã bỏ đi vào khung soạn.
        rerender(<Composer {...baseProps} onSend={accepted()} starting disabled onStop={onStop} />);
        fireEvent.click(screen.getByRole('button', { name: 'Dừng tạo' }));

        expect(textarea()).toHaveValue('');
    });

    it('offers a reasoning level only for a model that declares one', () => {
        render(<Composer {...baseProps} selectedModel="openai:gpt-4o" />);
        // GPT-4o declares no efforts: a control here would be a switch that does nothing.
        expect(screen.queryByRole('button', { name: 'Mức suy nghĩ' })).toBeNull();
        cleanup();

        render(<Composer {...baseProps} selectedModel="google:gemini" />);
        expect(screen.getByRole('button', { name: 'Mức suy nghĩ' })).toBeInTheDocument();
    });

    it('opens a draggable slider and reports the chosen level to the parent', () => {
        const onSelectEffort = vi.fn();
        render(<Composer {...baseProps} selectedModel="google:gemini" onSelectEffort={onSelectEffort} />);

        fireEvent.click(screen.getByRole('button', { name: 'Mức suy nghĩ' }));
        const slider = screen.getByRole('slider', { name: 'Mức suy nghĩ' });
        expect(slider).toBeInTheDocument();

        // Kéo (drag) slider tới nấc cao nhất.
        fireEvent.change(slider, { target: { value: '2' } });
        expect(onSelectEffort).toHaveBeenCalledWith('high');

        // Nhấp vào nhãn nấc cũng đặt được mức (Thấp).
        fireEvent.click(screen.getByRole('button', { name: 'Thấp' }));
        expect(onSelectEffort).toHaveBeenCalledWith('low');
    });

    it('offers every level a model declares, including max/xhigh (Crouton Alpha shape)', () => {
        const crouton = {
            id: 'stealth/crouton-alpha', name: 'Crouton Alpha', provider: 'openrouter',
            providerLabel: 'OpenRouter', supportsTools: true, context: 1_048_576,
            efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
        };
        const onSelectEffort = vi.fn();
        render(
            <Composer
                {...baseProps}
                models={[crouton]}
                selectedModel="stealth/crouton-alpha"
                onSelectEffort={onSelectEffort}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Mức suy nghĩ' }));
        const slider = screen.getByRole('slider', { name: 'Mức suy nghĩ' });
        expect(slider).toHaveAttribute('max', '5');

        fireEvent.change(slider, { target: { value: '5' } });
        expect(onSelectEffort).toHaveBeenCalledWith('max');
        fireEvent.click(screen.getByRole('button', { name: 'Tối thiểu' }));
        expect(onSelectEffort).toHaveBeenCalledWith('minimal');
    });

    it('closes the effort dialog with Escape and returns focus to its button', () => {
        render(<Composer {...baseProps} selectedModel="google:gemini" />);
        const trigger = screen.getByRole('button', { name: 'Mức suy nghĩ' });

        fireEvent.click(trigger);
        expect(screen.getByRole('dialog', { name: 'Mức suy nghĩ' })).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Mức suy nghĩ' })).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('shows the current permission mode on its pill', () => {
        render(<Composer {...baseProps} permission="full" />);
        const pill = screen.getByRole('button', { name: 'Quyền thực thi' });
        expect(pill).toHaveTextContent('Toàn quyền');
    });

    it('opens the permission dialog and reports the chosen mode to the parent', () => {
        const onSelectPermission = vi.fn();
        render(<Composer {...baseProps} onSelectPermission={onSelectPermission} permission="balanced" />);

        fireEvent.click(screen.getByRole('button', { name: 'Quyền thực thi' }));
        const dialog = screen.getByRole('dialog', { name: 'Quyền thực thi' });
        expect(dialog).toBeInTheDocument();

        fireEvent.click(screen.getByRole('radio', { name: /Toàn quyền/ }));
        // Full access is a two-step choice: the warning explains the risk before the parent hears it.
        expect(onSelectPermission).not.toHaveBeenCalled();
        const confirm = screen.getByRole('dialog', { name: 'Bật toàn quyền?' });
        fireEvent.click(within(confirm).getByRole('button', { name: 'Xác nhận' }));
        expect(onSelectPermission).toHaveBeenCalledWith('full');
        // Both the picker and the warning close on confirm.
        expect(screen.queryByRole('dialog', { name: 'Quyền thực thi' })).toBeNull();
        expect(screen.queryByRole('dialog', { name: 'Bật toàn quyền?' })).toBeNull();
    });

    it('filters the model picker by the typed keyword and keeps Auto pinned', () => {
        render(<Composer {...baseProps} />);

        fireEvent.click(screen.getByRole('combobox', { name: 'Chọn mô hình' }));
        expect(screen.getByRole('option', { name: /Gemini/ })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /GPT-4o/ })).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Tìm model'), { target: { value: 'gemini' } });

        expect(screen.queryByRole('option', { name: /GPT-4o/ })).toBeNull();
        expect(screen.getByRole('option', { name: /Gemini/ })).toBeInTheDocument();
        // Auto is never filtered out.
        expect(screen.getByRole('option', { name: 'Tự động' })).toBeInTheDocument();
    });

    it('reports no results when the filter matches nothing and the row picks are inert', () => {
        const onSelectModel = vi.fn();
        render(<Composer {...baseProps} onSelectModel={onSelectModel} />);

        fireEvent.click(screen.getByRole('combobox', { name: 'Chọn mô hình' }));
        fireEvent.change(screen.getByLabelText('Tìm model'), { target: { value: 'xyzzy-nothere' } });

        expect(screen.getByText('Không tìm thấy model phù hợp')).toBeInTheDocument();
        // Only Auto remains; Enter picks it explicitly (id '').
        fireEvent.keyDown(screen.getByLabelText('Tìm model'), { key: 'Enter' });
        expect(onSelectModel).toHaveBeenCalledWith('');
    });

    it('selects the filtered model with mouse and closes the picker', () => {
        const onSelectModel = vi.fn();
        render(<Composer {...baseProps} onSelectModel={onSelectModel} />);

        fireEvent.click(screen.getByRole('combobox', { name: 'Chọn mô hình' }));
        fireEvent.change(screen.getByLabelText('Tìm model'), { target: { value: 'gemini' } });
        fireEvent.click(screen.getByRole('option', { name: /Gemini/ }));

        expect(onSelectModel).toHaveBeenCalledWith('google:gemini');
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('refuses to stage an image when the selected model does not take images', async () => {
        await withStubbedFileReader(async () => {
            const onNotify = vi.fn();
            render(<Composer {...baseProps} selectedModel="openai:gpt-4o" onNotify={onNotify} />);
            const input = screen.getByTestId('composer-file-input') as HTMLInputElement;

            fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] } });

            expect(onNotify).toHaveBeenCalledWith(
                'Model này không nhận ảnh. Chọn model hỗ trợ ảnh hoặc không đính kèm ảnh.',
            );
            expect(screen.queryByText('shot.png')).toBeNull();

            // Non-image attachments are still staged for the same model.
            fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'note.txt', { type: 'text/plain' })] } });
            expect(await screen.findByText('note.txt')).toBeInTheDocument();
            expect(onNotify).toHaveBeenCalledTimes(1);
        });
    });

    it('passes the selected model, the chosen effort and the permission mode through on send', () => {
        const onSend = vi.fn(() => true);
        render(<Composer {...baseProps} onSend={onSend} selectedModel="google:gemini" effort="high" />);

        fireEvent.change(textarea(), { target: { value: 'hỏi' } });
        fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false });

        expect(onSend).toHaveBeenCalledWith('hỏi', 'google:gemini', 'high', 'balanced', []);
    });

    it('opens the slash palette with the skill catalogue and the built-in commands', () => {
        render(<Composer {...baseProps} skills={SKILLS} />);
        fireEvent.change(textarea(), { target: { value: '/' } });

        const palette = slashPalette();
        expect(palette).toBeInTheDocument();
        expect(palette).toHaveTextContent('Kỹ năng (2)');
        expect(palette).toHaveTextContent('Lệnh (10)');
        expect(screen.getByRole('option', { name: /writing-skills/ })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /\/new/ })).toBeInTheDocument();
    });

    it('filters the slash palette by the text typed after the slash', () => {
        render(<Composer {...baseProps} skills={SKILLS} />);
        fireEvent.change(textarea(), { target: { value: '/cl' } });

        expect(screen.getByRole('option', { name: /\/clear/ })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /\/new/ })).toBeNull();
        expect(screen.queryByRole('option', { name: /writing-skills/ })).toBeNull();
    });

    it('runs the highlighted command on Enter and clears the draft', () => {
        const onRunCommand = vi.fn();
        render(<Composer {...baseProps} skills={SKILLS} onRunCommand={onRunCommand} />);
        fireEvent.change(textarea(), { target: { value: '/new' } });

        fireEvent.keyDown(textarea(), { key: 'Enter' });

        expect(onRunCommand).toHaveBeenCalledWith('new-chat');
        expect(textarea()).toHaveValue('');
        expect(slashPalette()).toBeNull();
    });

    it('inserts a chosen skill name into the draft instead of sending it', () => {
        const onSend = vi.fn(() => true);
        render(<Composer {...baseProps} skills={SKILLS} onSend={onSend} />);
        fireEvent.change(textarea(), { target: { value: '/wri' } });

        fireEvent.click(screen.getByRole('option', { name: /writing-skills/ }));

        expect(textarea()).toHaveValue('writing-skills ');
        expect(onSend).not.toHaveBeenCalled();
        expect(slashPalette()).toBeNull();
    });

    it('highlights the first visible skill before any command', () => {
        render(<Composer {...baseProps} skills={SKILLS} />);
        fireEvent.change(textarea(), { target: { value: '/' } });

        // The palette renders skills first (SECTION_ORDER), so the active index must point there too.
        expect(screen.getByRole('option', { name: /writing-skills/ })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('option', { name: /\/new/ })).toHaveAttribute('aria-selected', 'false');
    });
});
