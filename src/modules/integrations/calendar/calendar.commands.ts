import { env } from '../../../config/env.js';
import { IntegrationModel, REAUTH_REQUIRED } from '../../../models/integration.model.js';
import { type UserDocument, UserModel } from '../../../models/user.model.js';
import { AppError } from '../../../utils/errors.js';
import { escapeHtml } from '../../../utils/html.js';
import {
  addDaysToDateString,
  dayRangeInTimezone,
  formatTime,
  toDateString,
} from '../../../utils/time.js';
import type { OutgoingMessage } from '../../conversations/channel.types.js';
import { registerCommand } from '../../conversations/responder.js';
import { featuresFromScopes } from '../google/google.scopes.js';
import { getAvailability, listEvents } from './calendar.service.js';

function settingsLink(): string {
  return new URL('/settings/integrations', env.FRONTEND_URL).toString();
}

/** Returns a message explaining why the calendar can't be used yet, or null if it can. */
async function calendarUnavailable(
  user: UserDocument,
  { needsSync }: { needsSync: boolean },
): Promise<OutgoingMessage[] | null> {
  const integration = await IntegrationModel.findOne({ userId: user._id, provider: 'google' });
  if (!integration || !featuresFromScopes(integration.scopes).calendar) {
    return [{ text: `Connect Google Calendar first: ${settingsLink()}` }];
  }
  if (integration.lastError === REAUTH_REQUIRED) {
    return [{ text: `I lost access to your Google account. Please reconnect: ${settingsLink()}` }];
  }
  if (needsSync && !integration.calendarSync?.lastSyncedAt) {
    return [{ text: "I'm still reading your calendar for the first time. Try again in a minute." }];
  }
  return null;
}

/** `/today` — "What meetings do I have today?" */
async function today(user: UserDocument): Promise<OutgoingMessage[]> {
  const blocked = await calendarUnavailable(user, { needsSync: true });
  if (blocked) return blocked;

  const date = toDateString(new Date(), user.timezone);
  const events = await listEvents(user._id, dayRangeInTimezone(date, user.timezone), user.timezone);
  const visible = events.filter((event) => event.myResponseStatus !== 'declined');
  if (visible.length === 0) return [{ text: 'Nothing on your calendar today. 🎉' }];

  const lines = visible.map((event) => {
    const title = escapeHtml(event.summary || '(no title)');
    if (event.allDay) return `🗓 All day — <b>${title}</b>`;
    const time = `${formatTime(event.start, user.timezone)}–${formatTime(event.end, user.timezone)}`;
    const meet = event.meetLink ? ` · <a href="${escapeHtml(event.meetLink)}">join</a>` : '';
    const tentative = event.myResponseStatus === 'needsAction' ? ' <i>(not answered)</i>' : '';
    return `${time} — <b>${title}</b>${tentative}${meet}`;
  });
  const timed = visible.filter((event) => !event.allDay).length;
  const heading = `📅 <b>${timed} meeting${timed === 1 ? '' : 's'} today</b>`;
  return [{ text: `${heading}\n\n${lines.join('\n')}`, format: 'html' }];
}

/** `/free [today|tomorrow|YYYY-MM-DD]` — "Find a time to meet tomorrow." */
async function free(user: UserDocument, args: string): Promise<OutgoingMessage[]> {
  const blocked = await calendarUnavailable(user, { needsSync: false });
  if (blocked) return blocked;

  const todayDate = toDateString(new Date(), user.timezone);
  const arg = args.trim().toLowerCase();
  const date =
    arg === '' || arg === 'tomorrow'
      ? addDaysToDateString(todayDate, 1)
      : arg === 'today'
        ? todayDate
        : /^\d{4}-\d{2}-\d{2}$/.test(arg)
          ? arg
          : null;
  if (!date) return [{ text: 'Try /free, /free today, /free tomorrow or /free 2026-10-01.' }];

  try {
    const { suggestions } = await getAvailability(user, {
      fromDate: date,
      days: 1,
      durationMinutes: 30,
      includeWeekends: true,
      maxSuggestions: 6,
    });
    const day =
      date === todayDate ? 'today' : date === addDaysToDateString(todayDate, 1) ? 'tomorrow' : date;
    if (suggestions.length === 0) {
      return [{ text: `No free 30-minute slots ${day} within your working hours.` }];
    }
    const lines = suggestions.map((slot) => `• ${formatTime(slot.start, user.timezone)}`);
    return [{ text: `🕒 Free for 30 minutes ${day}:\n${lines.join('\n')}` }];
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) return [{ text: error.message }];
    throw error;
  }
}

async function withUser(
  userId: UserDocument['_id'],
  fn: (user: UserDocument) => Promise<OutgoingMessage[]>,
): Promise<OutgoingMessage[]> {
  const user = await UserModel.findById(userId);
  return user ? fn(user) : [];
}

export function registerCalendarCommands(): void {
  registerCommand('today', (message) => withUser(message.userId, today));
  registerCommand('free', (message, args) => withUser(message.userId, (user) => free(user, args)));
}
