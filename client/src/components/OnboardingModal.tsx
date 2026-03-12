import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, ChevronLeft, Check, Sparkles, Layout, Terminal, Download, Github } from 'lucide-react';

interface OnboardingModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const SLIDES = [
    {
        title: "Welcome to Morphi Intelligence",
        description: "Your AI-powered orchestrator for Roblox Studio. Morphi helps you write code, design systems, and debug directly within your Studio environment.",
        visual: (
            <div className="w-full h-full bg-gradient-to-br from-brand-primary/20 to-surface-bg flex flex-col items-center justify-center relative overflow-hidden">
                <div className="absolute w-40 h-40 bg-brand-primary/20 blur-3xl rounded-full" />
                <div className="relative z-10 h-20 w-20 bg-surface-card border border-surface-border rounded-2xl shadow-xl flex items-center justify-center">
                    <Sparkles className="text-brand-primary" size={40} />
                </div>
                <div className="relative z-10 mt-6 text-center space-y-2">
                    <div className="h-1.5 w-24 bg-surface-border rounded-full mx-auto" />
                    <div className="h-1.5 w-16 bg-surface-border rounded-full mx-auto" />
                </div>
            </div>
        ),
        icon: <Sparkles className="text-brand-primary" size={24} />
    },
    {
        title: "Install the Studio Plugin",
        description: "To connect, you need the MCP plugin. Go to github.com/boshyxd/robloxstudio-mcp/releases, download the .rbxmx file, and drag it into Roblox Studio.",
        visual: (
            <div className="w-full h-full bg-surface-bg flex items-center justify-center p-4">
                <div className="w-full max-w-sm bg-surface-card border border-surface-border rounded-xl shadow-lg overflow-hidden flex flex-col">
                    <div className="bg-surface-sidebar px-3 py-2 border-b border-surface-border flex items-center gap-2">
                        <Github size={14} className="text-text-muted" />
                        <span className="text-[11px] font-mono text-text-muted">boshyxd / robloxstudio-mcp</span>
                    </div>
                    <div className="p-4 flex-1">
                        <div className="flex items-center justify-between mb-4">
                            <span className="text-sm font-bold text-text-main">Release v2.5.1</span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium">Latest</span>
                        </div>
                        <div className="space-y-2">
                            <a
                                href="https://github.com/boshyxd/robloxstudio-mcp/releases"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center justify-between p-2.5 rounded-lg border border-brand-primary/40 bg-brand-primary/5 hover:bg-brand-primary/10 transition-colors group cursor-pointer"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="p-1.5 bg-brand-primary/20 rounded-md"><Download size={14} className="text-brand-primary" /></div>
                                    <span className="text-xs font-semibold text-text-main">MCPPlugin.rbxmx</span>
                                </div>
                                <span className="text-[10px] font-medium text-brand-primary group-hover:underline">Download</span>
                            </a>
                            <div className="flex items-center justify-between p-2.5 rounded-lg border border-surface-border opacity-50">
                                <div className="flex items-center gap-3">
                                    <div className="p-1.5 bg-surface-border rounded-md"><Terminal size={14} className="text-text-muted" /></div>
                                    <span className="text-xs font-medium text-text-main">Source code (zip)</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        ),
        icon: <Layout className="text-brand-primary" size={24} />
    },
    {
        title: "Commands & Tools",
        description: "Just chat normally! Ask Morphi to 'Create a kill brick' or 'Fix the error in MyScript'. Morphi will automatically use tools to read and write to your game.",
        visual: (
            <div className="w-full h-full bg-surface-bg flex flex-col justify-end p-4 pb-6">
                <div className="flex flex-col gap-3 w-full max-w-[280px] mx-auto">
                    <div className="self-end bg-brand-primary/20 border border-brand-primary/30 text-text-main text-[11px] px-3 py-2 rounded-2xl rounded-tr-sm">
                        Create a red kill brick at spawn
                    </div>
                    <div className="self-start relative bg-surface-card border border-surface-border text-text-main text-[11px] px-3 py-2.5 rounded-2xl rounded-tl-sm shadow-sm leading-relaxed">
                        <span className="flex items-center gap-1.5 text-brand-primary mb-1.5">
                            <Sparkles size={10} /> <span className="text-[9px] uppercase font-bold tracking-wider">Morphi</span>
                        </span>
                        I've inserted a Script inside a new red Part at the spawn location. It will damage players on touch!
                    </div>
                </div>
            </div>
        ),
        icon: <Terminal className="text-brand-primary" size={24} />
    }
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ isOpen, onClose }) => {
    const [currentSlide, setCurrentSlide] = useState(0);

    // Reset slide when opened
    useEffect(() => {
        if (isOpen) setCurrentSlide(0);
    }, [isOpen]);

    if (!isOpen) return null;

    const slide = SLIDES[currentSlide];
    const isLast = currentSlide === SLIDES.length - 1;

    const handleNext = () => {
        if (isLast) onClose();
        else setCurrentSlide(prev => prev + 1);
    };

    const handlePrev = () => {
        if (currentSlide > 0) setCurrentSlide(prev => prev - 1);
    };

    return (
        <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={onClose}
                className="absolute inset-0 bg-black/40 dark:bg-black/80 backdrop-blur-xl"
            />
            <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                className="bg-surface-card border border-white/10 w-full max-w-2xl rounded-[32px] shadow-2xl overflow-hidden flex flex-col relative z-10"
            >
                {/* Header */}
                <div className="flex justify-between items-center px-10 py-8 border-b border-white/5 bg-gradient-to-br from-brand-primary/10 via-transparent to-transparent">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-brand-primary/20 rounded-xl text-brand-primary">
                            {slide.icon}
                        </div>
                        <h2 className="text-xl font-bold text-text-main tracking-tight">Getting Started</h2>
                    </div>
                    <button onClick={onClose} className="p-3 hover:bg-white/5 rounded-2xl transition-all text-text-muted hover:text-text-main group">
                        <X size={24} className="group-hover:rotate-90 transition-transform duration-300" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 relative overflow-hidden min-h-[380px] flex flex-col">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={currentSlide}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            transition={{ duration: 0.2 }}
                            className="flex-1 flex flex-col items-center text-center w-full"
                        >
                            <div className="w-full h-[220px] rounded-xl border border-surface-border shadow-md mb-6 overflow-hidden">
                                {slide.visual}
                            </div>
                            <h3 className="text-2xl font-bold text-text-main mb-3">{slide.title}</h3>
                            <p className="text-text-muted max-w-lg leading-relaxed text-sm">{slide.description}</p>
                        </motion.div>
                    </AnimatePresence>
                </div>

                {/* Footer Controls */}
                <div className="flex items-center justify-between px-10 py-6 border-t border-white/5 bg-black/20">
                    {/* Dots indicator */}
                    <div className="flex items-center gap-2 pl-2">
                        {SLIDES.map((_, i) => (
                            <div
                                key={i}
                                className={`h-2 rounded-full transition-all duration-300 ${i === currentSlide ? 'w-6 bg-brand-primary' : 'w-2 bg-surface-border'}`}
                            />
                        ))}
                    </div>

                    <div className="flex gap-2">
                        <button
                            onClick={handlePrev}
                            disabled={currentSlide === 0}
                            className={`px-4 py-2 rounded-lg font-semibold flex items-center gap-1 transition-all
                                ${currentSlide === 0 ? 'text-text-muted/50 cursor-not-allowed' : 'text-text-main hover:bg-surface-border/50'}`}
                        >
                            <ChevronLeft size={16} /> Back
                        </button>
                        <button
                            onClick={handleNext}
                            className="px-6 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/90 text-white font-semibold flex items-center gap-1 transition-all shadow-lg shadow-brand-primary/20"
                        >
                            {isLast ? (
                                <>Get Started <Check size={16} /></>
                            ) : (
                                <>Next <ChevronRight size={16} /></>
                            )}
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};
