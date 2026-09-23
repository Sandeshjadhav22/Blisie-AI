import { z } from 'zod';

import { PERMISSION_MODES } from '../../models/user.model.js';
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
        importantEmailAlerts: z.boolean().optional(),
        followUpNudges: z.boolean().optional(),
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
    /** What the agent may do without asking, per risk level (see actions/policy.ts). */
    permissions: z
      .object({
        write: z.enum(PERMISSION_MODES).optional(),
        externalAction: z.enum(PERMISSION_MODES).optional(),
        // Actions that can't be undone always ask first; they can only be turned off.
        destructive: z.enum(['confirm', 'never']).optional(),
      })
      .strict()
      .optional(),
    onboardingCompleted: z.literal(true).optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
