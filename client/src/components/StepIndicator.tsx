import React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, Loader2, AlertCircle, FileCode, Folder, Box, Eye, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface Step {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    details?: string;
}

interface StepIndicatorProps {
    steps: Step[];
}

export function cn(...inputs: (string | undefined | null | false)[]) {
    return twMerge(clsx(inputs));
}

const getIcon = (name: string, status: Step['status']) => {
    if (status === 'running') return <Loader2 size={14} className="animate-spin text-blue-500" />;
    if (status === 'error') return <AlertCircle size={14} className="text-red-500" />;

    const lowerName = name.toLowerCase();
    if (lowerName.includes('script')) return <FileCode size={14} className="text-gray-400" />;
    if (lowerName.includes('folder')) return <Folder size={14} className="text-gray-400" />;
    if (lowerName.includes('part') || lowerName.includes('instance')) return <Box size={14} className="text-gray-400" />;
    if (lowerName.includes('read') || lowerName.includes('get')) return <Eye size={14} className="text-gray-400" />;

    return <Settings size={14} className="text-gray-400" />;
};

export const StepIndicator: React.FC<StepIndicatorProps> = ({ steps }) => {
    if (steps.length === 0) return null;

    return (
        <div className="flex flex-col gap-2 my-4 ml-12">
            {steps.map((step) => (
                <motion.div
                    key={step.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={cn(
                        "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm w-fit shadow-sm transition-all",
                        step.status === 'running' ? "bg-blue-50/50 border-blue-100 text-blue-700" :
                            step.status === 'error' ? "bg-red-50 border-red-100 text-red-700" :
                                "bg-gray-100/50 border-gray-200 text-gray-600"
                    )}
                >
                    {getIcon(step.name, step.status)}
                    <span className="font-medium">
                        {step.name.replace(/_/g, ' ')}
                        {step.status === 'completed' && <CheckCircle2 size={14} className="inline ml-1 text-green-500" />}
                    </span>
                    {step.details && step.status === 'error' && (
                        <span className="text-xs text-red-400 ml-1">({step.details})</span>
                    )}
                </motion.div>
            ))}
        </div>
    );
};
