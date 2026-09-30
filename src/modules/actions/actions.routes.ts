import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { ACTION_STATUSES } from '../../models/action.model.js';
import { ConflictError } from '../../utils/errors.js';
import { announceDecision } from './approvals.js';
import {
  approveAction,
  type DecisionOutcome,
  listActions,
  rejectAction,
  toPublicAction,
} from './actions.service.js';

export const actionsRouter = Router();

actionsRouter.use(requireAuth);

export const actionListQuerySchema = z.object({
  status: z.enum(ACTION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});

/** The activity log, newest first. */
actionsRouter.get('/', validate({ query: actionListQuerySchema }), async (req, res) => {
  const { status, limit, before } = res.locals.validated?.query as z.infer<
    typeof actionListQuerySchema
  >;
  const actions = await listActions(getAuthUser(req)._id, {
    status,
    limit,
    before: before ? new Date(before) : undefined,
  });
  res.json({ actions: actions.map(toPublicAction) });
});

const MESSAGES: Partial<Record<DecisionOutcome, string>> = {
  expired: 'This request expired',
  already_decided: 'This request was already answered',
};

for (const decision of ['approve', 'reject'] as const) {
  actionsRouter.post(`/:id/${decision}`, async (req, res) => {
    const user = getAuthUser(req);
    const run = decision === 'approve' ? approveAction : rejectAction;
    const { action, outcome } = await run(user._id, req.params.id, 'web');
    const conflict = MESSAGES[outcome];
    if (conflict) throw new ConflictError(conflict);
    await announceDecision(action, outcome);
    res.json({ action: toPublicAction(action), outcome });
  });
}
