import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, ChevronDown, ChevronUp, RotateCcw, AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface MessageProps {
    role: 'user' | 'assistant' | 'model' | 'system';
    content: string;
    calls?: {
        name: string;
        args: any;
        result?: string;
        status: 'running' | 'done' | 'error';
    }[];
    isError?: boolean;
    errorNote?: string;
    isLast?: boolean;
    isLoading?: boolean;
    onRegenerate?: () => void;
}

export const Message: React.FC<MessageProps> = ({ role, content, calls, isError, errorNote, isLast, isLoading, onRegenerate }) => {
    const [copied, setCopied] = React.useState(false);
    const [expandedCalls, setExpandedCalls] = React.useState<Record<number, boolean>>({});

    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const toggleCall = (idx: number) => {
        setExpandedCalls(prev => ({ ...prev, [idx]: !prev[idx] }));
    };

    const isAssistant = role === 'assistant' || role === 'model';
    const isThinking = isLoading && isAssistant && !content && !calls?.length;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
                "group flex w-full gap-4 py-5 px-4 transition-all",
                role === 'user' ? "justify-end" : "justify-start"
            )}
        >
            <div className={cn(
                "flex max-w-[85%] md:max-w-[75%] gap-4",
                role === 'user' ? "flex-row-reverse" : "flex-row w-full max-w-none md:max-w-none"
            )}>
                {/* Avatar (only for assistant, ChatGPT style) */}
                {isAssistant && (
                    <div className={cn(
                        "flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full border transition-colors mt-0.5",
                        isError
                            ? "bg-red-500/10 text-red-500 border-red-500/30"
                            : "bg-surface-card text-text-main border-surface-border"
                    )}>
                        {isError ? <AlertCircle size={16} /> : <span className="font-bold text-[14px]">M</span>}
                    </div>
                )}

                <div className={cn(
                    "flex-1 space-y-2 overflow-hidden",
                    role === 'user' ? "flex flex-col items-end" : "min-w-0"
                )}>
                    {/* Thinking indicator */}
                    {isThinking && (
                        <div className="flex items-center gap-2.5 py-2 w-fit">
                            <span className="flex gap-1">
                                <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0 }} className="h-2 w-2 bg-text-muted rounded-full" />
                                <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0.2 }} className="h-2 w-2 bg-text-muted rounded-full" />
                                <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0.4 }} className="h-2 w-2 bg-text-muted rounded-full" />
                            </span>
                        </div>
                    )}

                    {/* Message content */}
                    {!isThinking && (
                        <div className={cn(
                            "text-[15px] leading-relaxed",
                            isError && role === 'user'
                                ? "bg-red-950/30 border border-red-800/40 text-red-300 rounded-2xl px-5 py-3.5"
                                : role === 'user'
                                    ? "bg-surface-border/50 text-text-main rounded-2xl px-5 py-3.5 inline-block text-left"
                                    : "text-text-main pt-1" // No bubble for assistant
                        )}>
                            {/* Error icon row (assistant error) */}
                            {isError && isAssistant && (
                                <div className="flex items-center gap-2 mb-3 text-red-400">
                                    <AlertCircle size={14} />
                                    <span className="text-[12px] font-bold uppercase tracking-wider">Response Failed</span>
                                </div>
                            )}

                            {/* Tool calls */}
                            {calls && calls.length > 0 && (
                                <div className="space-y-2 mb-4 max-w-2xl">
                                    {calls.map((call, idx) => (
                                        <div key={idx} className="rounded-xl border border-surface-border bg-surface-sidebar/30 overflow-hidden shadow-sm">
                                            <button
                                                onClick={() => toggleCall(idx)}
                                                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-border/20 transition-all font-mono"
                                            >
                                                <div className="flex items-center gap-2.5">
                                                    {call.status === 'running' ? (
                                                        <Loader2 size={13} className="text-brand-primary animate-spin shrink-0" />
                                                    ) : call.status === 'done' ? (
                                                        <Check size={13} className="text-green-500 shrink-0" />
                                                    ) : (
                                                        <AlertCircle size={13} className="text-red-500 shrink-0" />
                                                    )}
                                                    <span className="text-[11px] font-semibold text-text-muted truncate">
                                                        {call.name === 'run_command' ? 'Executing terminal command' :
                                                            call.name === 'read_file' ? 'Reading file' :
                                                                call.name === 'write_file' ? 'Writing file' :
                                                                    call.name === 'search_web' ? 'Searching web' : `Using tool: ${call.name}`}
                                                    </span>
                                                </div>
                                                {expandedCalls[idx] ? <ChevronUp size={14} className="text-text-muted shrink-0" /> : <ChevronDown size={14} className="text-text-muted shrink-0" />}
                                            </button>

                                            <AnimatePresence>
                                                {expandedCalls[idx] && (
                                                    <motion.div
                                                        initial={{ height: 0, opacity: 0 }}
                                                        animate={{ height: 'auto', opacity: 1 }}
                                                        exit={{ height: 0, opacity: 0 }}
                                                        className="px-3 pb-3 border-t border-surface-border"
                                                    >
                                                        <div className="mt-3 space-y-3">
                                                            <div className="space-y-1.5">
                                                                <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Arguments</div>
                                                                <pre className="p-2.5 bg-surface-sidebar rounded-lg text-[11px] font-mono text-brand-primary overflow-x-auto border border-surface-border/50">
                                                                    {typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2)}
                                                                </pre>
                                                            </div>
                                                            {call.result && (
                                                                <div className="space-y-1.5">
                                                                    <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Result</div>
                                                                    <pre className="p-2.5 bg-surface-sidebar rounded-lg text-[11px] font-mono text-text-main overflow-x-auto whitespace-pre-wrap border border-surface-border/50 max-h-60 custom-scrollbar">
                                                                        {typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)}
                                                                    </pre>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Main prose content */}
                            <div className={cn("prose dark:prose-invert max-w-none", role === 'user' ? "text-text-main" : "")}>
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        code({ node, inline, className, children, ...props }: any) {
                                            const match = /language-(\w+)/.exec(className || '');
                                            return !inline && match ? (
                                                <div className="relative group/code my-5 rounded-xl overflow-hidden border border-surface-border shadow-sm bg-[#0d0d0d]">
                                                    <div className="absolute right-2 top-2 z-10">
                                                        <button
                                                            onClick={handleCopy}
                                                            className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white/70 hover:text-white px-2.5 py-1.5 rounded-lg backdrop-blur-md transition-all opacity-0 group-hover/code:opacity-100"
                                                        >
                                                            {copied ? <Check size={13} /> : <Copy size={13} />}
                                                            <span className="text-[11px] font-medium">{copied ? 'Copied!' : 'Copy'}</span>
                                                        </button>
                                                    </div>
                                                    <div className="bg-[#1a1a1a] px-4 py-2 border-b border-white/10 flex items-center justify-between">
                                                        <span className="text-[11px] font-medium text-white/50">{match[1]}</span>
                                                    </div>
                                                    <SyntaxHighlighter
                                                        style={vscDarkPlus}
                                                        language={match[1]}
                                                        PreTag="div"
                                                        className="!m-0 !bg-transparent !p-4 !text-[13px] font-mono leading-relaxed custom-scrollbar"
                                                        {...props}
                                                    >
                                                        {String(children).replace(/\n$/, '')}
                                                    </SyntaxHighlighter>
                                                </div>
                                            ) : (
                                                <code className={cn("bg-surface-border/50 text-text-main px-1.5 py-0.5 rounded-md font-mono text-[13px]", className)} {...props}>
                                                    {children}
                                                </code>
                                            );
                                        },
                                        p: ({ children }) => <p className="mb-4 last:mb-0 leading-loose">{children}</p>,
                                        ul: ({ children }) => <ul className="list-disc pl-5 mb-4 space-y-1.5">{children}</ul>,
                                        ol: ({ children }) => <ol className="list-decimal pl-5 mb-4 space-y-1.5">{children}</ol>,
                                        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                                        strong: ({ children }) => <strong className="font-semibold text-text-main">{children}</strong>,
                                    }}
                                >
                                    {content}
                                </ReactMarkdown>
                            </div>

                            {/* Error note after partial stream */}
                            {errorNote && (
                                <div className="mt-4 inline-flex items-start gap-2 p-3 rounded-xl bg-red-950/20 border border-red-800/30 text-red-400">
                                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-[11px] font-bold uppercase tracking-wider mb-0.5">Response interrupted</p>
                                        <p className="text-[13px] opacity-90">{errorNote}</p>
                                    </div>
                                </div>
                            )}

                            {/* Assistant Footer Actions (Copy / Regenerate) */}
                            {isAssistant && content && !isError && (
                                <div className="mt-3 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={handleCopy}
                                        className="p-1.5 rounded-md text-text-muted hover:text-text-main hover:bg-surface-border/50 transition-all"
                                        title="Copy response"
                                    >
                                        {copied ? <Check size={14} className="text-brand-primary" /> : <Copy size={14} />}
                                    </button>
                                    {isLast && !isLoading && !calls?.some(c => c.status === 'running') && (
                                        <button
                                            onClick={onRegenerate}
                                            className="p-1.5 rounded-md text-text-muted hover:text-text-main hover:bg-surface-border/50 transition-all"
                                            title="Regenerate response"
                                        >
                                            <RotateCcw size={14} />
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
};
