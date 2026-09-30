import { UserModel } from '../../models/user.model.js';
import { formatDateTime } from '../../utils/time.js';
import { registerCommand } from '../conversations/responder.js';
import { whoAmIWaitingOn } from './follow-ups.service.js';

const MAX_LISTED = 15;

/** `/waiting` — promises people made to the user, and email nobody has answered. */
export function registerFollowUpCommands(): void {
  registerCommand('waiting', async (message) => {
    const user = await UserModel.findById(message.userId);
    if (!user) return [];
    const now = new Date();
    const { promises, followUps } = await whoAmIWaitingOn(user._id);
    if (promises.length === 0 && followUps.length === 0) {
      return [{ text: "You're not waiting on anyone that I can see. 🎉" }];
    }

    const sections: string[] = [];
    if (promises.length > 0) {
      const lines = promises.slice(0, MAX_LISTED).map((commitment) => {
        const who = commitment.person?.name ?? commitment.person?.email ?? 'Someone';
        const late = commitment.dueAt && commitment.dueAt < now;
        const due = commitment.dueAt
          ? ` _(${late ? 'was due' : 'due'} ${formatDateTime(commitment.dueAt, user.timezone, 'short')})_`
          : '';
        return `${late ? '🔴' : '•'} **${who}**: ${commitment.description}${due}`;
      });
      sections.push(`🤝 **Promised to you**\n${lines.join('\n')}`);
    }
    if (followUps.length > 0) {
      const lines = followUps.slice(0, MAX_LISTED).map((followUp) => {
        const to = followUp.to[0];
        const who = to?.name ?? to?.email ?? 'them';
        const days = Math.floor((now.getTime() - followUp.sentAt.getTime()) / 86_400_000);
        return `• **${who}**: “${followUp.subject || '(no subject)'}” _(${String(days)} days, no reply)_`;
      });
      sections.push(`📭 **No reply yet**\n${lines.join('\n')}`);
    }
    return [{ text: sections.join('\n\n'), format: 'markdown' }];
  });
}
