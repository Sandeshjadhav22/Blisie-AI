import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../../middleware/require-auth.js';
import { validate } from '../../../middleware/validate.js';
import { completeTask, createTask, listTasks, updateTask } from './tasks.service.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be YYYY-MM-DD' });
export const taskIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) });

export const listQuerySchema = z.object({
  includeCompleted: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
});

tasksRouter.get('/', validate({ query: listQuerySchema }), async (req, res) => {
  const { includeCompleted } = res.locals.validated?.query as z.infer<typeof listQuerySchema>;
  res.json({ tasks: await listTasks(getAuthUser(req)._id, { includeCompleted }) });
});

export const createSchema = z
  .object({
    title: z.string().trim().min(1).max(1024),
    notes: z.string().max(8192).optional(),
    due: dueDate.optional(),
  })
  .strict();

tasksRouter.post('/', validate({ body: createSchema }), async (req, res) => {
  const input = res.locals.validated?.body as z.infer<typeof createSchema>;
  res.status(201).json({ task: await createTask(getAuthUser(req)._id, input) });
});

export const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(1024).optional(),
    notes: z.string().max(8192).optional(),
    due: dueDate.nullable().optional(),
    status: z.enum(['needsAction', 'completed']).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to update');

tasksRouter.patch(
  '/:id',
  validate({ params: taskIdSchema, body: updateSchema }),
  async (req, res) => {
    const { id } = res.locals.validated?.params as z.infer<typeof taskIdSchema>;
    const patch = res.locals.validated?.body as z.infer<typeof updateSchema>;
    res.json({ task: await updateTask(getAuthUser(req)._id, id, patch) });
  },
);

tasksRouter.post('/:id/complete', validate({ params: taskIdSchema }), async (req, res) => {
  const { id } = res.locals.validated?.params as z.infer<typeof taskIdSchema>;
  res.json({ task: await completeTask(getAuthUser(req)._id, id) });
});
