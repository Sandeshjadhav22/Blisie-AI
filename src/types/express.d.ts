import 'express';

import type { UserDocument } from '../models/user.model.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `requireAuth` middleware. */
      user?: UserDocument;
    }

    interface Locals {
      /** Parsed output of the `validate` middleware. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}
