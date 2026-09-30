import { IntegrationModel, REAUTH_REQUIRED } from '../../../models/integration.model.js';
import type { UserDocument } from '../../../models/user.model.js';
import { formatDateTime, zonedTimeToUtc } from '../../../utils/time.js';
import { featuresFromScopes, type GoogleFeature } from '../../integrations/google/google.scopes.js';
import { FeatureMissingError, ToolError } from './types.js';

/** "Tue 22 Sep, 3:00 PM" in the user's timezone — what the model reads and repeats. */
export function formatLocal(date: Date, timeZone: string): string {
  return formatDateTime(date, timeZone, 'short');
}

export const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Tools take wall-clock times ("2026-09-22T18:00") in the user's timezone rather than UTC
 * instants, so the model never has to do offset arithmetic.
 */
export function localDateTimeToUtc(value: string, timeZone: string): Date {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new ToolError(`Invalid time "${value}"; use YYYY-MM-DDTHH:mm`);
  const [, year, month, day, hour, minute] = match.map(Number);
  return zonedTimeToUtc(
    { year: year ?? 0, month: month ?? 0, day: day ?? 0, hour, minute },
    timeZone,
  );
}

const FEATURE_NAMES: Record<GoogleFeature, string> = {
  gmail: 'Gmail',
  gmailSend: 'Sending email (Gmail)',
  calendar: 'Google Calendar',
  tasks: 'Google Tasks',
};

/** Throws a ToolError the model can relay when a Google feature can't be used right now. */
export async function requireFeature(
  user: UserDocument,
  feature: GoogleFeature,
  { needsSync }: { needsSync: boolean },
): Promise<void> {
  const integration = await IntegrationModel.findOne({ userId: user._id, provider: 'google' });
  if (!integration || !featuresFromScopes(integration.scopes)[feature]) {
    throw new FeatureMissingError(
      `${FEATURE_NAMES[feature]} isn't connected. The user can connect it in Settings → Integrations.`,
      feature,
    );
  }
  if (integration.lastError === REAUTH_REQUIRED) {
    throw new FeatureMissingError(
      'Google access was revoked. The user needs to reconnect Google in Settings.',
      feature,
    );
  }
  const syncedAt =
    feature === 'gmail'
      ? integration.gmailSync?.lastSyncedAt
      : feature === 'calendar'
        ? integration.calendarSync?.lastSyncedAt
        : new Date();
  if (needsSync && !syncedAt) {
    throw new ToolError(
      `${FEATURE_NAMES[feature]} is still syncing for the first time. Try again in a minute.`,
    );
  }
}
