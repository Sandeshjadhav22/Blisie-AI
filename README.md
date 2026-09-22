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

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, and put the token in `.env` as
   `TELEGRAM_BOT_TOKEN`.
2. Run `pnpm dev`. In development the API **long-polls** Telegram, so no public URL or tunnel is
   needed. Only one process can poll a bot at a time.
3. In the web app, open onboarding or Settings → Integrations → **Connect Telegram**. That opens
   `t.me/<bot>?start=<one-time code>`; pressing Start links the account.

In production set `TELEGRAM_MODE=webhook`, `PUBLIC_API_URL` and `TELEGRAM_WEBHOOK_SECRET`. The API
registers `POST /api/v1/telegram/webhook` on startup, and Telegram signs each call with the secret.

Messages flow **Telegram adapter → `IncomingMessage` → message handler → responder**. The adapter
is the only Telegram-specific code, so WhatsApp or web chat can reuse everything after it. The
responder handles slash commands and echoes everything else until the agent arrives (Phase 6).

## Gmail

- The **worker** syncs email _metadata_ (sender, subject, snippet, labels) into the `emails`
  collection: the last 14 days on first sync, then only changes, using Gmail's history API, every
  5 minutes. Connecting Gmail triggers a sync straight away.
- Search (`GET /emails`) runs on that metadata in MongoDB. Full bodies and threads are fetched
  live from Gmail when asked for, and never stored.
- Access tokens refresh automatically. If Google revokes the grant, the integration is flagged
  `needsReconnect` and the web app shows a Reconnect button.
- Disconnecting Google deletes all synced email.
- In Telegram, `/inbox` lists today's email (in the user's timezone).

## The agent

Plain messages go to the agent (`src/modules/agent`); slash commands skip it.

```
message → context (memories, connected services, last 16 turns)
        → LLM ⇄ tool calls (validated with zod, executed by us, max 6 steps)
        → reply (light Markdown, rendered to Telegram HTML by the adapter)
```

- **LLM interface** (`agent/llm/types.ts`) is provider-agnostic. `GeminiProvider` (default model
  `gemini-3.5-flash-lite`) is the first implementation. Model turns are replayed verbatim during tool calling, because Gemini's thought
  signatures must be sent back unchanged. To swap models, add a provider.
- **Tools** (`agent/tools/`): calendar events, free time, email search/read, tasks, reminders
  (create/list/cancel) and memory (save/search/update/forget). Each declares a risk level. Only
  READ and user-private WRITE tools are exposed until Phase 9 adds confirmations for actions
  that affect other people.
- **Times**: tools take the user's local wall-clock time (`YYYY-MM-DDTHH:mm`) and return
  formatted local times, so the model never does timezone arithmetic.
- **Safety**: tool arguments are validated before running. Failures go back to the model as
  messages, not exceptions. Email/event text is treated as data, not instructions. Every
  reply stores which tools ran, the model and token usage in the message's metadata.
- **Reminders** are stored, then delivered by the worker on Telegram at the due time.

### Evaluations

`pnpm eval` runs the fixed conversations in `evals/cases.ts` against the real model (needs
`LLM_API_KEY`) and checks which tools were called, with what arguments, and what the reply says.
It uses an in-memory database and fake Google/queue calls. Run it after every prompt, tool or
model change; `pnpm eval reminder` runs a subset.

## Calendar and Tasks

- The **worker** keeps a rolling window of the primary calendar (1 day back, 30 days ahead,
  recurring events expanded) in `calendarevents`, re-reading the whole window every 5 minutes and
  removing anything Google no longer returns. Connecting Calendar triggers a sync straight away.
- `GET /calendar/events` reads that copy. Local days use the user's timezone, and all-day events
  are matched by date.
- **Free time** (`GET /calendar/availability`) uses live Google data within the user's working
  hours (Settings → Account). It skips declined and "free" events and never suggests past times.
- **Writes** (create, move, cancel) go straight to Google, then update the local copy. Guests are
  emailed only when the event has guests. Moving only the start keeps the duration ("move my 3 PM
  to 4").
- **Google Tasks** are read and written live on the default list.
- Telegram: `/today` (meetings), `/free [today|tomorrow|YYYY-MM-DD]`, `/tasks`.
- Calling a feature that isn't connected returns `409 GOOGLE_FEATURE_NOT_CONNECTED` with a
  "Connect … in Settings" message.

### How auth works

- **Sign-in** (`GET /api/v1/auth/google`) asks only for `openid email profile`. The backend creates
  the user and sets an httpOnly `assistant_session` cookie (a signed JWT, 7 days).
- **Connecting a feature** (`GET /api/v1/integrations/google/connect?features=gmail,calendar`) asks
  for that feature's scopes, with offline access. Tokens are stored AES-256-GCM encrypted in the
  `integrations` collection. It must be the same Google account the user signed in with.
- Both flows use PKCE and a signed, short-lived state cookie, and share one redirect URI.
- `POST /api/v1/auth/logout-all` bumps the user's `sessionVersion`, which invalidates every session.

## Scripts

| Script                                         | What it does                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                                     | Run with `tsx watch`, loading `.env`                            |
| `pnpm build` / `pnpm start`                    | Compile to `dist/` and run it                                   |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Quality checks                                                  |
| `pnpm eval`                                    | Agent evaluation set against the real LLM (needs `LLM_API_KEY`) |
| `pnpm test`                                    | Vitest; in-memory MongoDB (first run downloads it)              |
| `pnpm redis:up` / `pnpm redis:down`            | Start/stop local Redis                                          |

## Endpoints

- `GET /health` — liveness
- `GET /health/ready` — readiness (MongoDB + Redis), `503` when a dependency is down
- `/api/v1/*` — versioned API (rate limited)

| Method & path                                                                     | Auth   | What it does                                                |
| --------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `GET /auth/google?returnTo=`                                                      | –      | Redirects to Google sign-in                                 |
| `GET /auth/google/callback`                                                       | –      | OAuth redirect URI for sign-in and connect                  |
| `POST /auth/logout`                                                               | –      | Clears the session cookie                                   |
| `POST /auth/logout-all`                                                           | ✓      | Signs out every device                                      |
| `GET /users/me`                                                                   | ✓      | Current user                                                |
| `PATCH /users/me`                                                                 | ✓      | Name, timezone, briefing preferences, `onboardingCompleted` |
| `GET /integrations`                                                               | ✓      | Connected services (never includes tokens)                  |
| `GET /integrations/google/connect?features=&returnTo=`                            | cookie | Redirects to Google to grant feature scopes                 |
| `DELETE /integrations/google`                                                     | ✓      | Revokes the grant at Google and deletes the tokens          |
| `POST /telegram/link`                                                             | ✓      | One-time `t.me` deep link for connecting Telegram           |
| `DELETE /telegram/link`                                                           | ✓      | Disconnects Telegram                                        |
| `POST /telegram/webhook`                                                          | secret | Telegram updates (webhook mode)                             |
| `GET /conversations`                                                              | ✓      | The user's conversations                                    |
| `GET /conversations/:id/messages?limit=&before=`                                  | ✓      | Messages, newest first                                      |
| `GET /emails?q=&from=&after=&before=&today=&unread=&important=&inboxOnly=&limit=` | ✓      | Search synced email                                         |
| `GET /emails/:id`                                                                 | ✓      | Full message with body (live from Gmail)                    |
| `GET /emails/threads/:id`                                                         | ✓      | Whole thread (live from Gmail)                              |
| `POST /emails/sync`                                                               | ✓      | Queue a sync now (deduplicated per user)                    |
| `GET /calendar/events?date=&days=`                                                | ✓      | Events for local day(s), default today                      |
| `GET /calendar/availability?date=&days=&duration=&includeWeekends=&limit=`        | ✓      | Free intervals + suggested slots (live)                     |
| `POST /calendar/events`                                                           | ✓      | Create (invites guests if any)                              |
| `PATCH /calendar/events/:id`                                                      | ✓      | Update / move (start-only keeps duration)                   |
| `DELETE /calendar/events/:id`                                                     | ✓      | Cancel                                                      |
| `POST /calendar/sync`                                                             | ✓      | Queue a calendar sync now                                   |
| `GET /tasks?includeCompleted=`                                                    | ✓      | Google Tasks (default list)                                 |
| `POST /tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/complete`                     | ✓      | Create, update, complete                                    |
| `GET /reminders?status=pending\|all`                                              | ✓      | Reminders                                                   |
| `POST /reminders`                                                                 | ✓      | Create (`text`, `dueAt` ISO) — delivered on Telegram        |
| `DELETE /reminders/:id`                                                           | ✓      | Cancel a pending reminder                                   |
| `GET /memories`, `POST /memories`, `PATCH /memories/:id`, `DELETE /memories/:id`  | ✓      | Remembered facts                                            |

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
  models/             mongoose models (User, Integration, Conversation, Message, Email, CalendarEvent)
  services/           database, redis
  jobs/               BullMQ queue producers
  utils/              logger, errors, AES-256-GCM crypto for tokens at rest
```

`QUEUE_NAMES` in `src/config/constants.ts` is duplicated in the worker — change both together.
