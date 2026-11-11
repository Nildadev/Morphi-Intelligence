import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RestoreNotice, undoNoticeOf } from './RestoreNotice';
import { vi as strings } from '../../i18n/vi';
import type { TurnRestoreResult } from '../../types';

/**
 * Drift has to be legible IN the transcript, not only in a toast that fades.
 *
 * These cases feed real `TurnRestoreResult` payloads (the shape the server answers from
 * `POST /sessions/:id/undo-turn`) through the same `undoNoticeOf` the Undo button uses, so the
 * mapping cannot drift away from the component.
 */

const result = (over: Partial<TurnRestoreResult> = {}): TurnRestoreResult => ({
    restored: [],
    failed: [],
    skipped: [],
    notRestorable: [],
    drift: [],
    status: 'restored',
    ...over,
});

afterEach(() => cleanup());

describe('undoNoticeOf', () => {
    it('turns drift into a refusal carrying the path the server diffed', () => {
        const notice = undoNoticeOf(result({
            status: 'refused',
            drift: ['ServerScriptService.Main đã đổi — không khôi phục để tránh ghi đè.'],
        }));
        expect(notice?.tone).toBe('refused');
        expect(notice?.title).toBe(strings.chat.undoDrift);
        expect(notice?.lines).toEqual(['ServerScriptService.Main đã đổi — không khôi phục để tránh ghi đè.']);
    });

    it('reports per-target failures as a partial restore', () => {
        const notice = undoNoticeOf(result({
            status: 'restore-failed',
            failed: [{ path: 'A', reason: 'Đã ghi nhưng nội dung đọc lại không khớp bản sao.' }],
        }));
        expect(notice?.tone).toBe('partial');
        expect(notice?.lines).toEqual(['A: Đã ghi nhưng nội dung đọc lại không khớp bản sao.']);
    });

    it('surfaces properties Studio refused, so a partial rollback is not read as complete', () => {
        const notice = undoNoticeOf(result({
            restored: ['ckp_1'],
            skipped: [{ path: 'Workspace.Part', key: 'BrickColor', reason: 'BrickColor expected, got string' }],
        }));
        expect(notice?.tone).toBe('info');
        expect(notice?.title).toBe(strings.chat.undoSkipped);
        expect(notice?.lines[0]).toContain('Workspace.Part.BrickColor');
    });

    it('says nothing when the whole turn was restored', () => {
        expect(undoNoticeOf(result({ restored: ['ckp_1'] }))).toBeNull();
    });

    it('prefers the refusal over per-target failures, because a refusal wrote nothing', () => {
        const notice = undoNoticeOf(result({
            status: 'refused',
            drift: ['A đã đổi.'],
            failed: [{ path: 'B', reason: 'x' }],
        }));
        expect(notice?.tone).toBe('refused');
        expect(notice?.lines).toEqual(['A đã đổi.']);
    });
});

describe('RestoreNotice', () => {
    it('renders the refusal as an alert and dismisses on request', () => {
        const onDismiss = vi.fn();
        const notice = undoNoticeOf(result({ status: 'refused', drift: ['A đã đổi.'] }))!;
        render(<RestoreNotice notice={notice} onDismiss={onDismiss} />);

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent(strings.chat.undoDrift);
        expect(alert).toHaveTextContent('A đã đổi.');

        fireEvent.click(screen.getByRole('button', { name: strings.chat.dismissNotice }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('renders skipped properties as a quiet status rather than an error', () => {
        const notice = undoNoticeOf(result({
            restored: ['ckp_1'],
            skipped: [{ path: 'Workspace.Part', key: 'Size', reason: 'Vector3 expected, got string' }],
        }))!;
        render(<RestoreNotice notice={notice} onDismiss={() => undefined} />);
        expect(screen.getByRole('status')).toHaveTextContent('Vector3 expected, got string');
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
