import { isValidObjectId, type Types } from 'mongoose';

import { type MemoryDocument, MemoryModel } from '../../models/memory.model.js';
import { NotFoundError } from '../../utils/errors.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Saves a fact. Saving the same fact again just refreshes it instead of duplicating. */
export async function saveMemory(
  userId: Types.ObjectId,
  input: { content: string; subject?: string; source?: 'user' | 'agent' },
): Promise<MemoryDocument> {
  const content = input.content.trim();
  const existing = await MemoryModel.findOne({
    userId,
    content: new RegExp(`^${escapeRegex(content)}$`, 'i'),
  });
  if (existing) {
    if (input.subject) existing.subject = input.subject;
    existing.set('updatedAt', new Date());
    await existing.save();
    return existing;
  }
  return MemoryModel.create({ userId, ...input, content });
}

/**
 * Memories relevant to `query`: full-text matches first, falling back to a substring match on
 * the subject (so "Rahul" finds "Rahul is our designer" even for very short queries).
 */
export async function searchMemories(
  userId: Types.ObjectId,
  query: string,
  limit = 10,
): Promise<MemoryDocument[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const textMatches = await MemoryModel.find(
    { userId, $text: { $search: trimmed } },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit);
  if (textMatches.length > 0) return textMatches;

  const pattern = new RegExp(escapeRegex(trimmed), 'i');
  return MemoryModel.find({ userId, $or: [{ subject: pattern }, { content: pattern }] })
    .sort({ updatedAt: -1 })
    .limit(limit);
}

export async function recentMemories(
  userId: Types.ObjectId,
  limit = 10,
): Promise<MemoryDocument[]> {
  return MemoryModel.find({ userId }).sort({ updatedAt: -1 }).limit(limit);
}

export async function listMemories(userId: Types.ObjectId): Promise<MemoryDocument[]> {
  return MemoryModel.find({ userId }).sort({ updatedAt: -1 }).limit(500);
}

async function findOwned(userId: Types.ObjectId, id: string): Promise<MemoryDocument> {
  const memory = isValidObjectId(id) ? await MemoryModel.findOne({ _id: id, userId }) : null;
  if (!memory) throw new NotFoundError('Memory not found');
  return memory;
}

export async function updateMemory(
  userId: Types.ObjectId,
  id: string,
  input: { content: string; subject?: string },
): Promise<MemoryDocument> {
  const memory = await findOwned(userId, id);
  memory.content = input.content.trim();
  if (input.subject !== undefined) memory.subject = input.subject;
  await memory.save();
  return memory;
}

export async function deleteMemory(userId: Types.ObjectId, id: string): Promise<void> {
  const memory = await findOwned(userId, id);
  await memory.deleteOne();
}

export function toPublicMemory(memory: MemoryDocument) {
  return {
    id: memory.id,
    content: memory.content,
    subject: memory.subject ?? null,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}
