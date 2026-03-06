import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Edit3, Save, X, Lightbulb, StickyNote } from 'lucide-react';
import type { Note } from '../types';

interface NotesManagerProps {
    onNotesUpdated?: () => void;
}

export const NotesManager: React.FC<NotesManagerProps> = ({ onNotesUpdated }) => {
    const [notes, setNotes] = useState<Note[]>([]);
    const [isAdding, setIsAdding] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [newNote, setNewNote] = useState({ title: '', content: '' });

    const fetchNotes = async () => {
        try {
            const res = await fetch('http://localhost:3000/api/notes');
            const data = await res.json();
            setNotes(data);
        } catch (e) {
            console.error(e);
        }
    };

    useEffect(() => {
        fetchNotes();
    }, []);

    const handleAdd = async () => {
        if (!newNote.title || !newNote.content) return;
        try {
            await fetch('http://localhost:3000/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newNote)
            });
            setNewNote({ title: '', content: '' });
            setIsAdding(false);
            fetchNotes();
            onNotesUpdated?.();
        } catch (e) {
            console.error(e);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await fetch(`http://localhost:3000/api/notes/${id}`, { method: 'DELETE' });
            fetchNotes();
            onNotesUpdated?.();
        } catch (e) {
            console.error(e);
        }
    };

    const handleUpdate = async (id: string) => {
        const note = notes.find(n => n.id === id);
        if (!note) return;
        try {
            await fetch(`http://localhost:3000/api/notes/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: note.title, content: note.content })
            });
            setEditingId(null);
            onNotesUpdated?.();
        } catch (e) {
            console.error(e);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-500/10 rounded-xl">
                        <StickyNote size={18} className="text-indigo-400" />
                    </div>
                    <div className="text-xs font-black text-white uppercase tracking-widest">Intelligence Pool</div>
                </div>
                <button
                    onClick={() => setIsAdding(true)}
                    className="p-2 hover:bg-white/5 text-surface-500 hover:text-white rounded-xl transition-all"
                >
                    <Plus size={18} />
                </button>
            </div>

            <div className="space-y-4 max-h-[300px] overflow-y-auto px-1 custom-scrollbar">
                <AnimatePresence mode="popLayout">
                    {isAdding && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="bg-white/[0.03] border border-indigo-500/20 p-5 rounded-3xl space-y-4"
                        >
                            <input
                                placeholder="Rule Title (e.g. Naming Convention)"
                                value={newNote.title}
                                onChange={e => setNewNote({ ...newNote, title: e.target.value })}
                                className="w-full bg-transparent border-b border-white/10 pb-2 text-[11px] font-black text-white focus:outline-none focus:border-indigo-500 transition-colors uppercase"
                            />
                            <textarea
                                placeholder="Describe the instruction or knowledge..."
                                value={newNote.content}
                                onChange={e => setNewNote({ ...newNote, content: e.target.value })}
                                className="w-full bg-transparent text-[11px] font-bold text-surface-400 focus:outline-none min-h-[80px] resize-none leading-relaxed"
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setIsAdding(false)}
                                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-white rounded-2xl transition-all font-black uppercase tracking-widest text-[9px]"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleAdd}
                                    className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl transition-all font-black uppercase tracking-widest text-[9px] shadow-lg shadow-indigo-900/20"
                                >
                                    Infuse
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {notes.map(note => (
                        <motion.div
                            key={note.id}
                            layout
                            className="group bg-white/[0.02] border border-white/5 p-5 rounded-3xl hover:border-white/10 transition-all flex items-start gap-4"
                        >
                            <div className="p-2 bg-white/5 rounded-xl mt-0.5">
                                <Lightbulb size={14} className="text-surface-500 group-hover:text-yellow-500 transition-colors" />
                            </div>
                            <div className="flex-1 min-w-0">
                                {editingId === note.id ? (
                                    <div className="space-y-3">
                                        <input
                                            value={note.title}
                                            onChange={e => setNotes(notes.map(n => n.id === note.id ? { ...n, title: e.target.value } : n))}
                                            className="w-full bg-transparent border-b border-white/10 pb-1 text-[11px] font-black text-white focus:outline-none"
                                        />
                                        <textarea
                                            value={note.content}
                                            onChange={e => setNotes(notes.map(n => n.id === note.id ? { ...n, content: e.target.value } : n))}
                                            className="w-full bg-transparent text-[11px] font-bold text-surface-400 focus:outline-none min-h-[60px] resize-none"
                                        />
                                        <div className="flex gap-2">
                                            <button onClick={() => setEditingId(null)} className="p-2 hover:bg-white/5 rounded-lg text-surface-500"><X size={14} /></button>
                                            <button onClick={() => handleUpdate(note.id)} className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg hover:bg-indigo-600/30"><Save size={14} /></button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className="text-[10px] font-black text-white uppercase tracking-wider mb-1 truncate">{note.title}</div>
                                        <p className="text-[11px] font-bold text-surface-500 leading-normal line-clamp-2">{note.content}</p>
                                    </>
                                )}
                            </div>
                            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                                <button onClick={() => setEditingId(note.id)} className="p-2 hover:bg-white/5 rounded-xl transition-colors text-surface-500 hover:text-white">
                                    <Edit3 size={14} />
                                </button>
                                <button onClick={() => handleDelete(note.id)} className="p-2 hover:bg-red-500/10 rounded-xl transition-colors text-surface-500 hover:text-red-400">
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </motion.div>
                    ))}
                </AnimatePresence>

                {notes.length === 0 && !isAdding && (
                    <div className="text-center py-10 opacity-30">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-surface-500">Zero Intelligence Clusters found</p>
                    </div>
                )}
            </div>
        </div>
    );
};
