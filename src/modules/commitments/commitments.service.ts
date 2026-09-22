import { isValidObjectId, mongo, type Types } from 'mongoose';

import {
  type CommitmentDirection,
  commitmentDedupeKey,
  type CommitmentDocument,
  CommitmentModel,
  type CommitmentStatus,
} from '../../models/commitment.model.js';
import { NotFoundError } from '../../utils/errors.js';
import { formatDateTime } from '../../utils/time.js';

export interface CommitmentInput {
  direction?: CommitmentDirection;
  description: string;
  person?: { name?: string; email?: string };
  source: 'gmail' | 'telegram' | 'user';
  sourceId?: string;
  sourceRef?: string;
  excerpt?: string;
  dueAt?: Date;
  dueText?: string;
  confidence?: number;
  detectedAt?: Date;
}

/**
 * Saves a commitment, ignoring one that's already recorded from the same message. Returns null
 * when it was a duplicate.
 */
export async function recordCommitment(
  userId: Types.ObjectId,
  input: CommitmentInput,
): Promise<CommitmentDocument | null> {
  try {
    return await CommitmentModel.create({
      userId,
      ...input,
      dedupeKey: commitmentDedupeKey(input.description),
    });
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000) return null;
    throw error;
  }
}

export interface CommitmentFilters {
  status?: CommitmentStatus;
  direction?: CommitmentDirection;
  /** Only those due within this many days (includes overdue). */
  dueWithinDays?: number;
  /** Only those detected in the last N days. */
  sinceDays?: number;
  person?: string;
  limit?: number;
}

export async function listCommitments(
  userId: Types.ObjectId,
  filters: CommitmentFilters = {},
  now = new Date(),
): Promise<CommitmentDocument[]> {
  const query: Record<string, unknown> = { userId };
  if (filters.status) query.status = filters.status;
  if (filters.direction) query.direction = filters.direction;
  if (filters.dueWithinDays !== undefined) {
    query.dueAt = { $lte: new Date(now.getTime() + filters.dueWithinDays * 86_400_000) };
  }
  if (filters.sinceDays !== undefined) {
    query.detectedAt = { $gte: new Date(now.getTime() - filters.sinceDays * 86_400_000) };
  }
  if (filters.person) {
    const pattern = new RegExp(filters.person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ 'person.name': pattern }, { 'person.email': pattern }];
  }
  return CommitmentModel.find(query)
    .sort({ dueAt: 1, detectedAt: -1 })
    .limit(filters.limit ?? 50);
}

async function findOwned(userId: Types.ObjectId, id: string): Promise<CommitmentDocument> {
  const commitment = isValidObjectId(id)
    ? await CommitmentModel.findOne({ _id: id, userId })
    : null;
  if (!commitment) throw new NotFoundError('Commitment not found');
  return commitment;
}

export async function setCommitmentStatus(
  userId: Types.ObjectId,
  id: string,
  status: CommitmentStatus,
  now = new Date(),
): Promise<CommitmentDocument> {
  const commitment = await findOwned(userId, id);
  commitment.status = status;
  commitment.completedAt = status === 'completed' ? now : undefined;
  await commitment.save();
  return commitment;
}

export async function updateCommitment(
  userId: Types.ObjectId,
  id: string,
  input: { description?: string; dueAt?: Date | null; dueText?: string },
): Promise<CommitmentDocument> {
  const commitment = await findOwned(userId, id);
  if (input.description !== undefined) {
    commitment.description = input.description;
    commitment.dedupeKey = commitmentDedupeKey(input.description);
  }
  if (input.dueAt !== undefined) commitment.dueAt = input.dueAt ?? undefined;
  if (input.dueText !== undefined) commitment.dueText = input.dueText;
  await commitment.save();
  return commitment;
}

export async function deleteUserCommitments(userId: Types.ObjectId): Promise<void> {
  await CommitmentModel.deleteMany({ userId });
}

/** "You promised Rahul: send the proposal" — one line, in the user's words. */
export function describeCommitment(commitment: CommitmentDocument, timeZone: string): string {
  const who = commitment.person?.name ?? commitment.person?.email;
  const lead =
    commitment.direction === 'outgoing'
      ? who
        ? `You promised ${who}`
        : 'You promised'
      : who
        ? `${who} promised you`
        : 'Promised to you';
  const due = commitment.dueAt
    ? ` — due ${formatDateTime(commitment.dueAt, timeZone, 'short')}`
    : commitment.dueText
      ? ` — due ${commitment.dueText}`
      : '';
  return `${lead}: ${commitment.description}${due}`;
}

export function toPublicCommitment(commitment: CommitmentDocument) {
  return {
    id: commitment.id,
    direction: commitment.direction,
    description: commitment.description,
    person: commitment.person?.name || commitment.person?.email ? commitment.person : null,
    source: commitment.source,
    sourceId: commitment.sourceId ?? null,
    excerpt: commitment.excerpt ?? null,
    dueAt: commitment.dueAt?.toISOString() ?? null,
    dueText: commitment.dueText ?? null,
    status: commitment.status,
    confidence: commitment.confidence,
    detectedAt: commitment.detectedAt.toISOString(),
    completedAt: commitment.completedAt?.toISOString() ?? null,
  };
}
