import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type { Types } from 'mongoose';

import { type EmailDocument, EmailModel } from '../../../models/email.model.js';
import { NotFoundError } from '../../../utils/errors.js';
import { withGoogleAuth } from '../google/google-client.js';
import {
  extractBody,
  getHeader,
  listAttachments,
  parseAddressList,
  toEmailFields,
} from './gmail.parse.js';

export interface EmailSearchFilters {
  /** Free text across subject, sender and snippet. */
  q?: string;
  /** Matches the sender's email or name (substring, case-insensitive). */
  from?: string;
  after?: Date;
  before?: Date;
  unread?: boolean;
  important?: boolean;
  /** Only messages in the inbox (default) or everything synced, including sent mail. */
  inboxOnly?: boolean;
  limit: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Searches the synced metadata in MongoDB — fast, and doesn't hit Gmail's rate limits. */
export async function searchEmails(
  userId: Types.ObjectId,
  filters: EmailSearchFilters,
): Promise<EmailDocument[]> {
  const query: Record<string, unknown> = { userId };
  if (filters.q) query.$text = { $search: filters.q };
  if (filters.from) {
    const pattern = new RegExp(escapeRegex(filters.from), 'i');
    query.$or = [{ 'from.email': pattern }, { 'from.name': pattern }];
  }
  if (filters.after || filters.before) {
    query.receivedAt = {
      ...(filters.after ? { $gte: filters.after } : {}),
      ...(filters.before ? { $lt: filters.before } : {}),
    };
  }
  if (filters.unread !== undefined) query.isUnread = filters.unread;
  if (filters.important !== undefined) query.isImportant = filters.important;
  if (filters.inboxOnly !== false) query.isInbox = true;

  return EmailModel.find(query).sort({ receivedAt: -1 }).limit(filters.limit);
}

export function toPublicEmail(email: EmailDocument) {
  return {
    id: email.gmailId,
    threadId: email.threadId,
    from: email.from ?? null,
    to: email.to,
    subject: email.subject,
    snippet: email.snippet,
    receivedAt: email.receivedAt.toISOString(),
    isUnread: email.isUnread,
    isImportant: email.isImportant,
    labelIds: email.labelIds,
  };
}

function toFullMessage(message: gmail_v1.Schema$Message) {
  const headers = message.payload?.headers ?? undefined;
  const fields = toEmailFields(message);
  return {
    id: fields.gmailId,
    threadId: fields.threadId,
    from: fields.from ?? null,
    to: fields.to,
    cc: fields.cc,
    replyTo: parseAddressList(getHeader(headers, 'Reply-To'))[0] ?? null,
    subject: fields.subject,
    receivedAt: fields.receivedAt.toISOString(),
    labelIds: fields.labelIds,
    isUnread: fields.isUnread,
    body: extractBody(message.payload),
    attachments: listAttachments(message.payload),
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number }).status === 404;
}

/** Full message (with body), fetched live from Gmail. */
export async function getEmail(userId: Types.ObjectId, gmailId: string) {
  return withGoogleAuth(userId, 'gmail', async (auth) => {
    try {
      const { data } = await gmail({ version: 'v1', auth }).users.messages.get({
        userId: 'me',
        id: gmailId,
        format: 'full',
      });
      return toFullMessage(data);
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError('Email not found');
      throw error;
    }
  });
}

/** Whole conversation, oldest message first, fetched live from Gmail. */
export async function getThread(userId: Types.ObjectId, threadId: string) {
  return withGoogleAuth(userId, 'gmail', async (auth) => {
    try {
      const { data } = await gmail({ version: 'v1', auth }).users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });
      return { id: data.id ?? threadId, messages: (data.messages ?? []).map(toFullMessage) };
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError('Thread not found');
      throw error;
    }
  });
}

export async function deleteUserEmails(userId: Types.ObjectId): Promise<void> {
  await EmailModel.deleteMany({ userId });
}
