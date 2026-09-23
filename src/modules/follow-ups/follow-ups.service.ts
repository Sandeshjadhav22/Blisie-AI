import { isValidObjectId, type Types } from 'mongoose';

import { CommitmentModel } from '../../models/commitment.model.js';
import {
  type FollowUpDocument,
  FollowUpModel,
  type FollowUpStatus,
} from '../../models/follow-up.model.js';
import { NotFoundError } from '../../utils/errors.js';

/**
 * "Who am I waiting for?": email threads where the user wrote last and nobody answered (found by
 * the worker), plus promises other people made to the user.
 */
export async function listFollowUps(
  userId: Types.ObjectId,
  status: FollowUpStatus | 'all' = 'waiting',
  limit = 50,
): Promise<FollowUpDocument[]> {
  return FollowUpModel.find({ userId, ...(status === 'all' ? {} : { status }) })
    .sort({ sentAt: 1 })
    .limit(limit);
}

export async function setFollowUpStatus(
  userId: Types.ObjectId,
  id: string,
  status: 'waiting' | 'done' | 'dismissed',
): Promise<FollowUpDocument> {
  const followUp = isValidObjectId(id)
    ? await FollowUpModel.findOneAndUpdate(
        { _id: id, userId },
        { $set: { status } },
        { returnDocument: 'after' },
      )
    : null;
  if (!followUp) throw new NotFoundError('Follow-up not found');
  return followUp;
}

/** Everything the user is waiting on, oldest first: overdue-first promises, then quiet threads. */
export async function whoAmIWaitingOn(userId: Types.ObjectId) {
  const [promises, followUps] = await Promise.all([
    CommitmentModel.find({ userId, direction: 'incoming', status: 'pending' })
      .sort({ dueAt: 1, detectedAt: 1 })
      .limit(50),
    listFollowUps(userId, 'waiting'),
  ]);
  return { promises, followUps };
}

export function toPublicFollowUp(followUp: FollowUpDocument) {
  return {
    id: followUp.id,
    threadId: followUp.threadId,
    emailId: followUp.gmailId,
    to: followUp.to.map((address) => ({ name: address.name ?? undefined, email: address.email })),
    subject: followUp.subject,
    snippet: followUp.snippet,
    sentAt: followUp.sentAt.toISOString(),
    status: followUp.status,
    repliedAt: followUp.repliedAt?.toISOString() ?? null,
  };
}
