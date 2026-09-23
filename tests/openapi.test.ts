import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import { ActionModel } from '../src/models/action.model.js';
import { CommitmentModel } from '../src/models/commitment.model.js';
import { ConversationModel } from '../src/models/conversation.model.js';
import { EmailModel } from '../src/models/email.model.js';
import { FollowUpModel } from '../src/models/follow-up.model.js';
import { MessageModel } from '../src/models/message.model.js';
import { ReminderModel } from '../src/models/reminder.model.js';
import * as schemas from '../src/openapi/schemas.js';
import { useTestDatabase } from './helpers/db.js';
import { connectGoogle } from './helpers/google.js';
import { createSignedInUser } from './helpers/session.js';

vi.mock('../src/jobs/queues.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));

useTestDatabase();

const app = createApp();

describe('OpenAPI spec', () => {
  it('is served and documents every public shape', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.components.schemas as object)).toEqual(
      Object.keys(schemas.components),
    );
  });

  it('only documents routes that exist', async () => {
    const spec = (await request(app).get('/api/v1/openapi.json')).body as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const url = `/api/v1${path.replace(/\{\w+\}/g, '000000000000000000000000')}`;
        const res = await request(app)[method as 'get'](url);
        // Without a session, a real route answers 401 (or 422/204 before auth) — never 404.
        expect(res.status, `${method.toUpperCase()} ${path}`).not.toBe(404);
        if (!operation.security && res.status !== 422) expect(res.status).toBe(401);
      }
    }
  });

  it('matches what the API actually returns', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGoogle(user, ['gmail']);
    const conversation = await ConversationModel.create({
      userId: user._id,
      channel: 'telegram',
      externalChatId: '1',
    });
    await MessageModel.create({
      conversationId: conversation._id,
      userId: user._id,
      channel: 'telegram',
      role: 'assistant',
      text: '**Hi**',
      metadata: { format: 'markdown' },
    });
    await EmailModel.create({
      userId: user._id,
      gmailId: 'g1',
      threadId: 't1',
      from: { name: 'Rahul', email: 'rahul@acme.com' },
      receivedAt: new Date(),
      isInbox: true,
      priority: 'high',
      priorityReason: 'Needs a reply',
    });
    await CommitmentModel.create({
      userId: user._id,
      description: 'Send it',
      person: { name: 'Rahul' },
      source: 'user',
      dueAt: new Date(),
      dedupeKey: 'send it',
    });
    await FollowUpModel.create({
      userId: user._id,
      threadId: 't1',
      gmailId: 'g0',
      to: [{ email: 'rahul@acme.com' }],
      sentAt: new Date(),
    });
    await ReminderModel.create({ userId: user._id, text: 'Call', dueAt: new Date() });
    await ActionModel.create({
      userId: user._id,
      tool: 'send_email',
      risk: 'EXTERNAL_ACTION',
      args: {},
      summary: 'Send an email',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const get = async (path: string) => {
      const res = await request(app).get(`/api/v1${path}`).set('Cookie', cookie);
      expect(res.status, path).toBe(200);
      return res.body as unknown;
    };
    const list = <T extends z.ZodType>(key: string, item: T) => z.object({ [key]: z.array(item) });

    z.object({ user: schemas.User }).parse(await get('/users/me'));
    list('integrations', schemas.Integration).parse(await get('/integrations'));
    list('emails', schemas.EmailSummary).parse(await get('/emails?inboxOnly=false'));
    list('commitments', schemas.Commitment).parse(await get('/commitments'));
    list('followUps', schemas.FollowUp).parse(await get('/follow-ups'));
    list('reminders', schemas.Reminder).parse(await get('/reminders?status=all'));
    list('memories', schemas.Memory).parse(await get('/memories'));
    list('actions', schemas.Action).parse(await get('/actions'));
    z.object({ briefing: schemas.Briefing }).parse(await get('/briefing'));
    list('conversations', schemas.Conversation).parse(await get('/conversations'));
    const { messages } = z
      .object({ messages: z.array(schemas.Message) })
      .parse(await get(`/conversations/${conversation.id}/messages`));
    expect(messages[0]?.format).toBe('markdown');
    schemas.ErrorBody.parse((await request(app).get('/api/v1/users/me')).body);
  });
});
