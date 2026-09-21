import { describe, expect, it } from 'vitest';

import {
  addDaysToDateString,
  dayRangeInTimezone,
  getZonedParts,
  parseTimeOfDay,
  toDateString,
  zonedTimeToUtc,
} from '../src/utils/time.js';

describe('zonedTimeToUtc', () => {
  it('converts India wall-clock time', () => {
    expect(
      zonedTimeToUtc({ year: 2026, month: 9, day: 23, hour: 9 }, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-23T03:30:00.000Z');
  });

  it('uses the right offset on each side of a DST change', () => {
    // New York: EST (-5) before 8 Mar 2026 02:00, EDT (-4) after.
    expect(
      zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1 }, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T06:00:00.000Z');
    expect(
      zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9 }, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T13:00:00.000Z');
  });

  it('moves times inside a DST gap to just after it', () => {
    // 02:30 doesn't exist on 8 Mar 2026 in New York.
    const result = zonedTimeToUtc(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      'America/New_York',
    );
    expect(getZonedParts(result, 'America/New_York')).toMatchObject({ hour: 3, minute: 30 });
  });
});

describe('day helpers', () => {
  it('builds a local day range, 23 hours long on a spring-forward day', () => {
    const { start, end } = dayRangeInTimezone('2026-03-08', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3600_000).toBe(23);
  });

  it('formats and adds days across month ends', () => {
    expect(toDateString(new Date('2026-09-30T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-01');
    expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDateString('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('reports the local weekday', () => {
    // 20 Sep 2026 is a Sunday.
    expect(getZonedParts(new Date('2026-09-20T12:00:00Z'), 'UTC').weekday).toBe(0);
  });

  it('parses times of day', () => {
    expect(parseTimeOfDay('09:30')).toBe(570);
    expect(() => parseTimeOfDay('24:00')).toThrow();
  });
});
