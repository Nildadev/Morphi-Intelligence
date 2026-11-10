import { cn, formatContextWindow } from '../../utils';
import { vi } from '../../i18n/vi';

export interface ContextRingProps {
    /** Tokens the conversation has used so far this session (sum of message usage). */
    usedTokens: number;
    /** The selected model's declared context window in tokens; the ring hides when absent. */
    totalTokens: number;
    /** Model display name, shown in the hover detail. */
    modelName: string;
    className?: string;
}

const RADIUS = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Circular indicator of how much of the model's context window remains. The arc shrinks (and turns
 * amber → red) as usage grows; the centre shows the remaining percentage, and hovering reveals a
 * detail card with used / total / remaining. Placed beside the model chip in the composer toolbar.
 */
export function ContextRing({ usedTokens, totalTokens, modelName, className }: ContextRingProps) {
    const fraction = totalTokens > 0 ? Math.min(1, Math.max(0, usedTokens / totalTokens)) : 0;
    const remainingFraction = 1 - fraction;
    const remainingPct = Math.round(remainingFraction * 100);
    const color = fraction >= 0.9 ? '#ef4444' : fraction >= 0.7 ? '#f59e0b' : 'var(--brand-text)';
    const dash = CIRCUMFERENCE * remainingFraction;

    const tooltipRow = (label: string, value: string, valueClassName?: string) => (
        <div className="flex items-center justify-between gap-4">
            <span className="text-text-secondary">{label}</span>
            <span className={cn('text-text-primary', valueClassName)}>{value}</span>
        </div>
    );

    return (
        <div className={cn('group relative flex items-center', className)} aria-label={`${modelName}: ${remainingPct}% context còn lại`}>
            <svg width={30} height={30} viewBox="0 0 30 30" className="shrink-0" aria-hidden="true">
                <circle cx={15} cy={15} r={RADIUS} fill="none" stroke="var(--bg-inset)" strokeWidth={3} />
                <circle
                    cx={15}
                    cy={15}
                    r={RADIUS}
                    fill="none"
                    stroke={color}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
                    transform="rotate(-90 15 15)"
                />
                <text
                    x={15}
                    y={15}
                    dominantBaseline="central"
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={600}
                    fill="var(--text-secondary)"
                >
                    {remainingPct}
                </text>
            </svg>

            <div
                role="tooltip"
                className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 hidden w-56 rounded-xl border border-border bg-bg-card p-3 text-[12px] shadow-premium group-hover:block"
            >
                <div className="pb-1.5 text-[13px] font-semibold text-text-primary">{modelName}</div>
                {tooltipRow(vi.contextRing.used, usedTokens.toLocaleString('en-US'))}
                {tooltipRow(vi.contextRing.total, formatContextWindow(totalTokens))}
                {tooltipRow(vi.contextRing.remaining, `${remainingPct}%`, undefined)}
            </div>
        </div>
    );
}
