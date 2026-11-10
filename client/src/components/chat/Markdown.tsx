import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Check, Copy } from '../icons';
import { vi } from '../../i18n/vi';
import { StreamWords } from './StreamWords';

function CodeBlock({ language, code }: { language: string; code: string }) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable: never claim the copy happened.
        }
    };

    return (
        <div className="my-4 overflow-hidden rounded-xl border border-code-line bg-code-surface">
            <div className="flex items-center justify-between border-b border-code-line px-3 py-1.5">
                <span className="font-mono text-[12px] text-code-fg">{language}</span>
                <button
                    type="button"
                    aria-label={copied ? vi.chat.copiedCode : vi.chat.copyCode}
                    title={copied ? vi.chat.copiedCode : vi.chat.copyCode}
                    onClick={() => { void copy(); }}
                    className="inline-flex items-center gap-1.5 rounded-lg p-1.5 font-mono text-[12px] text-code-fg transition-colors hover:bg-code-line"
                >
                    {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                    <span>{copied ? vi.chat.copied : vi.chat.copy}</span>
                </button>
            </div>
            <SyntaxHighlighter
                style={vscDarkPlus}
                language={language}
                PreTag="div"
                className="!m-0 !bg-transparent !p-4 !text-[13px] font-mono leading-relaxed"
            >
                {code}
            </SyntaxHighlighter>
        </div>
    );
}

type AnimateText = (children: unknown) => ReactNode;

/** Only the text inside inline elements needs word animation; `animateText` is always supplied here. */
function streamed(children: unknown, animateText?: AnimateText): ReactNode {
    return animateText ? animateText(children) : (children as ReactNode);
}

/**
 * One stable component map for both paths. react-markdown treats a component's function identity
 * as the element type: recreating these arrows on each render would remount every block on every
 * streamed delta, reset flowtoken's token cursor and replay the effect over the whole answer.
 * Module scope keeps existing tokens (and their DOM nodes) alive so only appended text animates.
 */
const MARKDOWN_COMPONENTS = {
    p: ({ children, animateText }: any) => (
        <p className="mb-4 last:mb-0 leading-6">{streamed(children, animateText)}</p>
    ),
    li: ({ children, animateText }: any) => (
        <li className="leading-6">{streamed(children, animateText)}</li>
    ),
    strong: ({ children, animateText }: any) => (
        <strong className="font-semibold text-text-primary">{streamed(children, animateText)}</strong>
    ),
    em: ({ children, animateText }: any) => <em>{streamed(children, animateText)}</em>,
    a: ({ href, children, animateText }: any) => (
        <a href={href} className="text-brand-text underline underline-offset-2">{streamed(children, animateText)}</a>
    ),
    blockquote: ({ children, animateText }: any) => (
        <blockquote className="mb-4 border-l-2 border-border pl-4 text-text-secondary">{streamed(children, animateText)}</blockquote>
    ),
    h1: ({ children, animateText }: any) => (
        <h1 className="mb-3 mt-5 text-[22px] font-semibold leading-7 text-text-primary">{streamed(children, animateText)}</h1>
    ),
    h2: ({ children, animateText }: any) => (
        <h2 className="mb-3 mt-5 text-[19px] font-semibold leading-6 text-text-primary">{streamed(children, animateText)}</h2>
    ),
    h3: ({ children, animateText }: any) => (
        <h3 className="mb-2 mt-4 text-[17px] font-semibold leading-6 text-text-primary">{streamed(children, animateText)}</h3>
    ),
    h4: ({ children, animateText }: any) => (
        <h4 className="mb-2 mt-4 text-[16px] font-semibold leading-6 text-text-primary">{streamed(children, animateText)}</h4>
    ),
    ul: ({ children }: any) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
    ol: ({ children }: any) => <ol className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
    table: ({ children }: any) => (
        <div className="my-4 overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">{children}</table>
        </div>
    ),
    th: ({ children, animateText }: any) => (
        <th className="border border-border bg-bg-inset px-3 py-1.5 text-left font-semibold text-text-primary">{streamed(children, animateText)}</th>
    ),
    td: ({ children, animateText }: any) => (
        <td className="border border-border px-3 py-1.5 align-top text-text-primary">{streamed(children, animateText)}</td>
    ),
    hr: () => <hr className="my-5 border-t border-border" />,
    pre: ({ children }: any) => <>{children}</>,
    code: ({ className, children: codeChildren, animateText }: any) => {
        const text = String(codeChildren).replace(/\n$/, '');
        const match = /language-(\w+)/.exec(className ?? '');
        if (match !== null || text.includes('\n')) {
            return <CodeBlock language={match?.[1] ?? 'text'} code={text} />;
        }
        return (
            <code className="rounded-md bg-bg-inset px-1.5 py-0.5 font-mono text-[13px] text-text-primary">
                {streamed(codeChildren, animateText)}
            </code>
        );
    },
};

const MarkdownActiveContext = createContext(false);

/** Split a text node into word components; nested inline elements handle their own text. */
function AnimatedChildren({ children, active }: { children: ReactNode; active: boolean }) {
    const nodes = Array.isArray(children) ? children : [children];
    return (
        <>
            {nodes.map((child, index) => {
                if (typeof child === 'string') {
                    return <StreamWords key={index} text={child} active={active} />;
                }
                return child;
            })}
        </>
    );
}

/** Stable wrappers: function identity must not change across streamed deltas. */
function makeAnimatedComponent(component: any) {
    return function AnimatedComponent(props: any) {
        const active = useContext(MarkdownActiveContext);
        const animateText: AnimateText = useCallback(
            (children: unknown) => <AnimatedChildren active={active}>{children as ReactNode}</AnimatedChildren>,
            [active],
        );
        return component({ ...props, animateText });
    };
}

const ANIMATED_MARKDOWN_COMPONENTS = Object.fromEntries(
    Object.entries(MARKDOWN_COMPONENTS).map(([name, component]) => [name, makeAnimatedComponent(component)]),
);

/**
 * Streaming markdown, DeepSeek-harness style: ONE renderer while streaming and
 * after the turn settles (no animated/static swap, so the draft → durable
 * handoff never remounts the tree and never dumps). Text renders exactly as
 * the deltas have accumulated it; code blocks keep our CodeBlock chrome.
 */
export function StreamingMarkdown({ content }: { content: string; active?: boolean }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={ANIMATED_MARKDOWN_COMPONENTS}>
            {content}
        </ReactMarkdown>
    );
}

export function Markdown({ children, compact = false }: { children: string; streaming?: boolean; compact?: boolean }) {
    const className = compact ? 'text-[15px] leading-6 text-text-primary' : 'text-[16px] leading-6 text-text-primary';
    return (
        <div className={className}>
            <StreamingMarkdown content={children} />
        </div>
    );
}
