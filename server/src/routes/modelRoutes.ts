import { Router } from 'express';
import { llmManager } from '../services/LLMManager';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';
    const models = await llmManager.getModels(refresh);
    res.json(models);
  } catch (error) {
    console.error('Model fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

export default router;
