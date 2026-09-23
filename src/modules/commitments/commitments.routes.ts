import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { COMMITMENT_DIRECTIONS, COMMITMENT_STATUSES } from '../../models/commitment.model.js';
import {
  listCommitments,
  recordCommitment,
  setCommitmentStatus,
  toPublicCommitment,
  updateCommitment,
} from './commitments.service.js';

export const commitmentsRouter = Router();

commitmentsRouter.use(requireAuth);

export const listQuerySchema = z.object({
  status: z.enum(COMMITMENT_STATUSES).optional(),
  direction: z.enum(COMMITMENT_DIRECTIONS).optional(),
  dueWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  person: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

commitmentsRouter.get('/', validate({ query: listQuerySchema }), async (req, res) => {
  const filters = res.locals.validated?.query as z.infer<typeof listQuerySchema>;
  const commitments = await listCommitments(getAuthUser(req)._id, filters);
  res.json({ commitments: commitments.map(toPublicCommitment) });
});

export const createSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    direction: z.enum(COMMITMENT_DIRECTIONS).default('outgoing'),
    person: z
      .object({ name: z.string().trim().max(100).optional(), email: z.email().optional() })
      .optional(),
    dueAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    dueText: z.string().trim().max(100).optional(),
  })
  .strict();

commitmentsRouter.post('/', validate({ body: createSchema }), async (req, res) => {
  const input = res.locals.validated?.body as z.infer<typeof createSchema>;
  const commitment = await recordCommitment(getAuthUser(req)._id, { ...input, source: 'user' });
  res.status(201).json({ commitment: commitment ? toPublicCommitment(commitment) : null });
});

export const patchSchema = z
  .object({
    status: z.enum(COMMITMENT_STATUSES).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    dueAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .nullable()
      .optional(),
    dueText: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to update');

commitmentsRouter.patch('/:id', validate({ body: patchSchema }), async (req, res) => {
  const { status, ...rest } = res.locals.validated?.body as z.infer<typeof patchSchema>;
  const userId = getAuthUser(req)._id;
  const id = String(req.params.id);
  if (Object.keys(rest).length > 0) await updateCommitment(userId, id, rest);
  const commitment = status
    ? await setCommitmentStatus(userId, id, status)
    : await updateCommitment(userId, id, rest);
  res.json({ commitment: toPublicCommitment(commitment) });
});
