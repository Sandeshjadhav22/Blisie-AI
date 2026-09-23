import { isValidObjectId, type Types } from 'mongoose';

import { type ActionDocument, ActionModel, type ActionStatus } from '../../models/action.model.js';
import { type UserDocument, UserModel } from '../../models/user.model.js';
import { NotFoundError } from '../../utils/errors.js';
import { summarizeError } from '../../utils/error-summary.js';
import { logger } from '../../utils/logger.js';
import { defaultTools } from '../agent/tools/index.js';
import { runTool } from '../agent/tools/run.js';
import { type AgentTool, riskOf, type ToolRisk } from '../agent/tools/types.js';
import { APPROVAL_TTL_MS, decide } from './policy.js';

/** Result output is kept for the activity page; anything big is cut. */
const MAX_RESULT_CHARS = 2_000;

function compactResult(output: unknown): unknown {
  const json = JSON.stringify(output) as string | undefined;
  return json === undefined || json.length <= MAX_RESULT_CHARS
    ? output
    : { truncated: json.slice(0, MAX_RESULT_CHARS) };
}

export interface ActionInput {
  userId: Types.ObjectId;
  conversationId?: Types.ObjectId;
  tool: string;
  risk: ToolRisk;
  args: unknown;
  summary: string;
}

/** Records a call the policy let run (or refused), with its outcome. */
export async function recordAction(
  input: ActionInput,
  outcome: { status: 'executed' | 'failed' | 'blocked'; result?: unknown; error?: string },
  now = new Date(),
): Promise<ActionDocument> {
  return ActionModel.create({
    ...input,
    status: outcome.status,
    decidedBy: 'policy',
    decidedAt: now,
    ...(outcome.status === 'blocked' ? {} : { executedAt: now }),
    ...(outcome.result !== undefined ? { result: compactResult(outcome.result) } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}

/** Stores a call that waits for the user's Yes. */
export async function createPendingAction(
  input: ActionInput,
  now = new Date(),
): Promise<ActionDocument> {
  return ActionModel.create({
    ...input,
    status: 'pending',
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
  });
}

/** Remembers which Telegram message carries the buttons, so it can be updated later. */
export async function attachTelegramMessage(
  actionId: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  await ActionModel.updateOne({ _id: actionId }, { $set: { telegram: { chatId, messageId } } });
}

/** Lazily marks unanswered requests as expired. */
async function expireStale(userId: Types.ObjectId, now: Date): Promise<void> {
  await ActionModel.updateMany(
    { userId, status: 'pending', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
}

export type DecisionOutcome =
  'executed' | 'failed' | 'rejected' | 'expired' | 'blocked' | 'already_decided';

function findTool(name: string): AgentTool | undefined {
  return defaultTools.find((tool) => tool.name === name);
}

async function findOwned(userId: Types.ObjectId, id: string): Promise<ActionDocument> {
  const action = isValidObjectId(id) ? await ActionModel.findOne({ _id: id, userId }) : null;
  if (!action) throw new NotFoundError('Action not found');
  return action;
}

/** Why a claim failed: it expired, or it was already approved/declined. */
async function explainUnclaimed(
  userId: Types.ObjectId,
  id: string,
  now: Date,
): Promise<{ action: ActionDocument; outcome: DecisionOutcome }> {
  const action = await findOwned(userId, id);
  if (action.status === 'pending' && action.expiresAt && action.expiresAt <= now) {
    action.status = 'expired';
    await action.save();
  }
  return { action, outcome: action.status === 'expired' ? 'expired' : 'already_decided' };
}

/**
 * Runs an approved call. The claim (pending → executing) is atomic, so a double tap or a
 * Telegram redelivery can never run it twice. The arguments are re-validated and the policy is
 * checked again, in case the user tightened their settings since the request was made.
 */
export async function approveAction(
  userId: Types.ObjectId,
  id: string,
  by: 'telegram' | 'web',
  now = new Date(),
): Promise<{ action: ActionDocument; outcome: DecisionOutcome }> {
  const claimed = isValidObjectId(id)
    ? await ActionModel.findOneAndUpdate(
        { _id: id, userId, status: 'pending', expiresAt: { $gt: now } },
        { $set: { status: 'executing', decidedBy: by, decidedAt: now } },
        { returnDocument: 'after' },
      )
    : null;
  if (!claimed) return explainUnclaimed(userId, id, now);

  const finish = async (
    status: 'executed' | 'failed' | 'blocked',
    fields: { result?: unknown; error?: string } = {},
  ) => {
    claimed.status = status;
    if (status !== 'blocked') claimed.executedAt = now;
    if (fields.result !== undefined) claimed.result = compactResult(fields.result);
    if (fields.error) claimed.error = fields.error;
    await claimed.save();
    return { action: claimed, outcome: status };
  };

  try {
    const user: UserDocument | null = await UserModel.findById(userId);
    const tool = findTool(claimed.tool);
    if (!user || !tool)
      return await finish('failed', { error: 'This action is no longer available.' });

    const parsed = tool.schema.safeParse(claimed.args);
    if (!parsed.success)
      return await finish('failed', { error: 'The request was no longer valid.' });

    const context = { user, conversationId: claimed.conversationId ?? user._id, now };
    const risk = await riskOf(tool, parsed.data, context);
    if (decide(risk, user) === 'deny') {
      return await finish('blocked', { error: 'Your permission settings no longer allow this.' });
    }

    const outcome = await runTool(tool, context, parsed.data);
    logger.info({ userId: user.id, tool: tool.name, ok: outcome.ok, by }, 'Approved action ran');
    return outcome.ok
      ? await finish('executed', { result: outcome.output })
      : await finish('failed', { error: outcome.error });
  } catch (error) {
    // Never leave a claimed action stuck in `executing`.
    logger.error({ actionId: id, error: summarizeError(error) }, 'Approved action crashed');
    await ActionModel.updateOne(
      { _id: claimed._id, status: 'executing' },
      { $set: { status: 'failed', error: 'Something went wrong. Please try again.' } },
    );
    throw error;
  }
}

export async function rejectAction(
  userId: Types.ObjectId,
  id: string,
  by: 'telegram' | 'web',
  now = new Date(),
): Promise<{ action: ActionDocument; outcome: DecisionOutcome }> {
  const action = isValidObjectId(id)
    ? await ActionModel.findOneAndUpdate(
        { _id: id, userId, status: 'pending', expiresAt: { $gt: now } },
        { $set: { status: 'rejected', decidedBy: by, decidedAt: now } },
        { returnDocument: 'after' },
      )
    : null;
  if (!action) return explainUnclaimed(userId, id, now);
  return { action, outcome: 'rejected' };
}

export interface ActionFilters {
  status?: ActionStatus;
  limit: number;
  /** Only entries created before this (for paging back). */
  before?: Date;
}

export async function listActions(
  userId: Types.ObjectId,
  filters: ActionFilters,
  now = new Date(),
): Promise<ActionDocument[]> {
  await expireStale(userId, now);
  return ActionModel.find({
    userId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.before ? { createdAt: { $lt: filters.before } } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(filters.limit);
}

export async function countPendingActions(userId: Types.ObjectId, now = new Date()) {
  return ActionModel.countDocuments({ userId, status: 'pending', expiresAt: { $gt: now } });
}

export function toPublicAction(action: ActionDocument) {
  return {
    id: action.id,
    tool: action.tool,
    risk: action.risk,
    summary: action.summary,
    status: action.status,
    decidedBy: action.decidedBy ?? null,
    decidedAt: action.decidedAt?.toISOString() ?? null,
    executedAt: action.executedAt?.toISOString() ?? null,
    expiresAt: action.expiresAt?.toISOString() ?? null,
    error: action.error ?? null,
    createdAt: action.createdAt.toISOString(),
  };
}
