import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { validate } from '../src/middleware/validate.js';
import { ForbiddenError } from '../src/utils/errors.js';

describe('app', () => {
  const app = createApp();

  it('responds to liveness checks', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('reports not ready when dependencies are not connected', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'not_ready',
      checks: { mongodb: false, redis: false },
    });
  });

  it('serves the versioned API root', async () => {
    const res = await request(app).get('/api/v1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'assistant-api', version: 'v1' });
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects malformed JSON with a 400', async () => {
    const res = await request(app)
      .post('/api/v1')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('error handling and validation', () => {
  const app = express();
  app.use(express.json());
  app.post('/items', validate({ body: z.object({ title: z.string().min(1) }) }), (_req, res) => {
    res.status(201).json(res.locals.validated?.body);
  });
  app.get('/forbidden', () => {
    throw new ForbiddenError();
  });
  app.get('/boom', async () => {
    await Promise.resolve();
    throw new Error('database password leaked here');
  });
  app.use(errorHandler);

  it('passes valid bodies through', async () => {
    const res = await request(app).post('/items').send({ title: 'Send proposal' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ title: 'Send proposal' });
  });

  it('returns 422 with issue details for invalid bodies', async () => {
    const res = await request(app).post('/items').send({ title: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].location).toBe('body');
  });

  it('maps AppErrors to their status code', async () => {
    const res = await request(app).get('/forbidden');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('turns unexpected async errors into a 500', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
