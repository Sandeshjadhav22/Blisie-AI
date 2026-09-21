/** True for IANA timezone names Node's ICU data knows about, e.g. "Asia/Kolkata" or "UTC". */
export function isValidTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the timezone is ahead of UTC at `date` (e.g. +330 for Asia/Kolkata). */
function timezoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The instant local midnight began, in `timeZone`, on the day containing `date`. */
export function startOfDayInTimezone(date: Date, timeZone: string): Date {
  const local = new Date(date.getTime() + timezoneOffsetMinutes(date, timeZone) * 60_000);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Correct with the offset in force at midnight itself (it differs across DST changes).
  let result = midnightAsUtc - timezoneOffsetMinutes(new Date(midnightAsUtc), timeZone) * 60_000;
  result = midnightAsUtc - timezoneOffsetMinutes(new Date(result), timeZone) * 60_000;
  return new Date(result);
}

/** Formats a time like "9:05 AM" in the user's timezone. */
export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    date,
  );
}
