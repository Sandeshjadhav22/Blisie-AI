import { z } from 'zod';

import {
  cancelReminder,
  createReminder,
  listReminders,
} from '../../reminders/reminders.service.js';
import { formatLocal, LOCAL_DATE_TIME, localDateTimeToUtc } from './format.js';
import { primaryChannelOf } from '../../channels/channels.service.js';
import { CHANNEL_RULES } from '../../channels/policy.js';
import { defineTool, type ToolContext } from './types.js';

/** Where and how the reminder will arrive, for the model to mention if it matters. */
function reminderDelivery(user: ToolContext['user']): string {
  const linked = primaryChannelOf(user);
  if (!linked) return 'no chat app connected yet — tell them to connect one in Settings';
  const rules = CHANNEL_RULES[linked.type];
  return rules.sessionWindowMs === null
    ? rules.name
    : `${rules.name}: arrives on time if they've messaged you in the 24 hours before; otherwise with their next message. Mention this briefly.`;
}

export const createReminderTool = defineTool({
  name: 'create_reminder',
  description:
    "Sets a one-off reminder that is sent to the user on Telegram at the given local time. Use for 'remind me to … at/in/tomorrow …'.",
  risk: 'WRITE',
  schema: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("What to remind them about, e.g. 'Call Rahul'."),
    localDateTime: z
      .string()
      .regex(LOCAL_DATE_TIME)
      .describe("When, in the user's timezone: YYYY-MM-DDTHH:mm (24-hour)."),
  }),
  describe: ({ text, localDateTime }, { user }) =>
    `Remind you to “${text}” on ${formatLocal(localDateTimeToUtc(localDateTime, user.timezone), user.timezone)}`,
  async execute({ user, now }, { text, localDateTime }) {
    const reminder = await createReminder(
      user._id,
      { text, dueAt: localDateTimeToUtc(localDateTime, user.timezone), source: 'agent' },
      now,
    );
    return {
      id: reminder.id,
      text: reminder.text,
      at: formatLocal(reminder.dueAt, user.timezone),
      delivery: reminderDelivery(user),
    };
  },
});

export const listRemindersTool = defineTool({
  name: 'list_reminders',
  description: "Lists the user's upcoming (pending) reminders.",
  risk: 'READ',
  schema: z.object({}),
  async execute({ user }) {
    const reminders = await listReminders(user._id, 'pending');
    return {
      reminders: reminders.map((r) => ({
        id: r.id,
        text: r.text,
        at: formatLocal(r.dueAt, user.timezone),
      })),
    };
  },
});

export const cancelReminderTool = defineTool({
  name: 'cancel_reminder',
  description: 'Cancels a pending reminder by id (get ids from list_reminders).',
  risk: 'WRITE',
  schema: z.object({ id: z.string() }),
  describe: () => 'Cancel a reminder',
  async execute({ user }, { id }) {
    const reminder = await cancelReminder(user._id, id);
    return { cancelled: reminder.text };
  },
});
