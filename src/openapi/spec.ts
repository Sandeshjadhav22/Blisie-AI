import { z } from 'zod';

import { API_PREFIX, SESSION_COOKIE } from '../config/constants.js';
import { actionListQuerySchema } from '../modules/actions/actions.routes.js';
import { primaryChannelSchema } from '../modules/channels/channels.routes.js';
import { CHAT_CHANNELS } from '../modules/channels/policy.js';
import {
  createSchema as commitmentCreateSchema,
  listQuerySchema as commitmentListQuerySchema,
  patchSchema as commitmentPatchSchema,
} from '../modules/commitments/commitments.routes.js';
import { messagesQuerySchema } from '../modules/conversations/conversations.routes.js';
import {
  followUpListQuerySchema,
  followUpPatchSchema,
} from '../modules/follow-ups/follow-ups.routes.js';
import {
  availabilityQuerySchema,
  createEventSchema,
  eventsQuerySchema,
  updateEventSchema,
} from '../modules/integrations/calendar/calendar.routes.js';
import { completeSetupSchema, openSetupSchema } from '../modules/handoff/handoff.routes.js';
import { searchQuerySchema } from '../modules/integrations/gmail/gmail.routes.js';
import { connectQuerySchema } from '../modules/integrations/integrations.routes.js';
import {
  createSchema as taskCreateSchema,
  listQuerySchema as taskListQuerySchema,
  updateSchema as taskUpdateSchema,
} from '../modules/integrations/tasks/tasks.routes.js';
import { memorySchema } from '../modules/memory/memory.routes.js';
import {
  createSchema as reminderCreateSchema,
  listSchema as reminderListSchema,
} from '../modules/reminders/reminders.routes.js';
import { updateMeSchema } from '../modules/users/users.schemas.js';
import { type ComponentName, components, User } from './schemas.js';

/**
 * The OpenAPI 3.1 description of /api/v1, built from the same zod schemas the routes validate
 * with and the response schemas in ./schemas.ts. Served at GET /api/v1/openapi.json and written to
 * openapi.json by `pnpm openapi`; the frontend generates its types from it.
 */

type JsonSchema = Record<string, unknown>;

function toJson(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

const ref = (name: ComponentName): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name: ComponentName): JsonSchema => ({ type: 'array', items: ref(name) });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
});
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });

interface Operation {
  summary: string;
  tag: string;
  /** Needs the session cookie (default true). */
  auth?: boolean;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Success status and body (null = no body). */
  status?: number;
  response: JsonSchema | null;
  /** Extra documented error statuses besides 401/422. */
  errors?: number[];
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

const QUEUED = object({ status: { type: 'string', const: 'queued' } });

/** The same `channels` / `primaryChannel` fields the User has. */
const CHANNELS_BODY = {
  channels: toJson(User.shape.channels, 'output'),
  primaryChannel: toJson(User.shape.primaryChannel, 'output'),
};

const routes: Record<string, Partial<Record<Method, Operation>>> = {
  '/users/me': {
    get: { summary: 'The signed-in user', tag: 'Users', response: object({ user: ref('User') }) },
    patch: {
      summary: 'Update name, timezone, preferences, permissions or onboarding',
      tag: 'Users',
      body: updateMeSchema,
      response: object({ user: ref('User') }),
    },
  },
  '/handoff/setup/open': {
    post: {
      summary: 'Open a setup link sent in the chat: signs this browser in as its owner',
      tag: 'Users',
      auth: false,
      body: openSetupSchema,
      response: object({ user: ref('User') }),
      errors: [404],
    },
  },
  '/handoff/setup/complete': {
    post: {
      summary: 'Finish setting up (name, timezone); the chat then answers their first message',
      tag: 'Users',
      body: completeSetupSchema,
      response: object({
        user: ref('User'),
        chat: { type: ['string', 'null'], enum: [...CHAT_CHANNELS, null] },
      }),
    },
  },
  '/integrations': {
    get: {
      summary: 'Connected services (never includes tokens)',
      tag: 'Integrations',
      response: object({ integrations: arrayOf('Integration') }),
    },
  },
  '/integrations/google/connect': {
    get: {
      summary: 'Redirects to Google to grant the given features',
      tag: 'Integrations',
      query: connectQuerySchema,
      status: 302,
      response: null,
    },
  },
  '/integrations/google': {
    delete: {
      summary: 'Revoke the Google grant and delete synced data',
      tag: 'Integrations',
      status: 204,
      response: null,
    },
  },
  '/channels': {
    get: {
      summary: 'Chat apps that can be connected, the linked ones, and the primary one',
      tag: 'Channels',
      response: object({
        available: {
          type: 'array',
          items: object({
            type: { type: 'string', enum: [...CHAT_CHANNELS] },
            name: { type: 'string' },
            proactive: { type: 'boolean' },
          }),
        },
        ...CHANNELS_BODY,
      }),
    },
  },
  '/channels/{channel}/link': {
    post: {
      summary: 'One-time link that connects this chat app (t.me or wa.me)',
      tag: 'Channels',
      status: 201,
      response: object({ url: { type: 'string' }, expiresAt: { type: 'string' } }),
      errors: [503],
    },
  },
  '/channels/{channel}': {
    delete: { summary: 'Disconnect a chat app', tag: 'Channels', status: 204, response: null },
  },
  '/channels/primary': {
    put: {
      summary: 'Choose which linked chat app gets messages',
      tag: 'Channels',
      body: primaryChannelSchema,
      response: object(CHANNELS_BODY),
      errors: [409],
    },
  },
  '/briefing': {
    get: {
      summary: "Live numbers for today's briefing, and the last one sent",
      tag: 'Briefing',
      response: object({ briefing: ref('Briefing') }),
    },
  },
  '/briefing/send': {
    post: {
      summary: "Send today's briefing to Telegram now",
      tag: 'Briefing',
      status: 202,
      response: QUEUED,
      errors: [409],
    },
  },
  '/actions': {
    get: {
      summary: 'Activity log: what the assistant did or asked to do, newest first',
      tag: 'Actions',
      query: actionListQuerySchema,
      response: object({ actions: arrayOf('Action') }),
    },
  },
  '/actions/{id}/approve': {
    post: {
      summary: 'Approve a pending action (it runs now)',
      tag: 'Actions',
      response: object({ action: ref('Action'), outcome: { type: 'string' } }),
      errors: [404, 409],
    },
  },
  '/actions/{id}/reject': {
    post: {
      summary: 'Decline a pending action',
      tag: 'Actions',
      response: object({ action: ref('Action'), outcome: { type: 'string' } }),
      errors: [404, 409],
    },
  },
  '/conversations': {
    get: {
      summary: "The user's conversations",
      tag: 'Conversations',
      response: object({ conversations: arrayOf('Conversation') }),
    },
  },
  '/conversations/{id}/messages': {
    get: {
      summary: 'Messages, newest first',
      tag: 'Conversations',
      query: messagesQuerySchema,
      response: object({ messages: arrayOf('Message') }),
      errors: [404],
    },
  },
  '/emails': {
    get: {
      summary: 'Search synced email',
      tag: 'Email',
      query: searchQuerySchema,
      response: object({ emails: arrayOf('EmailSummary') }),
    },
  },
  '/emails/sync': {
    post: { summary: 'Queue a sync now', tag: 'Email', status: 202, response: QUEUED },
  },
  '/emails/{id}': {
    get: {
      summary: 'Full message with body (live from Gmail)',
      tag: 'Email',
      response: object({ email: ref('FullEmail') }),
      errors: [404, 409],
    },
  },
  '/emails/threads/{id}': {
    get: {
      summary: 'Whole thread (live from Gmail)',
      tag: 'Email',
      response: object({
        thread: object({ id: { type: 'string' }, messages: arrayOf('FullEmail') }),
      }),
      errors: [404, 409],
    },
  },
  '/calendar/events': {
    get: {
      summary: 'Events for local day(s), default today',
      tag: 'Calendar',
      query: eventsQuerySchema,
      response: object({
        events: arrayOf('CalendarEvent'),
        lastSyncedAt: nullable({ type: 'string' }),
      }),
    },
    post: {
      summary: 'Create an event (invites guests if any)',
      tag: 'Calendar',
      body: createEventSchema,
      status: 201,
      response: object({ event: nullable(ref('CalendarEvent')) }),
      errors: [409],
    },
  },
  '/calendar/events/{id}': {
    patch: {
      summary: 'Update or move (moving only the start keeps the duration)',
      tag: 'Calendar',
      body: updateEventSchema,
      response: object({ event: nullable(ref('CalendarEvent')) }),
      errors: [404, 409],
    },
    delete: { summary: 'Cancel', tag: 'Calendar', status: 204, response: null, errors: [409] },
  },
  '/calendar/availability': {
    get: {
      summary: 'Free intervals and suggested slots (live)',
      tag: 'Calendar',
      query: availabilityQuerySchema,
      response: ref('Availability'),
      errors: [409],
    },
  },
  '/calendar/sync': {
    post: { summary: 'Queue a calendar sync now', tag: 'Calendar', status: 202, response: QUEUED },
  },
  '/tasks': {
    get: {
      summary: 'Google Tasks (default list)',
      tag: 'Tasks',
      query: taskListQuerySchema,
      response: object({ tasks: arrayOf('Task') }),
      errors: [409],
    },
    post: {
      summary: 'Create a task',
      tag: 'Tasks',
      body: taskCreateSchema,
      status: 201,
      response: object({ task: ref('Task') }),
      errors: [409],
    },
  },
  '/tasks/{id}': {
    patch: {
      summary: 'Update a task',
      tag: 'Tasks',
      body: taskUpdateSchema,
      response: object({ task: ref('Task') }),
      errors: [404, 409],
    },
  },
  '/tasks/{id}/complete': {
    post: {
      summary: 'Complete a task',
      tag: 'Tasks',
      response: object({ task: ref('Task') }),
      errors: [404, 409],
    },
  },
  '/reminders': {
    get: {
      summary: 'Reminders',
      tag: 'Reminders',
      query: reminderListSchema,
      response: object({ reminders: arrayOf('Reminder') }),
    },
    post: {
      summary: 'Create a reminder (delivered on Telegram)',
      tag: 'Reminders',
      body: reminderCreateSchema,
      status: 201,
      response: object({ reminder: ref('Reminder') }),
      errors: [400],
    },
  },
  '/reminders/{id}': {
    delete: { summary: 'Cancel a pending reminder', tag: 'Reminders', status: 204, response: null },
  },
  '/memories': {
    get: {
      summary: 'Remembered facts',
      tag: 'Memory',
      response: object({ memories: arrayOf('Memory') }),
    },
    post: {
      summary: 'Remember a fact',
      tag: 'Memory',
      body: memorySchema,
      status: 201,
      response: object({ memory: ref('Memory') }),
    },
  },
  '/memories/{id}': {
    patch: {
      summary: 'Edit a fact',
      tag: 'Memory',
      body: memorySchema,
      response: object({ memory: ref('Memory') }),
      errors: [404],
    },
    delete: { summary: 'Forget a fact', tag: 'Memory', status: 204, response: null },
  },
  '/commitments': {
    get: {
      summary: 'Promises',
      tag: 'Commitments',
      query: commitmentListQuerySchema,
      response: object({ commitments: arrayOf('Commitment') }),
    },
    post: {
      summary: 'Record a promise by hand',
      tag: 'Commitments',
      body: commitmentCreateSchema,
      status: 201,
      response: object({ commitment: nullable(ref('Commitment')) }),
    },
  },
  '/commitments/{id}': {
    patch: {
      summary: 'Complete, cancel or edit a promise',
      tag: 'Commitments',
      body: commitmentPatchSchema,
      response: object({ commitment: ref('Commitment') }),
      errors: [404],
    },
  },
  '/follow-ups': {
    get: {
      summary: 'Sent email nobody has answered yet',
      tag: 'Follow-ups',
      query: followUpListQuerySchema,
      response: object({ followUps: arrayOf('FollowUp') }),
    },
  },
  '/follow-ups/{id}': {
    patch: {
      summary: 'Close or reopen a follow-up',
      tag: 'Follow-ups',
      body: followUpPatchSchema,
      response: object({ followUp: ref('FollowUp') }),
      errors: [404],
    },
  },
  '/auth/logout': {
    post: {
      summary: 'Clear the session cookie',
      tag: 'Auth',
      auth: false,
      status: 204,
      response: null,
    },
  },
  '/auth/logout-all': {
    post: { summary: 'Sign out every device', tag: 'Auth', status: 204, response: null },
  },
};

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request',
  401: 'Not signed in',
  404: 'Not found',
  409: 'Conflict (e.g. a service is not connected, or the request was already answered)',
  422: 'Validation failed',
  503: 'Not set up on this server',
};

function queryParameters(schema: z.ZodType): JsonSchema[] {
  const json = toJson(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query',
    // A default makes it optional to the caller, whatever the schema's input type says.
    required: required.has(name) && !('default' in property),
    schema: property,
  }));
}

function buildOperation(path: string, operation: Operation): JsonSchema {
  const status = String(operation.status ?? 200);
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  const errors = [
    ...(operation.auth === false ? [] : [401]),
    ...(operation.query || operation.body ? [422] : []),
    ...(operation.errors ?? []),
  ];
  return {
    summary: operation.summary,
    tags: [operation.tag],
    ...(operation.auth === false ? { security: [] } : {}),
    parameters: [...pathParams, ...(operation.query ? queryParameters(operation.query) : [])],
    ...(operation.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: toJson(operation.body, 'input') } },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: 'Success',
        ...(operation.response
          ? { content: { 'application/json': { schema: operation.response } } }
          : {}),
      },
      ...Object.fromEntries(
        errors.map((code) => [
          String(code),
          {
            description: STATUS_TEXT[code] ?? 'Error',
            content: { 'application/json': { schema: ref('ErrorBody') } },
          },
        ]),
      ),
    },
  };
}

export function buildOpenApiSpec(): JsonSchema {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Assistant API',
      version: '1.0.0',
      description:
        'The personal assistant API. Every response carries an `x-request-id` header; errors share the ErrorBody shape.',
    },
    servers: [{ url: API_PREFIX }],
    security: [{ session: [] }],
    paths: Object.fromEntries(
      Object.entries(routes).map(([path, methods]) => [
        path,
        Object.fromEntries(
          Object.entries(methods).map(([method, operation]) => [
            method,
            buildOperation(path, operation),
          ]),
        ),
      ]),
    ),
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
      },
      schemas: Object.fromEntries(
        Object.entries(components).map(([name, schema]) => [name, toJson(schema, 'output')]),
      ),
    },
  };
}
