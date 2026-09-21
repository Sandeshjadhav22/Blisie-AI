import type { RequestHandler } from 'express';
import type { z } from 'zod';

import { ValidationError } from '../utils/errors.js';

interface RequestSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validates request parts against zod schemas. Parsed values are stored on `res.locals.validated`
 * because `req.query` is a read-only getter in Express 5.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const validated: Record<string, unknown> = {};
    const issues: { location: string; issues: z.core.$ZodIssue[] }[] = [];

    for (const location of ['body', 'query', 'params'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location]);
      if (result.success) {
        validated[location] = result.data;
      } else {
        issues.push({ location, issues: result.error.issues });
      }
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }

    res.locals.validated = validated;
    next();
  };
}
