import { z } from 'zod';

import { isValidTimezone } from '../../utils/time.js';

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:mm (24-hour)' });

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    timezone: z
      .string()
      .refine(isValidTimezone, { message: 'must be a valid IANA timezone, e.g. Asia/Kolkata' })
      .optional(),
    preferences: z
      .object({
        dailyBriefingEnabled: z.boolean().optional(),
        dailyBriefingTime: timeOfDay.optional(),
        workingHoursStart: timeOfDay.optional(),
        workingHoursEnd: timeOfDay.optional(),
      })
      .strict()
      .refine(
        (prefs) =>
          !prefs.workingHoursStart ||
          !prefs.workingHoursEnd ||
          prefs.workingHoursStart < prefs.workingHoursEnd,
        { message: 'working hours must end after they start', path: ['workingHoursEnd'] },
      )
      .optional(),
    onboardingCompleted: z.literal(true).optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
