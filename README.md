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
   `email`, `profile`, `gmail.readonly`, `gmail.compose`, `gmail.send`, `calendar.events` and
   `tasks`.
3. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI:
   `http://localhost:4000/api/v1/auth/google/callback`.
4. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

`gmail.readonly`, `gmail.compose` and `gmail.send` are _restricted_ scopes: fine for test users, but going public needs Google's
verification and a security assessment. Plan for that before launch.

## Chat apps (Telegram today, WhatsApp ready)

The assistant talks through **chat apps**. Each is an adapter that turns the app's messages into
an `IncomingMessage` and sends replies back; everything after it (agent, tools, approvals,
commands) is shared:

```
Telegram / WhatsApp adapter → IncomingMessage → message handler → responder → agent
worker jobs ──────────────────────────────────→ notifier → user's primary chat app
```

- **Identity**: `user.channels` lists the linked apps (`type`, `externalId`, `username`,
  `lastInboundAt`) and `user.primaryChannel` says where messages go. Linking is the same for every
  app: the web app asks for a one-time code (`POST /channels/:channel/link`), the user sends it
  from the app, the adapter calls `consumeLinkCode`. The newest linked app becomes primary.
- **Rules per app** live in one place, `modules/channels/policy.ts` (copied in the worker):

  |                                                          | Telegram          | WhatsApp                                                                                                |
  | -------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
  | Replies, approvals                                       | ✅                | ✅ (always within 24 h of the user's message)                                                           |
  | Reminders                                                | ✅                | ✅ on time if the user wrote in the last 24 h; otherwise via a template, or held for their next message |
  | Morning briefing, email alerts, follow-up/promise nudges | ✅                | ❌ off: WhatsApp only answers                                                                           |
  | Approval outcome                                         | edits the message | new message                                                                                             |

- **Formatting**: everything is written once in light Markdown; each adapter converts it
  (Telegram HTML, WhatsApp `*bold*` / `_italic_`) and escapes the rest.
- **Held messages** (`outbox` collection) go out with the reply to the user's next message.
- **Moving to WhatsApp** is configuration: set the WhatsApp keys below, users press
  "Connect WhatsApp" once, and it becomes their primary app. To drop Telegram, unset
  `TELEGRAM_BOT_TOKEN`.
- Accounts from before channels existed (`telegramId`) are moved to `channels` automatically at
  startup (`migrateLegacyTelegramFields`, idempotent).

Commands: `/today`, `/free`, `/inbox`, `/tasks`, `/promises`, `/waiting`, `/briefing`, `/help`.

### Telegram setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, and put the token in `.env` as
   `TELEGRAM_BOT_TOKEN`.
2. Run `pnpm dev`. In development the API **long-polls** Telegram, so no public URL or tunnel is
   needed. Only one process can poll a bot at a time.
3. In the web app, open onboarding or Settings → Integrations → **Connect Telegram**. That opens
   `t.me/<bot>?start=<one-time code>`; pressing Start links the account.

In production set `TELEGRAM_MODE=webhook`, `PUBLIC_API_URL` and `TELEGRAM_WEBHOOK_SECRET`. The API
registers `POST /api/v1/telegram/webhook` on startup, and Telegram signs each call with the secret.

### WhatsApp setup (Meta Cloud API)

1. At [developers.facebook.com](https://developers.facebook.com) create an app (type
   **Business**) and add **WhatsApp**. Under WhatsApp → **API Setup**, note the **Phone number
   ID**, and create a permanent token (Business settings → System users → Generate token with
   `whatsapp_business_messaging`).
2. In `.env`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_NUMBER`
   (digits with country code), `WHATSAPP_APP_SECRET` (App settings → Basic) and a
   `WHATSAPP_VERIFY_TOKEN` of your choice. All five turn WhatsApp on; with none, it's off.
3. WhatsApp → **Configuration** → Webhook: URL `<PUBLIC_API_URL>/api/v1/whatsapp/webhook`, the
   same verify token, and subscribe to **messages**. Meta needs a public HTTPS URL (use a tunnel
   such as ngrok in development).
4. In the web app, Settings → Integrations → **Connect WhatsApp** opens `wa.me/<number>` with
   `link <code>` typed in; sending it links the account.
5. Optional, for on-time reminders outside the 24-hour window: create a **Utility** template with
   one body variable (e.g. "⏰ Reminder: {{1}}"), get it approved, and set
   `WHATSAPP_REMINDER_TEMPLATE` (and `WHATSAPP_TEMPLATE_LANGUAGE`) in the **worker**'s `.env`.
   Each template message is charged by Meta; without one, late reminders wait for the user's
   next message instead.

Every webhook call is checked against `X-Hub-Signature-256` (HMAC of the raw body with the app
secret); unsigned or forged calls get 401.

## Gmail

- The **worker** syncs email _metadata_ (sender, subject, snippet, labels) into the `emails`
  collection: the last 14 days on first sync, then only changes, using Gmail's history API, every
  5 minutes. Connecting Gmail triggers a sync straight away.
- Search (`GET /emails`) runs on that metadata in MongoDB. Full bodies and threads are fetched
  live from Gmail when asked for, and never stored.
- Access tokens refresh automatically. If Google revokes the grant, the integration is flagged
  `needsReconnect` and the web app shows a Reconnect button.
- Disconnecting Google deletes all synced email.
- In chat, `/inbox` lists today's email (in the user's timezone).

## Commitments

The promises people make: "I'll send the proposal by Friday".

- The **worker** reads new email and chat messages every 15 minutes and records what it finds:
  who owes what to whom, the deadline, a confidence score and the sentence it came from.
  Each item is read once (a `commitmentScannedAt` marker), batched into few model calls, and
  capped per sweep, so the cost stays predictable.
- Commitments are deduplicated per source message, so re-scanning can't create copies.
- The worker **nudges** in the chat app when something is nearly due or overdue, once per promise (not on WhatsApp).
- In chat: `/promises`, or just ask ("what did I promise people this week?", "what am I
  forgetting?"). The agent can also record, complete and drop promises.
- Disconnecting Google keeps the promises but deletes the quoted email text.

## The agent

Plain messages go to the agent (`src/modules/agent`); slash commands skip it.

```
message → context (memories, connected services, last 16 turns)
        → LLM ⇄ tool calls (validated with zod, executed by us, max 6 steps)
        → reply (light Markdown, rendered for each chat app by its adapter)
```

- **LLM interface** (`agent/llm/types.ts`) is provider-agnostic. `GeminiProvider` (default model
  `gemini-3.5-flash-lite`) is the first implementation. Model turns are replayed verbatim during tool calling, because Gemini's thought
  signatures must be sent back unchanged. To swap models, add a provider.
- **Tools** (`agent/tools/`): calendar (read, create, move, cancel), free time, email
  (search, read, draft, send), tasks (list, create, complete), promises, who they're waiting on,
  reminders and memory. Each declares a risk level and a one-line `describe()` of what a call
  will do. See _Permissions_ below.
- **Times**: tools take the user's local wall-clock time (`YYYY-MM-DDTHH:mm`) and return
  formatted local times, so the model never does timezone arithmetic.
- **Safety**: tool arguments are validated before running. Failures go back to the model as
  messages, not exceptions. Email/event text is treated as data, not instructions. Every
  reply stores which tools ran, the model and token usage in the message's metadata.
- **Reminders** are stored, then delivered by the worker in the user's chat app at the due time.

### Permissions and approvals

Every tool call goes through the executor (`agent/executor.ts`), which applies the policy in
`actions/policy.ts` — in code, after the model has chosen the call, so neither the model nor an
instruction hidden in an email can skip it.

| Risk              | Examples                                      | Default  | User can set                        |
| ----------------- | --------------------------------------------- | -------- | ----------------------------------- |
| `READ`            | calendar, email search, tasks                 | runs     | –                                   |
| `WRITE`           | reminders, Google Tasks, drafts, memory       | runs     | run / ask / never                   |
| `EXTERNAL_ACTION` | send email, invite guests, move shared events | **asks** | run / ask / never                   |
| `DESTRUCTIVE`     | cancel an event                               | **asks** | ask / never (never runs on its own) |

- "Ask" stores the call as a pending `Action` and the reply comes with **Yes / No** buttons on
  the chat app (also on the web Activity page). Requests expire after an hour.
- Approval claims the action atomically (a double tap can't run it twice), re-validates the
  arguments and checks the policy again, then runs it and shows the outcome in the chat (edited
  in place where the app allows) with the
  outcome. The outcome is also written into the conversation so the agent knows what happened.
- Every non-READ call — run, approved, declined, expired or blocked — is in the `actions`
  collection: the audit log behind `GET /actions` and the Activity page.
- Risk can depend on the call: an event with guests is `EXTERNAL_ACTION`, without is `WRITE`.
- **Sending email** is its own Google feature (`gmailSend`: `gmail.compose` + `gmail.send`), so
  connecting Gmail never implies sending. Replies stay in their thread (`In-Reply-To` /
  `References`); header values are checked for line breaks.

### Proactive messages (sent by the worker)

- **Daily briefing** at each user's briefing time: meetings, email that needs attention, promises
  and tasks due, who they're waiting on. `/briefing` or the dashboard sends one on demand.
- **Important email**: the worker triages new inbox mail (`priority` high/normal/low plus a short
  reason) and alerts about `high` ones in the chat app (not WhatsApp), never overnight.
- **Follow-ups** ("who am I waiting for?"): threads where the user wrote last and nobody answered
  for 3 days, plus promises people made to the user. `/waiting`, `get_waiting_on`, and a nudge
  during working hours. Replies close them automatically.
- **Promise nudges**: a heads-up the day before, a nudge just before the deadline, one "still
  open?" after it.

### OpenAPI

`GET /api/v1/openapi.json` describes the API (OpenAPI 3.1), built from the routes' own zod
schemas and the response schemas in `src/openapi/schemas.ts`. `pnpm openapi` writes it to
`openapi.json`, which the frontend turns into types. Tests parse real responses with the same
schemas and check every documented path exists, so the spec can't drift silently.

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
- In chat: `/today` (meetings), `/free [today|tomorrow|YYYY-MM-DD]`, `/tasks`.
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
| `pnpm openapi`                                 | Write `openapi.json` (then `pnpm api:types` in the frontend)    |
| `pnpm test`                                    | Vitest; in-memory MongoDB (first run downloads it)              |
| `pnpm redis:up` / `pnpm redis:down`            | Start/stop local Redis                                          |

## Endpoints

- `GET /health` — liveness
- `GET /health/ready` — readiness (MongoDB + Redis), `503` when a dependency is down
- `/api/v1/*` — versioned API (rate limited)

| Method & path                                                                                               | Auth   | What it does                                                |
| ----------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `GET /auth/google?returnTo=`                                                                                | –      | Redirects to Google sign-in                                 |
| `GET /auth/google/callback`                                                                                 | –      | OAuth redirect URI for sign-in and connect                  |
| `POST /auth/logout`                                                                                         | –      | Clears the session cookie                                   |
| `POST /auth/logout-all`                                                                                     | ✓      | Signs out every device                                      |
| `GET /users/me`                                                                                             | ✓      | Current user                                                |
| `PATCH /users/me`                                                                                           | ✓      | Name, timezone, briefing preferences, `onboardingCompleted` |
| `GET /integrations`                                                                                         | ✓      | Connected services (never includes tokens)                  |
| `GET /integrations/google/connect?features=&returnTo=`                                                      | cookie | Redirects to Google to grant feature scopes                 |
| `DELETE /integrations/google`                                                                               | ✓      | Revokes the grant at Google and deletes the tokens          |
| `GET /channels`                                                                                             | ✓      | Chat apps offered, linked, and the primary one              |
| `POST /channels/:channel/link`                                                                              | ✓      | One-time link (`t.me` / `wa.me`) that connects a chat app   |
| `DELETE /channels/:channel`                                                                                 | ✓      | Disconnect a chat app                                       |
| `PUT /channels/primary`                                                                                     | ✓      | Choose which linked app gets messages                       |
| `POST /telegram/webhook`                                                                                    | secret | Telegram updates (webhook mode)                             |
| `GET/POST /whatsapp/webhook`                                                                                | signed | WhatsApp verification and messages (Meta Cloud API)         |
| `GET /conversations`                                                                                        | ✓      | The user's conversations                                    |
| `GET /conversations/:id/messages?limit=&before=`                                                            | ✓      | Messages, newest first                                      |
| `GET /emails?q=&from=&after=&before=&today=&unread=&important=&priority=&needsAttention=&inboxOnly=&limit=` | ✓      | Search synced email                                         |
| `GET /emails/:id`                                                                                           | ✓      | Full message with body (live from Gmail)                    |
| `GET /emails/threads/:id`                                                                                   | ✓      | Whole thread (live from Gmail)                              |
| `POST /emails/sync`                                                                                         | ✓      | Queue a sync now (deduplicated per user)                    |
| `GET /calendar/events?date=&days=`                                                                          | ✓      | Events for local day(s), default today                      |
| `GET /calendar/availability?date=&days=&duration=&includeWeekends=&limit=`                                  | ✓      | Free intervals + suggested slots (live)                     |
| `POST /calendar/events`                                                                                     | ✓      | Create (invites guests if any)                              |
| `PATCH /calendar/events/:id`                                                                                | ✓      | Update / move (start-only keeps duration)                   |
| `DELETE /calendar/events/:id`                                                                               | ✓      | Cancel                                                      |
| `POST /calendar/sync`                                                                                       | ✓      | Queue a calendar sync now                                   |
| `GET /tasks?includeCompleted=`                                                                              | ✓      | Google Tasks (default list)                                 |
| `POST /tasks`, `PATCH /tasks/:id`, `POST /tasks/:id/complete`                                               | ✓      | Create, update, complete                                    |
| `GET /reminders?status=pending\|all`                                                                        | ✓      | Reminders                                                   |
| `POST /reminders`                                                                                           | ✓      | Create (`text`, `dueAt` ISO) — delivered in the chat app    |
| `DELETE /reminders/:id`                                                                                     | ✓      | Cancel a pending reminder                                   |
| `GET /memories`, `POST /memories`, `PATCH /memories/:id`, `DELETE /memories/:id`                            | ✓      | Remembered facts                                            |
| `GET /commitments?status=&direction=&person=&dueWithinDays=&sinceDays=`                                     | ✓      | Promises                                                    |
| `POST /commitments`                                                                                         | ✓      | Record one by hand                                          |
| `PATCH /commitments/:id`                                                                                    | ✓      | Complete, cancel or edit                                    |
| `GET /follow-ups?status=`, `PATCH /follow-ups/:id`                                                          | ✓      | Unanswered sent email; close or reopen                      |
| `GET /briefing`                                                                                             | ✓      | Live briefing numbers, last and next briefing               |
| `POST /briefing/send`                                                                                       | ✓      | Send today's briefing to the chat app now                   |
| `GET /actions?status=&before=&limit=`                                                                       | ✓      | Activity log (audit), newest first                          |
| `POST /actions/:id/approve`, `POST /actions/:id/reject`                                                     | ✓      | Answer a pending approval from the web                      |
| `GET /openapi.json`                                                                                         | –      | OpenAPI 3.1 spec                                            |

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
  modules/            feature modules (auth, users, channels, telegram, whatsapp, agent, …)
  models/             mongoose models (User, Integration, Conversation, Message, Email, CalendarEvent)
  services/           database, redis
  jobs/               BullMQ queue producers
  utils/              logger, errors, AES-256-GCM crypto for tokens at rest
```

`QUEUE_NAMES` in `src/config/constants.ts` is duplicated in the worker — change both together.
