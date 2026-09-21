import { describe, expect, it } from 'vitest';

import {
  type AvailabilityInput,
  findAvailability,
} from '../src/modules/integrations/calendar/availability.js';

const TZ = 'Asia/Kolkata';
// Tue 22 Sep 2026, 08:00 IST.
const NOW = new Date('2026-09-22T02:30:00Z');

function ist(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:30`);
}

function base(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    fromDate: '2026-09-23',
    days: 1,
    durationMinutes: 30,
    timeZone: TZ,
    workingHoursStart: '09:00',
    workingHoursEnd: '18:00',
    includeWeekends: false,
    busy: [],
    now: NOW,
    maxSuggestions: 5,
    ...overrides,
  };
}

const fmt = (dates: { start: Date; end: Date }[]) =>
  dates.map(
    (d) =>
      `${d.start.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}-${d.end.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`,
  );

describe('findAvailability', () => {
  it('returns the working day when nothing is booked', () => {
    const result = findAvailability(base());
    expect(fmt(result.free)).toEqual(['09:00-18:00']);
    expect(fmt(result.suggestions)).toEqual([
      '09:00-09:30',
      '10:00-10:30',
      '11:00-11:30',
      '12:00-12:30',
      '13:00-13:30',
    ]);
  });

  it('works around overlapping meetings and drops gaps shorter than the duration', () => {
    const d = '2026-09-23';
    const result = findAvailability(
      base({
        durationMinutes: 60,
        busy: [
          { start: ist(d, '09:00'), end: ist(d, '10:30') },
          { start: ist(d, '10:00'), end: ist(d, '11:00') }, // overlaps the first
          { start: ist(d, '11:30'), end: ist(d, '15:00') }, // leaves a 30-min gap before
          { start: ist(d, '17:00'), end: ist(d, '19:00') }, // runs past working hours
        ],
      }),
    );
    expect(fmt(result.free)).toEqual(['15:00-17:00']);
    expect(fmt(result.suggestions)).toEqual(['15:00-16:00', '16:00-17:00']);
  });

  it('never suggests time that has already passed', () => {
    const result = findAvailability(
      base({ fromDate: '2026-09-22', now: new Date('2026-09-22T09:10:00Z') }), // 14:40 IST
    );
    expect(fmt(result.free)).toEqual(['14:45-18:00']);
    expect(fmt(result.suggestions)[0]).toBe('15:00-15:30');
  });

  it('skips weekends unless asked', () => {
    // Sat 26 and Sun 27 Sep, Mon 28 Sep.
    const weekdays = findAvailability(base({ fromDate: '2026-09-26', days: 3, maxSuggestions: 1 }));
    expect(weekdays.suggestions[0]?.start.toISOString()).toBe(
      ist('2026-09-28', '09:00').toISOString(),
    );

    const all = findAvailability(
      base({ fromDate: '2026-09-26', days: 3, includeWeekends: true, maxSuggestions: 1 }),
    );
    expect(all.suggestions[0]?.start.toISOString()).toBe(ist('2026-09-26', '09:00').toISOString());
  });

  it('returns nothing for a fully booked day', () => {
    const d = '2026-09-23';
    const result = findAvailability(
      base({ busy: [{ start: ist(d, '08:00'), end: ist(d, '20:00') }] }),
    );
    expect(result).toEqual({ free: [], suggestions: [] });
  });
});
