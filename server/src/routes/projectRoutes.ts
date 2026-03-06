import { Router } from 'express';
import { memoryService } from '../services/MemoryService';

const router = Router();

router.get('/', (req, res) => {
    res.json(memoryService.getProjects());
});

router.post('/', (req, res) => {
    const { name, description } = req.body;
    res.json(memoryService.createProject(name || 'New Project', description));
});

router.delete('/:id', (req, res) => {
    memoryService.deleteProject(req.params.id);
    res.json({ success: true });
});

router.get('/:id/sessions', (req, res) => {
    res.json(memoryService.getSessionsByProject(req.params.id));
});

export default router;
