import { useEffect, useRef } from 'react';
import { X } from '../icons';
import { vi } from '../../i18n/vi';

export interface ImageLightboxProps {
    src: string;
    name: string;
    onClose: () => void;
}

/**
 * Full-screen preview for a staged image chip. The backdrop is fixed dark in both themes: the
 * pixels being viewed sit on arbitrary colours, so theme tokens would tint or wash them out.
 * Escape, the close button and a backdrop click all close it; focus returns to the opener.
 */
export function ImageLightbox({ src, name, onClose }: ImageLightboxProps) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            // The close button is the only stop: Tab must not leak into the page behind the scrim.
            if (event.key === 'Tab') {
                event.preventDefault();
                closeRef.current?.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previous?.focus();
        };
    }, []);

    return (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-overlay-strong p-12" onClick={onClose}>
            <button
                ref={closeRef}
                type="button"
                aria-label={vi.composer.previewClose}
                onClick={onClose}
                className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-overlay text-overlay-fg transition-colors hover:bg-overlay-strong"
            >
                <X size={18} aria-hidden="true" />
            </button>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={name}
                className="relative flex max-h-full max-w-full flex-col items-center gap-3"
                onClick={(event) => event.stopPropagation()}
            >
                <img src={src} alt={name} className="max-h-[80vh] max-w-full rounded-lg object-contain" />
                <p className="max-w-full truncate text-[13px] text-overlay-fg">{name}</p>
            </div>
        </div>
    );
}
