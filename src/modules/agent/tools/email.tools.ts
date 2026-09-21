import { z } from 'zod';

import { startOfDayInTimezone, zonedTimeToUtc, parseDateString } from '../../../utils/time.js';
import { getEmail, searchEmails } from '../../integrations/gmail/gmail.service.js';
import { formatLocal, requireFeature } from './format.js';
import { defineTool } from './types.js';

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
    importantOnly: z.boolean().optional(),
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
      important: args.importantOnly ? true : undefined,
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
        important: email.isImportant,
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
