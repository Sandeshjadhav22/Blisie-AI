import {
  addDaysToDateString,
  getZonedParts,
  parseDateString,
  parseTimeOfDay,
  zonedTimeToUtc,
} from '../../../utils/time.js';

/**
 * Pure free-time finder: given busy intervals, working hours and a timezone, returns free
 * intervals and a handful of suggested meeting slots. No I/O, so it's easy to test.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface AvailabilityInput {
  /** First local day to search, "YYYY-MM-DD". */
  fromDate: string;
  days: number;
  durationMinutes: number;
  timeZone: string;
  workingHoursStart: string; // "HH:mm"
  workingHoursEnd: string; // "HH:mm"
  includeWeekends: boolean;
  busy: Interval[];
  now: Date;
  maxSuggestions: number;
}

export interface AvailabilityResult {
  free: Interval[];
  suggestions: Interval[];
}

const SLOT_STEP_MINUTES = 30;
const MINUTE = 60_000;

/** Rounds up to the next multiple of `stepMinutes` past the hour (in UTC, fine for :00/:30 zones). */
function roundUp(date: Date, stepMinutes: number): Date {
  const step = stepMinutes * MINUTE;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/** `window` minus `busy` (busy must be merged and sorted). */
function subtract(window: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const block of busy) {
    if (block.end <= cursor || block.start >= window.end) continue;
    if (block.start > cursor) free.push({ start: cursor, end: block.start });
    if (block.end > cursor) cursor = block.end;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

export function findAvailability(input: AvailabilityInput): AvailabilityResult {
  const busy = mergeIntervals(input.busy);
  const workStart = parseTimeOfDay(input.workingHoursStart);
  const workEnd = parseTimeOfDay(input.workingHoursEnd);
  const duration = input.durationMinutes * MINUTE;
  const earliest = roundUp(input.now, 15);

  const free: Interval[] = [];
  for (let offset = 0; offset < input.days; offset += 1) {
    const date = addDaysToDateString(input.fromDate, offset);
    const { year, month, day } = parseDateString(date);
    const dayStart = zonedTimeToUtc({ year, month, day, hour: 12 }, input.timeZone);
    const weekday = getZonedParts(dayStart, input.timeZone).weekday;
    if (!input.includeWeekends && (weekday === 0 || weekday === 6)) continue;

    const window: Interval = {
      start: zonedTimeToUtc(
        { year, month, day, hour: Math.floor(workStart / 60), minute: workStart % 60 },
        input.timeZone,
      ),
      end: zonedTimeToUtc(
        { year, month, day, hour: Math.floor(workEnd / 60), minute: workEnd % 60 },
        input.timeZone,
      ),
    };
    if (window.end <= earliest) continue;
    if (window.start < earliest) window.start = earliest;

    for (const interval of subtract(window, busy)) {
      if (interval.end.getTime() - interval.start.getTime() >= duration) free.push(interval);
    }
  }

  // Suggest at most one slot per hour of each free stretch, so options are spread out rather
  // than 9:00, 9:30, 10:00…
  const suggestions: Interval[] = [];
  for (const interval of free) {
    let start = roundUp(interval.start, SLOT_STEP_MINUTES);
    while (start.getTime() + duration <= interval.end.getTime()) {
      suggestions.push({ start, end: new Date(start.getTime() + duration) });
      if (suggestions.length >= input.maxSuggestions) return { free, suggestions };
      start = new Date(start.getTime() + 60 * MINUTE);
    }
  }
  return { free, suggestions };
}
