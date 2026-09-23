import { gmail } from '@googleapis/gmail';
import type { Types } from 'mongoose';

import { BadRequestError, NotFoundError } from '../../../utils/errors.js';
import { withGoogleAuth } from '../google/google-client.js';
import { getHeader } from './gmail.parse.js';

/**
 * Drafting and sending email. Only ever called for an action the permission policy allowed (or
 * the user approved). Needs the separate `gmailSend` feature; replies also read the original
 * message's headers with `gmail`.
 */

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text. */
  body: string;
  /** Gmail id of the message being answered: keeps the reply in its thread. */
  replyToId?: string;
}

interface ReplyContext {
  threadId: string;
  messageId?: string;
  references?: string;
  subject: string;
}

/** Header values must be a single line, or a crafted subject could add headers of its own. */
function headerValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new BadRequestError('Email headers must be a single line');
  return value;
}

/** RFC 2047 encoding for non-ASCII subjects. */
function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function wrap(base64: string): string {
  return base64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** Builds the RFC 2822 message Gmail's API wants, base64url-encoded. */
export function buildRawEmail(
  email: Omit<OutgoingEmail, 'replyToId'>,
  reply?: Pick<ReplyContext, 'messageId' | 'references'>,
): string {
  const headers = [
    `To: ${headerValue(email.to.join(', '))}`,
    ...(email.cc?.length ? [`Cc: ${headerValue(email.cc.join(', '))}`] : []),
    `Subject: ${encodeSubject(headerValue(email.subject))}`,
    ...(reply?.messageId
      ? [
          `In-Reply-To: ${headerValue(reply.messageId)}`,
          `References: ${headerValue([reply.references, reply.messageId].filter(Boolean).join(' '))}`,
        ]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${wrap(Buffer.from(email.body, 'utf8').toString('base64'))}`;
  return Buffer.from(message, 'utf8').toString('base64url');
}

async function loadReplyContext(userId: Types.ObjectId, gmailId: string): Promise<ReplyContext> {
  return withGoogleAuth(userId, 'gmail', async (auth) => {
    try {
      const { data } = await gmail({ version: 'v1', auth }).users.messages.get({
        userId: 'me',
        id: gmailId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'Subject'],
      });
      const headers = data.payload?.headers ?? undefined;
      return {
        threadId: data.threadId ?? '',
        messageId: getHeader(headers, 'Message-ID'),
        references: getHeader(headers, 'References'),
        subject: getHeader(headers, 'Subject') ?? '',
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        throw new NotFoundError('The email being replied to no longer exists');
      }
      throw error;
    }
  });
}

async function prepare(userId: Types.ObjectId, email: OutgoingEmail) {
  const reply = email.replyToId ? await loadReplyContext(userId, email.replyToId) : undefined;
  const subject =
    reply && !email.subject ? `Re: ${reply.subject.replace(/^re:\s*/i, '')}` : email.subject;
  return {
    raw: buildRawEmail({ ...email, subject }, reply),
    threadId: reply?.threadId || undefined,
  };
}

export async function sendEmail(userId: Types.ObjectId, email: OutgoingEmail) {
  const { raw, threadId } = await prepare(userId, email);
  return withGoogleAuth(userId, 'gmailSend', async (auth) => {
    const { data } = await gmail({ version: 'v1', auth }).users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId },
    });
    return { id: data.id ?? '', threadId: data.threadId ?? '' };
  });
}

/** Saves a draft in Gmail for the user to finish and send themselves. */
export async function createDraft(userId: Types.ObjectId, email: OutgoingEmail) {
  const { raw, threadId } = await prepare(userId, email);
  return withGoogleAuth(userId, 'gmailSend', async (auth) => {
    const { data } = await gmail({ version: 'v1', auth }).users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw, threadId } },
    });
    return { draftId: data.id ?? '', messageId: data.message?.id ?? '' };
  });
}
