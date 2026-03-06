import { Router } from 'express';
import { memoryService } from '../services/MemoryService';

const router = Router();

// Sessions (Project-scoped via body or query)
router.get('/sessions', (req, res) => {
    const { projectId } = req.query;
    if (projectId) {
        return res.json(memoryService.getSessionsByProject(projectId as string));
    }
    // Fallback or list all (mapped for frontend)
    const sessions = memoryService.getAllSessions().map((s: any) => ({
        ...s,
        messages: s.messages.map((m: any) => ({
            role: m.role,
            content: m.parts && m.parts[0] ? m.parts[0].text : ''
        }))
    }));
    res.json(sessions);
});

router.post('/sessions', (req, res) => {
    const { title, projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const session = memoryService.createSession(projectId, title);
    res.json(session);
});

router.delete('/sessions/:id', (req, res) => {
    memoryService.deleteSession(req.params.id);
    res.json({ success: true });
});

router.post('/sessions/:id/pin', (req, res) => {
    memoryService.togglePin(req.params.id);
    res.json({ success: true });
});

// Notes
router.get('/notes', (req, res) => res.json(memoryService.getNotes()));
router.post('/notes', (req, res) => {
    const { title, content } = req.body;
    res.json(memoryService.addNote(title, content));
});
router.put('/notes/:id', (req, res) => {
    const { title, content } = req.body;
    memoryService.updateNote(req.params.id, title, content);
    res.json({ success: true });
});
router.delete('/notes/:id', (req, res) => {
    memoryService.deleteNote(req.params.id);
    res.json({ success: true });
});

// Memory Management
router.get('/memory/stats', (req, res) => res.json(memoryService.getStats()));
router.delete('/memory', (req, res) => {
    memoryService.clearAll();
    res.json({ success: true });
});

export default router;