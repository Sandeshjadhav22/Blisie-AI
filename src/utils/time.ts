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

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock fields of `date` as seen in `timeZone`. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** Minutes the timezone is ahead of UTC at `date` (e.g. +330 for Asia/Kolkata). */
function timezoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at which the wall clock in `timeZone` reads the given local time. For times skipped
 * by a DST jump, the result lands just after the gap; for repeated times, the earlier one.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
  );
  // The offset at a first guess can differ from the offset at the answer across DST, so try the
  // offsets on both sides and keep the one that really shows the requested wall-clock time.
  const first = asUtc - timezoneOffsetMinutes(new Date(asUtc), timeZone) * 60_000;
  const second = asUtc - timezoneOffsetMinutes(new Date(first), timeZone) * 60_000;
  const matches = (candidate: number) => {
    const p = getZonedParts(new Date(candidate), timeZone);
    return p.hour === (local.hour ?? 0) && p.minute === (local.minute ?? 0) && p.day === local.day;
  };
  if (matches(second)) return new Date(second);
  if (matches(first)) return new Date(first);
  // The time doesn't exist (skipped by a spring-forward jump): use the moment just after the gap.
  return new Date(Math.max(first, second));
}

/** The instant local midnight began, in `timeZone`, on the day containing `date`. */
export function startOfDayInTimezone(date: Date, timeZone: string): Date {
  const { year, month, day } = getZonedParts(date, timeZone);
  return zonedTimeToUtc({ year, month, day }, timeZone);
}

/** Parses "YYYY-MM-DD". */
export function parseDateString(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** "YYYY-MM-DD" of `date` in `timeZone`. */
export function toDateString(date: Date, timeZone: string): string {
  const { year, month, day } = getZonedParts(date, timeZone);
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Adds calendar days to a "YYYY-MM-DD" string (timezone-free arithmetic). */
export function addDaysToDateString(value: string, days: number): string {
  const { year, month, day } = parseDateString(value);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** [start, end) of a local calendar day ("YYYY-MM-DD") in `timeZone`, as UTC instants. */
export function dayRangeInTimezone(value: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedTimeToUtc(parseDateString(value), timeZone),
    end: zonedTimeToUtc(parseDateString(addDaysToDateString(value, 1)), timeZone),
  };
}

/** Parses "HH:mm" into minutes after midnight. */
export function parseTimeOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Builds a stable, human date string from parts — independent of ICU punctuation differences.
 * `long`: "Tuesday 22 September 2026, 9:00 AM"; `short`: "Tue 22 Sep, 9:00 AM".
 */
export function formatDateTime(date: Date, timeZone: string, style: 'long' | 'short'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: style,
    day: 'numeric',
    month: style,
    year: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = `${get('weekday')} ${get('day')} ${get('month')}`;
  return `${style === 'long' ? `${day} ${get('year')}` : day}, ${formatTime(date, timeZone)}`;
}

/** Formats a time like "9:05 AM" in the user's timezone. */
export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    date,
  );
}
