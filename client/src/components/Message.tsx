import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, ChevronDown, ChevronUp, RotateCcw, AlertCircle, AlertTriangle, Loader2, Sparkles, Eye, FileText, Circle, CheckCircle2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface MessageProps {
    role: 'user' | 'assistant' | 'model' | 'system';
    content: string;
    thought?: string;
    steps?: {
        type: 'text' | 'call';
        content?: string;
        name?: string;
        args?: any;
        result?: string;
        status?: 'running' | 'done' | 'error';
    }[];
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

export const Message: React.FC<MessageProps> = ({ role, content, thought, steps, calls, isError, errorNote, isLast, isLoading, onRegenerate }) => {
    const [copied, setCopied] = React.useState(false);
    const [expandedCalls, setExpandedCalls] = React.useState<Record<string, boolean>>({});
    const [thoughtExpanded, setThoughtExpanded] = React.useState(true);

    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const toggleCall = (id: string) => {
        setExpandedCalls(prev => ({ ...prev, [id]: !prev[id] }));
    };

    const isAssistant = role === 'assistant' || role === 'model';

    const renderMarkdown = (text: string) => (
        <div className={cn("prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-li:my-1", role === 'user' ? "text-text-main" : "")}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        return !inline && match ? (
                            <div className="relative group/code my-6 rounded-xl overflow-hidden border border-surface-border shadow-md bg-[#0d0d0d]">
                                <div className="absolute right-3 top-3 z-10">
                                    <button
                                        onClick={() => {
                                            navigator.clipboard.writeText(String(children));
                                            setCopied(true);
                                            setTimeout(() => setCopied(false), 2000);
                                        }}
                                        className="flex items-center gap-1.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white px-2.5 py-1.5 rounded-lg backdrop-blur-md transition-all border border-white/10 opacity-0 group-hover/code:opacity-100 shadow-lg"
                                    >
                                        {copied ? <Check size={13} className="text-brand-primary" /> : <Copy size={13} />}
                                        <span className="text-[11px] font-medium">{copied ? 'Copied!' : 'Copy'}</span>
                                    </button>
                                </div>
                                <div className="bg-[#1a1a1a] px-4 py-2.5 border-b border-white/5 flex items-center justify-between">
                                    <span className="text-[11px] font-bold text-white/40 uppercase tracking-widest">{match[1]}</span>
                                </div>
                                <SyntaxHighlighter
                                    style={vscDarkPlus}
                                    language={match[1]}
                                    PreTag="div"
                                    className="!m-0 !bg-transparent !p-5 !text-[13px] font-mono leading-relaxed custom-scrollbar"
                                    {...props}
                                >
                                    {String(children).replace(/\n$/, '')}
                                </SyntaxHighlighter>
                            </div>
                        ) : (
                            <code className={cn("bg-surface-border/30 text-brand-primary px-1.5 py-0.5 rounded-md font-mono text-[13px] border border-surface-border/50", className)} {...props}>
                                {children}
                            </code>
                        );
                    },
                    p: ({ children }) => <p className="mb-5 last:mb-0 leading-loose opacity-[0.98]">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc pl-6 mb-5 space-y-2.5">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal pl-6 mb-5 space-y-2.5">{children}</ol>,
                    li: ({ children }) => <li className="leading-relaxed opacity-[0.98]">{children}</li>,
                    strong: ({ children }) => <strong className="font-bold text-text-main border-b border-brand-primary/30">{children}</strong>,
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );

    const renderToolCall = (call: any, idx: number | string) => {
        const id = `call-${idx}`;
        const isTask = call.name === 'create_task';
        const isDone = isTask && (call.args?.status === 'done' || call.status === 'done');

        let Icon = isTask ? FileText : Eye;
        if (isTask) {
            Icon = isDone ? CheckCircle2 : Circle;
        }

        return (
            <div key={id} className={cn(
                "rounded-xl border border-surface-border bg-surface-sidebar/30 overflow-hidden shadow-sm my-4 max-w-2xl",
                isTask ? "border-l-4 border-l-emerald-500/50 bg-emerald-500/5" : "border-l-2 border-l-brand-primary/30",
                isDone && "opacity-75 grayscale-[0.2]"
            )}>
                <button
                    onClick={() => toggleCall(id)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-border/20 transition-all font-mono"
                >
                    <div className="flex items-center gap-2.5">
                        {call.status === 'running' ? (
                            <Loader2 size={13} className="text-brand-primary animate-spin shrink-0" />
                        ) : (
                            <Icon size={14} className={cn(
                                isTask ? (isDone ? "text-emerald-500" : "text-text-muted") : "text-brand-primary",
                                "shrink-0"
                            )} />
                        )}
                        <span className={cn(
                            "text-[11px] font-semibold text-text-muted truncate uppercase tracking-tight opacity-80",
                            isDone && "line-through opacity-50"
                        )}>
                            {(() => {
                                if (isTask) return call.args?.title || 'Task';

                                const rawName = call.name;
                                const cleanName = rawName.replace(/^mcp__robloxstudio__/, '');

                                const labelMap: Record<string, string> = {
                                    'run_command': 'Executing terminal command',
                                    'read_file': 'Reading file',
                                    'write_file': 'Writing file',
                                    'search_web': 'Searching web',
                                    'get_project_structure': 'Analyzing project structure',
                                    'get_file_tree': 'Exploring file tree',
                                    'start_playtest': 'Starting playtest',
                                    'get_playtest_output': 'Reading playtest output',
                                    'lint_luau': 'Linting Luau code',
                                    'get_services': 'Inspecting game services',
                                    'get_selection': 'Checking selection',
                                    'get_instance_children': 'Exploring children',
                                    'get_instance_properties': 'Reading properties',
                                    'set_property': 'Updating property',
                                    'mass_set_property': 'Batch updating properties',
                                    'set_script_source': 'Updating script source',
                                    'edit_script_lines': 'Editing script content',
                                    'insert_script_lines': 'Adding script code',
                                    'execute_luau': 'Executing Luau code',
                                    'create_object': 'Creating object',
                                    'delete_object': 'Deleting object',
                                    'search_objects': 'Locating objects'
                                };

                                return labelMap[cleanName] || labelMap[rawName] || `Using tool: ${cleanName.replace(/_/g, ' ')}`;
                            })()}
                        </span>
                    </div>
                    {expandedCalls[id] ? <ChevronUp size={14} className="text-text-muted shrink-0" /> : <ChevronDown size={14} className="text-text-muted shrink-0" />}
                </button>

                <AnimatePresence>
                    {expandedCalls[id] && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="px-3 pb-3 border-t border-surface-border/50"
                        >
                            <div className="mt-3 space-y-3">
                                <div className="space-y-1.5">
                                    <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider pl-1">Arguments</div>
                                    <pre className="p-3 bg-[#0d0d0d] rounded-lg text-[11px] font-mono text-emerald-400 overflow-x-auto border border-surface-border/50 shadow-inner">
                                        {typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2)}
                                    </pre>
                                </div>
                                {call.result && (
                                    <div className="space-y-1.5">
                                        <div className="text-[10px] font-bold text-text-muted uppercase tracking-wider pl-1">Result</div>
                                        <pre className="p-3 bg-[#111111] rounded-lg text-[11px] font-mono text-gray-200 overflow-x-auto whitespace-pre-wrap border border-surface-border/50 max-h-60 custom-scrollbar shadow-inner">
                                            {typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    };

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
                {/* Avatar (only for assistant) */}
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
                    {/* Message content */}
                    <div className={cn(
                        "text-[15px] leading-relaxed",
                        isError && role === 'user'
                            ? "bg-red-950/30 border border-red-800/40 text-red-300 rounded-2xl px-5 py-3.5"
                            : role === 'user'
                                ? "bg-surface-border/50 text-text-main rounded-2xl px-5 py-3.5 inline-block text-left"
                                : "text-text-main pt-1"
                    )}>
                        {/* Error icon row (assistant error) */}
                        {isError && isAssistant && (
                            <div className="flex items-center gap-2 mb-3 text-red-400">
                                <AlertCircle size={14} />
                                <span className="text-[12px] font-bold uppercase tracking-wider">Response Failed</span>
                            </div>
                        )}

                        {/* Thought block */}
                        {thought && (
                            <div className="mb-4 rounded-xl border border-surface-border bg-gradient-to-br from-surface-sidebar/50 to-surface-sidebar/20 overflow-hidden shadow-sm backdrop-blur-sm">
                                <button
                                    onClick={() => setThoughtExpanded(!thoughtExpanded)}
                                    className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 hover:bg-surface-border/20 transition-all font-mono group/thought"
                                >
                                    <div className="flex items-center gap-2.5">
                                        <Sparkles size={13} className="text-brand-primary shrink-0 opacity-80 group-hover/thought:opacity-100 transition-opacity" />
                                        <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider animate-shiny group-hover/thought:brightness-110">
                                            Thinking...
                                        </span>
                                    </div>
                                    {thoughtExpanded ? <ChevronUp size={14} className="text-text-muted shrink-0" /> : <ChevronDown size={14} className="text-text-muted shrink-0" />}
                                </button>

                                <AnimatePresence>
                                    {thoughtExpanded && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            className="px-4 py-3 border-t border-surface-border/50"
                                        >
                                            <div className="prose dark:prose-invert max-w-none text-[13px] text-text-muted italic opacity-90 leading-relaxed">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{thought}</ReactMarkdown>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        )}

                        {/* Sequential Message steps (Interleaved text & tools) */}
                        {steps && steps.length > 0 ? (
                            <div className="space-y-2">
                                {steps.map((step, idx) => (
                                    <div key={idx}>
                                        {step.type === 'text' && step.content ? (
                                            renderMarkdown(step.content)
                                        ) : step.type === 'call' ? (
                                            renderToolCall(step, idx)
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <>
                                {/* Legacy Fallback: Tool calls then Main Content */}
                                {calls && calls.length > 0 && (
                                    <div className="space-y-2.5 mb-5 max-w-2xl">
                                        {calls.map((call, idx) => renderToolCall(call, `legacy-${idx}`))}
                                    </div>
                                )}
                                {content && renderMarkdown(content)}
                            </>
                        )}

                        {/* Thinking indicator at bottom while loading */}
                        {isLoading && isAssistant && (
                            <div className="flex items-center gap-3 py-2 w-fit mt-1">
                                <div className="flex gap-1.5 px-3 py-1.5 bg-surface-sidebar/50 rounded-full border border-surface-border/30 shadow-inner">
                                    <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest animate-shiny mr-1">Thinking</span>
                                    <div className="flex gap-1 items-center">
                                        <motion.span animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0 }} className="h-1.5 w-1.5 bg-brand-primary/60 rounded-full" />
                                        <motion.span animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0.2 }} className="h-1.5 w-1.5 bg-brand-primary/60 rounded-full" />
                                        <motion.span animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1.4, delay: 0.4 }} className="h-1.5 w-1.5 bg-brand-primary/60 rounded-full" />
                                    </div>
                                </div>
                            </div>
                        )}

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
                </div>
            </div>
        </motion.div>
    );
};
