import { env } from '../../../config/env.js';
import { IntegrationModel, REAUTH_REQUIRED } from '../../../models/integration.model.js';
import { UserModel } from '../../../models/user.model.js';
import { formatTime, startOfDayInTimezone } from '../../../utils/time.js';
import type { OutgoingMessage } from '../../conversations/channel.types.js';
import { registerCommand } from '../../conversations/responder.js';
import { featuresFromScopes } from '../google/google.scopes.js';
import { searchEmails } from './gmail.service.js';

const MAX_LISTED = 10;

function settingsLink(): string {
  return new URL('/settings/integrations', env.FRONTEND_URL).toString();
}

/** `/inbox` — "What emails did I receive today?" */
async function inbox(userId: Parameters<typeof searchEmails>[0]): Promise<OutgoingMessage[]> {
  const [user, integration] = await Promise.all([
    UserModel.findById(userId),
    IntegrationModel.findOne({ userId, provider: 'google' }),
  ]);
  if (!user) return [];

  if (!integration || !featuresFromScopes(integration.scopes).gmail) {
    return [{ text: `Connect Gmail first so I can read your inbox: ${settingsLink()}` }];
  }
  if (integration.lastError === REAUTH_REQUIRED) {
    return [{ text: `I lost access to your Gmail. Please reconnect Google: ${settingsLink()}` }];
  }
  if (!integration.gmailSync?.lastSyncedAt) {
    return [{ text: "I'm still reading your inbox for the first time. Try again in a minute." }];
  }

  const since = startOfDayInTimezone(new Date(), user.timezone);
  const emails = await searchEmails(userId, { after: since, limit: 100 });
  if (emails.length === 0) return [{ text: 'No new emails in your inbox today. 🎉' }];

  const unread = emails.filter((email) => email.isUnread).length;
  const lines = emails.slice(0, MAX_LISTED).map((email) => {
    const sender = email.from?.name ?? email.from?.email ?? 'Unknown sender';
    const subject = email.subject || '(no subject)';
    const marker = email.isUnread ? '🔵 ' : '';
    return `${marker}${formatTime(email.receivedAt, user.timezone)} — **${sender}**: ${subject}`;
  });
  const more = emails.length > MAX_LISTED ? `\n…and ${emails.length - MAX_LISTED} more` : '';
  const title = `📬 **${emails.length} email${emails.length === 1 ? '' : 's'} today**${
    unread ? ` (${unread} unread)` : ''
  }`;

  return [{ text: `${title}\n\n${lines.join('\n')}${more}`, format: 'markdown' }];
}

export function registerGmailCommands(): void {
  registerCommand('inbox', (message) => inbox(message.userId));
}
