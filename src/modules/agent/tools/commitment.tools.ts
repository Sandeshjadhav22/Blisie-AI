import { z } from 'zod';

import { COMMITMENT_DIRECTIONS } from '../../../models/commitment.model.js';
import {
  listCommitments,
  recordCommitment,
  setCommitmentStatus,
} from '../../commitments/commitments.service.js';
import { formatLocal, LOCAL_DATE_TIME, localDateTimeToUtc } from './format.js';
import { defineTool, ToolError } from './types.js';

export const getCommitments = defineTool({
  name: 'get_commitments',
  description:
    "Lists promises: what the user owes people (outgoing) or what people owe them (incoming). Use for 'what did I promise', 'what am I forgetting', 'who owes me', 'what did I promise Rahul'.",
  risk: 'READ',
  schema: z.object({
    direction: z
      .enum(COMMITMENT_DIRECTIONS)
      .optional()
      .describe(
        'outgoing = the user promised; incoming = someone promised the user. Default: both.',
      ),
    status: z.enum(['pending', 'completed']).optional().describe('Default: pending.'),
    person: z.string().max(100).optional().describe("Filter by the other person's name or email."),
    dueWithinDays: z
      .number()
      .int()
      .min(0)
      .max(90)
      .optional()
      .describe('Only those due within N days (includes overdue).'),
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Only those noticed in the last N days, e.g. 7 for "this week".'),
  }),
  async execute({ user, now }, args) {
    const commitments = await listCommitments(
      user._id,
      { ...args, status: args.status ?? 'pending', limit: 50 },
      now,
    );
    return {
      commitments: commitments.map((commitment) => ({
        id: commitment.id,
        direction: commitment.direction,
        what: commitment.description,
        who: commitment.person?.name ?? commitment.person?.email ?? null,
        due: commitment.dueAt ? formatLocal(commitment.dueAt, user.timezone) : commitment.dueText,
        overdue: commitment.dueAt ? commitment.dueAt < now : false,
        source: commitment.source,
        saidInEmailId: commitment.source === 'gmail' ? commitment.sourceId : undefined,
        confidence: commitment.confidence,
      })),
    };
  },
});

export const createCommitment = defineTool({
  name: 'create_commitment',
  description:
    "Records a promise the user tells you about, e.g. 'I told Rahul I'd send the proposal Friday' or 'Amit owes me the invoice by Monday'. For a time-based nudge to themselves, use create_reminder instead.",
  risk: 'WRITE',
  schema: z.object({
    description: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe('What was promised, e.g. "Send the proposal".'),
    direction: z
      .enum(COMMITMENT_DIRECTIONS)
      .describe('outgoing = the user promised; incoming = someone promised them.'),
    personName: z.string().trim().max(100).optional().describe('The other person, e.g. "Rahul".'),
    personEmail: z.email().optional(),
    dueLocalDateTime: z
      .string()
      .regex(LOCAL_DATE_TIME)
      .optional()
      .describe("Deadline in the user's timezone, YYYY-MM-DDTHH:mm."),
    dueText: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe('What they said, e.g. "Friday", if there is no exact time.'),
  }),
  async execute({ user, now }, args) {
    const commitment = await recordCommitment(user._id, {
      description: args.description,
      direction: args.direction,
      person: { name: args.personName, email: args.personEmail },
      source: 'user',
      dueAt: args.dueLocalDateTime
        ? localDateTimeToUtc(args.dueLocalDateTime, user.timezone)
        : undefined,
      dueText: args.dueText,
      detectedAt: now,
    });
    if (!commitment) throw new ToolError('That commitment is already recorded.');
    return {
      id: commitment.id,
      what: commitment.description,
      who: commitment.person?.name ?? commitment.person?.email ?? null,
      due: commitment.dueAt ? formatLocal(commitment.dueAt, user.timezone) : commitment.dueText,
    };
  },
});

export const completeCommitment = defineTool({
  name: 'complete_commitment',
  description:
    "Marks a promise as done when the user says they've handled it. Get ids from get_commitments.",
  risk: 'WRITE',
  schema: z.object({ id: z.string() }),
  async execute({ user, now }, { id }) {
    const commitment = await setCommitmentStatus(user._id, id, 'completed', now);
    return { done: commitment.description };
  },
});

export const cancelCommitment = defineTool({
  name: 'cancel_commitment',
  description: 'Drops a promise that no longer applies, or that was detected wrongly.',
  risk: 'WRITE',
  schema: z.object({ id: z.string() }),
  async execute({ user, now }, { id }) {
    const commitment = await setCommitmentStatus(user._id, id, 'cancelled', now);
    return { cancelled: commitment.description };
  },
});
