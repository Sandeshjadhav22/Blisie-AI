import 'express';

import type { UserDocument } from '../models/user.model.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `requireAuth` middleware. */
      user?: UserDocument;
      /** The exact JSON body bytes, for checking webhook signatures. */
      rawBody?: Buffer;
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
