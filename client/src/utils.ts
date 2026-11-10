import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * Session titles are model-generated and sometimes arrive with light markdown (`**Chào bạn**`,
 * `# Kế hoạch`). Chrome (sidebar, breadcrumb) is plain text, so strip the markers rather than
 * showing literal asterisks. User-renamed titles pass through unchanged when they carry none.
 */
export function plainTitle(title: string): string {
    return title
        .replace(/^#{1,6}\s*/, '')
        .replace(/[*_`]/g, '')
        .trim();
}

/**
 * Context windows as people read them: 1 000 000 → "1M", 128 000 → "128k", 8 191 → "8k".
 * The model picker prints this so a per-model window is visible, not just implied (Task 31C).
 */
export function formatContextWindow(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) return '';
    if (tokens >= 1_000_000) {
        // 1 048 576 is "1M", not "1.0M": round first, then drop a trailing .0.
        const millions = Math.round((tokens / 1_000_000) * 10) / 10;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
    }
    return `${Math.max(1, Math.floor(tokens / 1_000))}k`;
}
