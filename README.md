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

## Google OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the
   **Gmail API**, **Google Calendar API** and **Google Tasks API**.
2. **OAuth consent screen**: External, add yourself as a test user. Add the scopes `openid`,
   `email`, `profile`, `gmail.readonly`, `calendar.events` and `tasks`.
3. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI:
   `http://localhost:4000/api/v1/auth/google/callback`.
4. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

`gmail.readonly` is a _restricted_ scope: fine for test users, but going public needs Google's
verification and a security assessment. Plan for that before launch.

### How auth works

- **Sign-in** (`GET /api/v1/auth/google`) asks only for `openid email profile`. The backend creates
  the user and sets an httpOnly `assistant_session` cookie (a signed JWT, 7 days).
- **Connecting a feature** (`GET /api/v1/integrations/google/connect?features=gmail,calendar`) asks
  for that feature's scopes, with offline access. Tokens are stored AES-256-GCM encrypted in the
  `integrations` collection. It must be the same Google account the user signed in with.
- Both flows use PKCE and a signed, short-lived state cookie, and share one redirect URI.
- `POST /api/v1/auth/logout-all` bumps the user's `sessionVersion`, which invalidates every session.

## Scripts

| Script                                         | What it does                                       |
| ---------------------------------------------- | -------------------------------------------------- |
| `pnpm dev`                                     | Run with `tsx watch`, loading `.env`               |
| `pnpm build` / `pnpm start`                    | Compile to `dist/` and run it                      |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Quality checks                                     |
| `pnpm test`                                    | Vitest; in-memory MongoDB (first run downloads it) |
| `pnpm redis:up` / `pnpm redis:down`            | Start/stop local Redis                             |

## Endpoints

- `GET /health` — liveness
- `GET /health/ready` — readiness (MongoDB + Redis), `503` when a dependency is down
- `/api/v1/*` — versioned API (rate limited)

| Method & path                                          | Auth   | What it does                                                |
| ------------------------------------------------------ | ------ | ----------------------------------------------------------- |
| `GET /auth/google?returnTo=`                           | –      | Redirects to Google sign-in                                 |
| `GET /auth/google/callback`                            | –      | OAuth redirect URI for sign-in and connect                  |
| `POST /auth/logout`                                    | –      | Clears the session cookie                                   |
| `POST /auth/logout-all`                                | ✓      | Signs out every device                                      |
| `GET /users/me`                                        | ✓      | Current user                                                |
| `PATCH /users/me`                                      | ✓      | Name, timezone, briefing preferences, `onboardingCompleted` |
| `GET /integrations`                                    | ✓      | Connected services (never includes tokens)                  |
| `GET /integrations/google/connect?features=&returnTo=` | cookie | Redirects to Google to grant feature scopes                 |
| `DELETE /integrations/google`                          | ✓      | Revokes the grant at Google and deletes the tokens          |

OAuth redirects report problems back to the frontend as `?error=<code>` (see `AuthErrorCode`).

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
  models/             mongoose models (User, Integration)
  services/           database, redis
  jobs/               BullMQ queue producers
  utils/              logger, errors, AES-256-GCM crypto for tokens at rest
```

`QUEUE_NAMES` in `src/config/constants.ts` is duplicated in the worker — change both together.
