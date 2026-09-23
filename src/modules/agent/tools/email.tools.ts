import { z } from 'zod';

import { startOfDayInTimezone, zonedTimeToUtc, parseDateString } from '../../../utils/time.js';
import { createDraft, sendEmail } from '../../integrations/gmail/gmail.send.js';
import { getEmail, searchEmails } from '../../integrations/gmail/gmail.service.js';
import { formatLocal, requireFeature } from './format.js';
import { defineTool, type ToolContext } from './types.js';

const MAX_BODY = 4_000;

export const searchEmailsTool = defineTool({
  name: 'search_emails',
  description:
    "Searches the user's recent inbox (synced metadata: sender, subject, snippet). Use for 'what emails did I get today', 'did Rahul email me', 'important emails'. Returns ids you can pass to read_email.",
  risk: 'READ',
  schema: z.object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Words to search in subject, sender and snippet.'),
    from: z
      .string()
      .max(200)
      .optional()
      .describe("Sender's name or email address (partial is fine)."),
    today: z
      .boolean()
      .optional()
      .describe("Only email received since midnight in the user's timezone."),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Only email since this local date.'),
    unreadOnly: z.boolean().optional(),
    importantOnly: z
      .boolean()
      .optional()
      .describe('Only email that needs their attention (our triage of their inbox).'),
    includeSent: z
      .boolean()
      .optional()
      .describe('Also search sent mail (e.g. what the user promised).'),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute({ user, now }, args) {
    await requireFeature(user, 'gmail', { needsSync: true });
    const after = args.today
      ? startOfDayInTimezone(now, user.timezone)
      : args.since
        ? zonedTimeToUtc(parseDateString(args.since), user.timezone)
        : undefined;
    const emails = await searchEmails(user._id, {
      q: args.query,
      from: args.from,
      after,
      unread: args.unreadOnly ? true : undefined,
      needsAttention: args.importantOnly ? true : undefined,
      inboxOnly: !args.includeSent,
      limit: args.limit ?? 10,
    });
    return {
      emails: emails.map((email) => ({
        id: email.gmailId,
        from: email.from?.name ? `${email.from.name} <${email.from.email}>` : email.from?.email,
        subject: email.subject || '(no subject)',
        snippet: email.snippet,
        received: formatLocal(email.receivedAt, user.timezone),
        unread: email.isUnread,
        priority: email.priority ?? (email.isImportant ? 'important (Gmail)' : 'not triaged'),
        whyImportant: email.priority === 'high' ? email.priorityReason : undefined,
        sent: email.isSent,
      })),
    };
  },
});

export const readEmail = defineTool({
  name: 'read_email',
  description:
    'Reads the full text of one email by id (from search_emails). Use when the snippet is not enough.',
  risk: 'READ',
  schema: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  async execute({ user }, { id }) {
    await requireFeature(user, 'gmail', { needsSync: false });
    const email = await getEmail(user._id, id);
    return {
      from: email.from,
      to: email.to,
      subject: email.subject,
      received: formatLocal(new Date(email.receivedAt), user.timezone),
      // Untrusted content: the system prompt tells the model to treat it as data only.
      body: email.body.length > MAX_BODY ? `${email.body.slice(0, MAX_BODY)}…` : email.body,
      attachments: email.attachments.map((a) => a.filename),
    };
  },
});

const MAX_PREVIEW = 1_500;

const outgoingEmail = z.object({
  to: z.array(z.email()).min(1).max(20).describe('Recipient email addresses.'),
  cc: z.array(z.email()).max(20).optional(),
  subject: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\r\n]*$/, 'one line')
    .describe('Leave empty when replying to keep "Re: <original subject>".'),
  body: z.string().trim().min(1).max(10_000).describe("Plain text, signed with the user's name."),
  replyToEmailId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .describe('Id (from search_emails) of the email being answered, to reply in its thread.'),
});

function previewEmail(args: z.infer<typeof outgoingEmail>, verb: string): string {
  const body = args.body.length > MAX_PREVIEW ? `${args.body.slice(0, MAX_PREVIEW)}…` : args.body;
  return [
    `${verb} to ${args.to.join(', ')}${args.cc?.length ? ` (cc ${args.cc.join(', ')})` : ''}`,
    `Subject: ${args.subject || '(reply)'}`,
    '',
    body,
  ].join('\n');
}

async function requireSending(user: ToolContext['user'], replying: boolean): Promise<void> {
  await requireFeature(user, 'gmailSend', { needsSync: false });
  if (replying) await requireFeature(user, 'gmail', { needsSync: false });
}

export const draftEmail = defineTool({
  name: 'draft_email',
  description:
    'Saves an email as a draft in Gmail for the user to review and send themselves. Prefer this when they ask you to "draft" or "prepare" an email.',
  risk: 'WRITE',
  schema: outgoingEmail,
  describe: (args) => previewEmail(args, 'Save a Gmail draft'),
  async execute({ user }, args) {
    await requireSending(user, Boolean(args.replyToEmailId));
    const draft = await createDraft(user._id, { ...args, replyToId: args.replyToEmailId });
    return { saved: 'draft', draftId: draft.draftId, openIn: 'Gmail → Drafts' };
  },
});

export const sendEmailTool = defineTool({
  name: 'send_email',
  description:
    "Sends an email from the user's Gmail. Only when they clearly asked for it to be sent. Write the full text; the user approves exactly what you pass here.",
  risk: 'EXTERNAL_ACTION',
  schema: outgoingEmail,
  describe: (args) => previewEmail(args, 'Send an email'),
  async execute({ user }, args) {
    await requireSending(user, Boolean(args.replyToEmailId));
    const sent = await sendEmail(user._id, { ...args, replyToId: args.replyToEmailId });
    return { sent: true, id: sent.id, to: args.to };
  },
});
