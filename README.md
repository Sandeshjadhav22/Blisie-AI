# assistant-backend

The API. Express 5 + TypeScript, with MongoDB via Mongoose and Redis/BullMQ for job producers.
Background jobs are processed by the separate `worker` repo.

## Setup

```bash
pnpm install
cp .env.example .env        # fill MONGODB_URI (Atlas), JWT_SECRET, ENCRYPTION_KEY
pnpm redis:up               # Redis in Docker on localhost:6390
pnpm dev                    # http://localhost:4000
```

Generate secrets:

```bash
openssl rand -base64 48     # JWT_SECRET
openssl rand -base64 32     # ENCRYPTION_KEY (must be 32 bytes; share it with the worker)
```

## Scripts

| Script                                         | What it does                         |
| ---------------------------------------------- | ------------------------------------ |
| `pnpm dev`                                     | Run with `tsx watch`, loading `.env` |
| `pnpm build` / `pnpm start`                    | Compile to `dist/` and run it        |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Quality checks                       |
| `pnpm test`                                    | Vitest (no database needed)          |
| `pnpm redis:up` / `pnpm redis:down`            | Start/stop local Redis               |

## Endpoints

- `GET /health` — liveness
- `GET /health/ready` — readiness (MongoDB + Redis), `503` when a dependency is down
- `/api/v1/*` — versioned API (rate limited)

Errors always have the shape `{ "error": { "code", "message", "details?", "requestId" } }`.
Every response carries an `x-request-id` header that matches the logs.

## Layout

```
src/
  server.ts           bootstrap + graceful shutdown
  app.ts              express app (security, parsing, logging, routes, errors)
  routes.ts           /api/v1 router — modules register here
  config/             env validation (zod), constants, queue names
  middleware/         error handler, request logger, zod validation
  modules/            feature modules (auth, users, telegram, integrations, agent, …)
  models/             mongoose models
  services/           database, redis
  jobs/               BullMQ queue producers
  utils/              logger, errors, AES-256-GCM crypto for tokens at rest
```

`QUEUE_NAMES` in `src/config/constants.ts` is duplicated in the worker — change both together.
