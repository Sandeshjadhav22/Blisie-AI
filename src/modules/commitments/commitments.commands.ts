import type { UserDocument } from '../../models/user.model.js';
import { UserModel } from '../../models/user.model.js';
import { escapeHtml } from '../../utils/html.js';
import { formatDateTime } from '../../utils/time.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { registerCommand } from '../conversations/responder.js';
import { listCommitments } from './commitments.service.js';

const MAX_LISTED = 15;

/** `/promises` — what the user owes people, soonest first, then what people owe them. */
async function promises(user: UserDocument): Promise<OutgoingMessage[]> {
  const now = new Date();
  const commitments = await listCommitments(user._id, { status: 'pending', limit: 50 }, now);
  if (commitments.length === 0) {
    return [
      {
        text: "Nothing outstanding that I've noticed. I'll keep watching your email and our chats.",
      },
    ];
  }

  const line = (text: string, due: Date | undefined, overdue: boolean) =>
    `${overdue ? '🔴' : '•'} ${text}${due ? ` <i>(${formatDateTime(due, user.timezone, 'short')})</i>` : ''}`;
  const sections: string[] = [];
  for (const direction of ['outgoing', 'incoming'] as const) {
    const items = commitments.filter((commitment) => commitment.direction === direction);
    if (items.length === 0) continue;
    const heading =
      direction === 'outgoing' ? '🤝 <b>You promised</b>' : '⏳ <b>Waiting on others</b>';
    const lines = items.slice(0, MAX_LISTED).map((commitment) => {
      const who = commitment.person?.name ?? commitment.person?.email;
      const what = escapeHtml(commitment.description);
      const text = who ? `${escapeHtml(who)} — ${what}` : what;
      return line(
        text,
        commitment.dueAt ?? undefined,
        Boolean(commitment.dueAt && commitment.dueAt < now),
      );
    });
    sections.push(`${heading}\n${lines.join('\n')}`);
  }
  return [{ text: sections.join('\n\n'), format: 'html' }];
}

export function registerCommitmentCommands(): void {
  const handler = async (message: { userId: UserDocument['_id'] }) => {
    const user = await UserModel.findById(message.userId);
    return user ? promises(user) : [];
  };
  registerCommand('promises', handler);
  registerCommand('commitments', handler);
}
