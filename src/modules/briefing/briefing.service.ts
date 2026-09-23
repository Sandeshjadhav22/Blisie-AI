import { type BriefingDocument, BriefingModel } from '../../models/briefing.model.js';
import { CalendarEventModel } from '../../models/calendar-event.model.js';
import { CommitmentModel } from '../../models/commitment.model.js';
import { EmailModel } from '../../models/email.model.js';
import { FollowUpModel } from '../../models/follow-up.model.js';
import type { UserDocument } from '../../models/user.model.js';
import {
  addDaysToDateString,
  dayRangeInTimezone,
  parseDateString,
  parseTimeOfDay,
  toDateString,
  zonedTimeToUtc,
} from '../../utils/time.js';
import { countPendingActions } from '../actions/actions.service.js';
import { importantEmailFilter } from '../integrations/gmail/gmail.service.js';

/**
 * Live numbers for the dashboard's briefing card, counted the same way as the worker's morning
 * briefing (which also reads Google Tasks live; the dashboard shows tasks in their own card).
 */
export interface BriefingSummary {
  date: string;
  counts: {
    meetings: number;
    importantEmails: number;
    commitmentsDue: number;
    overdue: number;
    waitingOn: number;
    pendingApprovals: number;
  };
  lastBriefing: { sentAt: string; trigger: 'scheduled' | 'manual'; text: string } | null;
  /** When the next scheduled briefing goes out, or null if they're off. */
  nextBriefingAt: string | null;
}

function nextBriefingAt(user: UserDocument, now: Date, sentToday: boolean): Date | null {
  if (!user.preferences.dailyBriefingEnabled || !user.telegramId) return null;
  const minutes = parseTimeOfDay(user.preferences.dailyBriefingTime);
  const today = toDateString(now, user.timezone);
  const at = (date: string) =>
    zonedTimeToUtc(
      { ...parseDateString(date), hour: Math.floor(minutes / 60), minute: minutes % 60 },
      user.timezone,
    );
  const todays = at(today);
  return sentToday || todays <= now ? at(addDaysToDateString(today, 1)) : todays;
}

export async function getBriefingSummary(
  user: UserDocument,
  now = new Date(),
): Promise<BriefingSummary> {
  const date = toDateString(now, user.timezone);
  const today = dayRangeInTimezone(date, user.timezone);
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const userId = user._id;

  const [meetings, importantEmails, commitmentsDue, overdue, owed, followUps, pending, last] =
    await Promise.all([
      CalendarEventModel.countDocuments({
        userId,
        status: { $ne: 'cancelled' },
        myResponseStatus: { $ne: 'declined' },
        transparency: { $ne: 'transparent' },
        start: { $lt: today.end },
        end: { $gt: today.start },
      }),
      EmailModel.countDocuments(importantEmailFilter(userId, dayAgo)),
      CommitmentModel.countDocuments({
        userId,
        direction: 'outgoing',
        status: 'pending',
        dueAt: { $ne: null, $lt: today.end },
      }),
      CommitmentModel.countDocuments({
        userId,
        direction: 'outgoing',
        status: 'pending',
        dueAt: { $ne: null, $lt: now },
      }),
      CommitmentModel.countDocuments({
        userId,
        direction: 'incoming',
        status: 'pending',
        dueAt: { $ne: null, $lt: now },
      }),
      FollowUpModel.countDocuments({ userId, status: 'waiting' }),
      countPendingActions(userId, now),
      BriefingModel.findOne({ userId, status: 'sent' }).sort({ sentAt: -1 }),
    ]);

  const sentToday = await BriefingModel.exists({
    userId,
    date,
    trigger: 'scheduled',
    status: 'sent',
  });
  const next = nextBriefingAt(user, now, Boolean(sentToday));
  return {
    date,
    counts: {
      meetings,
      importantEmails,
      commitmentsDue,
      overdue,
      waitingOn: owed + followUps,
      pendingApprovals: pending,
    },
    lastBriefing: last ? toPublicBriefing(last) : null,
    nextBriefingAt: next?.toISOString() ?? null,
  };
}

function toPublicBriefing(briefing: BriefingDocument) {
  return {
    sentAt: (briefing.sentAt ?? briefing.createdAt).toISOString(),
    trigger: briefing.trigger,
    text: briefing.text ?? '',
  };
}
