import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '../config/env.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

/** Status codes body-parser and other express middleware attach to their errors. */
function getHttpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    if (typeof status === 'number' && status >= 400 && status < 600) return status;
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = typeof req.id === 'string' ? req.id : undefined;
  let statusCode = 500;
  let body: ErrorResponseBody['error'] = {
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong',
  };

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    body = { code: error.code, message: error.message, details: error.details };
  } else if (error instanceof ZodError) {
    statusCode = 422;
    body = {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: error.issues,
    };
  } else {
    const httpStatus = getHttpStatus(error);
    if (httpStatus !== undefined && httpStatus < 500) {
      statusCode = httpStatus;
      body = {
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Bad request',
      };
    } else if (!isProduction && error instanceof Error) {
      body.message = error.message;
    }
  }

  if (statusCode >= 500) {
    logger.error({ err: error, requestId }, 'Unhandled request error');
  }

  const payload: ErrorResponseBody = { error: { ...body, requestId } };
  res.status(statusCode).json(payload);
};
