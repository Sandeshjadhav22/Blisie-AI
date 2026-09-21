import 'express';

declare global {
  namespace Express {
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
