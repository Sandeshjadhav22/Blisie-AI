import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import {
  deleteMemory,
  listMemories,
  saveMemory,
  toPublicMemory,
  updateMemory,
} from './memory.service.js';

export const memoriesRouter = Router();

memoriesRouter.use(requireAuth);

const memorySchema = z
  .object({
    content: z.string().trim().min(1).max(1000),
    subject: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

memoriesRouter.get('/', async (req, res) => {
  const memories = await listMemories(getAuthUser(req)._id);
  res.json({ memories: memories.map(toPublicMemory) });
});

memoriesRouter.post('/', validate({ body: memorySchema }), async (req, res) => {
  const input = res.locals.validated?.body as z.infer<typeof memorySchema>;
  const memory = await saveMemory(getAuthUser(req)._id, { ...input, source: 'user' });
  res.status(201).json({ memory: toPublicMemory(memory) });
});

memoriesRouter.patch('/:id', validate({ body: memorySchema }), async (req, res) => {
  const input = res.locals.validated?.body as z.infer<typeof memorySchema>;
  const memory = await updateMemory(getAuthUser(req)._id, String(req.params.id), input);
  res.json({ memory: toPublicMemory(memory) });
});

memoriesRouter.delete('/:id', async (req, res) => {
  await deleteMemory(getAuthUser(req)._id, req.params.id);
  res.status(204).end();
});
