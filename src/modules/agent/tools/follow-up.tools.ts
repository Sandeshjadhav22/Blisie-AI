import { z } from 'zod';

import { setFollowUpStatus, whoAmIWaitingOn } from '../../follow-ups/follow-ups.service.js';
import { formatLocal } from './format.js';
import { defineTool } from './types.js';

export const getWaitingOn = defineTool({
  name: 'get_waiting_on',
  description:
    "Who the user is waiting on: promises people made to them, and emails they sent that nobody has answered for a few days. Use for 'who am I waiting for', 'who hasn't replied', 'what do people owe me'.",
  risk: 'READ',
  schema: z.object({}),
  async execute({ user, now }) {
    const { promises, followUps } = await whoAmIWaitingOn(user._id);
    return {
      promisedToUser: promises.map((commitment) => ({
        id: commitment.id,
        who: commitment.person?.name ?? commitment.person?.email ?? null,
        what: commitment.description,
        due: commitment.dueAt ? formatLocal(commitment.dueAt, user.timezone) : commitment.dueText,
        overdue: commitment.dueAt ? commitment.dueAt < now : false,
      })),
      unansweredEmails: followUps.map((followUp) => ({
        id: followUp.id,
        to: followUp.to.map((address) => address.name ?? address.email),
        subject: followUp.subject,
        sent: formatLocal(followUp.sentAt, user.timezone),
        daysWaiting: Math.floor((now.getTime() - followUp.sentAt.getTime()) / 86_400_000),
        emailId: followUp.gmailId,
      })),
    };
  },
});

export const closeFollowUp = defineTool({
  name: 'close_follow_up',
  description:
    "Stops tracking an unanswered email (id from get_waiting_on): 'done' when it's sorted (e.g. they replied elsewhere), 'dismissed' when no reply was needed.",
  risk: 'WRITE',
  schema: z.object({ id: z.string(), status: z.enum(['done', 'dismissed']) }),
  describe: (args) => `Stop tracking a follow-up (${args.status})`,
  async execute({ user }, { id, status }) {
    const followUp = await setFollowUpStatus(user._id, id, status);
    return { closed: followUp.subject, status };
  },
});
