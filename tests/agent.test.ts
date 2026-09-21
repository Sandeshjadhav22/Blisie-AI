import type { Content } from '@google/genai';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getQueue } from '../src/jobs/queues.js';
import { MemoryModel } from '../src/models/memory.model.js';
import { MessageModel } from '../src/models/message.model.js';
import { ReminderModel } from '../src/models/reminder.model.js';
import { fromGeminiContent, toGeminiContents } from '../src/modules/agent/llm/gemini.provider.js';
import { LlmError } from '../src/modules/agent/llm/types.js';
import { NOT_CONFIGURED_REPLY, runAgent } from '../src/modules/agent/orchestrator.js';
import { defaultTools } from '../src/modules/agent/tools/index.js';
import { toToolSpec } from '../src/modules/agent/tools/types.js';
import { markdownToTelegramHtml } from '../src/modules/telegram/telegram.format.js';
import { useTestDatabase } from './helpers/db.js';
import { call, say, ScriptedLlm } from './helpers/fake-llm.js';
import { connectGoogle } from './helpers/google.js';
import { createSignedInUser } from './helpers/session.js';

const { add, remove } = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));
vi.mock('../src/jobs/queues.js', () => ({ getQueue: vi.fn(() => ({ add, remove })) }));

useTestDatabase();

// Tue 22 Sep 2026, 9:00 AM in India.
const NOW = new Date('2026-09-22T03:30:00Z');

async function setup() {
  const { user } = await createSignedInUser({ name: 'Sandesh Jadhav' });
  user.timezone = 'Asia/Kolkata';
  await user.save();
  return { user, conversationId: new Types.ObjectId() };
}

function toolResults(llm: ScriptedLlm, requestIndex: number) {
  const last = llm.requests[requestIndex]?.messages.at(-1);
  return last?.role === 'tool' ? last.results : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue({});
  remove.mockResolvedValue(1);
});

describe('runAgent', () => {
  it('answers directly when no tools are needed', async () => {
    const { user, conversationId } = await setup();
    const llm = new ScriptedLlm([say('Hi Sandesh!')]);

    const result = await runAgent({ user, conversationId, text: 'hello', now: NOW, provider: llm });

    expect(result).toMatchObject({ reply: 'Hi Sandesh!', steps: 1, toolCalls: [] });
    const request = llm.requests[0];
    expect(request?.messages).toEqual([{ role: 'user', text: 'hello' }]);
    expect(request?.tools.map((tool) => tool.name)).toContain('create_reminder');
    // The model is told the local time, so it can resolve "at 6" and "tomorrow".
    expect(request?.system).toContain('Tuesday 22 September 2026, 9:00 AM (Asia/Kolkata)');
    expect(request?.system).toContain("Today's date is 2026-09-22");
  });

  it('"Remind me to call Rahul at 6" creates a reminder at 6 PM local time', async () => {
    const { user, conversationId } = await setup();
    const llm = new ScriptedLlm([
      call('create_reminder', { text: 'Call Rahul', localDateTime: '2026-09-22T18:00' }),
      say("Done — I'll remind you to call Rahul at 6:00 PM."),
    ]);

    const result = await runAgent({
      user,
      conversationId,
      text: 'Remind me to call Rahul at 6',
      now: NOW,
      provider: llm,
    });

    expect(result.reply).toMatch(/remind you to call Rahul/);
    expect(result.toolCalls).toEqual([
      {
        name: 'create_reminder',
        args: { text: 'Call Rahul', localDateTime: '2026-09-22T18:00' },
        ok: true,
      },
    ]);
    const reminder = await ReminderModel.findOne({ userId: user._id }).lean();
    expect(reminder).toMatchObject({ text: 'Call Rahul', status: 'pending', source: 'agent' });
    expect(reminder?.dueAt.toISOString()).toBe('2026-09-22T12:30:00.000Z');
    expect(getQueue).toHaveBeenCalledWith('reminders');
    expect(add).toHaveBeenCalledWith(
      'send',
      { reminderId: reminder?._id.toString() },
      expect.objectContaining({ jobId: `reminder-${reminder?._id.toString() ?? ''}` }),
    );

    // The model sees the tool's result, with the time already formatted for the user.
    expect(toolResults(llm, 1)).toEqual([
      expect.objectContaining({
        name: 'create_reminder',
        output: expect.objectContaining({ at: 'Tue 22 Sep, 6:00 PM' }),
      }),
    ]);
    // ...and its own previous turn is replayed verbatim (needed for Gemini thought signatures).
    expect(llm.requests[1]?.messages[1]).toMatchObject({
      role: 'assistant',
      raw: { model: 'raw', call: 'create_reminder' },
    });
  });

  it('returns validation errors to the model instead of running the tool', async () => {
    const { user, conversationId } = await setup();
    const llm = new ScriptedLlm([
      call('create_reminder', { text: 'Call Rahul', localDateTime: '6pm' }),
      say('What time exactly?'),
    ]);

    const result = await runAgent({
      user,
      conversationId,
      text: 'remind me',
      now: NOW,
      provider: llm,
    });

    expect(result.toolCalls[0]?.ok).toBe(false);
    expect(toolResults(llm, 1)[0]?.error).toMatch(/^Invalid arguments — localDateTime/);
    expect(await ReminderModel.countDocuments()).toBe(0);
  });

  it('refuses reminders in the past with an explanation', async () => {
    const { user, conversationId } = await setup();
    const llm = new ScriptedLlm([
      call('create_reminder', { text: 'x', localDateTime: '2026-09-21T18:00' }),
      say('That time has passed.'),
    ]);
    await runAgent({ user, conversationId, text: 'remind me yesterday', now: NOW, provider: llm });
    expect(toolResults(llm, 1)[0]?.error).toBe('That time has already passed');
  });

  it('reports unknown tools back to the model', async () => {
    const { user, conversationId } = await setup();
    const llm = new ScriptedLlm([call('send_email', { to: 'x' }), say("I can't send email yet.")]);
    await runAgent({ user, conversationId, text: 'email Rahul', now: NOW, provider: llm });
    expect(toolResults(llm, 1)[0]?.error).toBe('Unknown tool "send_email"');
  });

  it('relays a clear message when a service is not connected', async () => {
    const { user, conversationId } = await setup();
    const llm = new ScriptedLlm([
      call('get_calendar_events', {}),
      say('Connect your calendar first.'),
    ]);
    await runAgent({ user, conversationId, text: "what's on today?", now: NOW, provider: llm });
    expect(toolResults(llm, 1)[0]?.error).toMatch(/Google Calendar isn't connected/);
  });

  it('runs several tool calls from one step (e.g. a daily overview)', async () => {
    const { user, conversationId } = await setup();
    await connectGoogle(user, ['calendar', 'gmail']);
    const llm = new ScriptedLlm([
      {
        text: null,
        toolCalls: [
          { id: 'a', name: 'get_calendar_events', args: {} },
          { id: 'b', name: 'search_emails', args: { today: true, unreadOnly: true } },
        ],
        raw: {},
      },
      say('Quiet day!'),
    ]);

    const result = await runAgent({
      user,
      conversationId,
      text: "what's important today?",
      now: NOW,
      provider: llm,
    });

    expect(result.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['get_calendar_events', true],
      ['search_emails', true],
    ]);
    expect(toolResults(llm, 1).map((r) => r.callId)).toEqual(['a', 'b']);
  });

  it('remembers facts and brings them into later conversations', async () => {
    const { user, conversationId } = await setup();
    await runAgent({
      user,
      conversationId,
      text: 'Remember that Rahul is our designer',
      now: NOW,
      provider: new ScriptedLlm([
        call('save_memory', { content: 'Rahul is our designer', subject: 'Rahul' }),
        say('Got it — Rahul is your designer.'),
      ]),
    });
    expect(await MemoryModel.countDocuments({ userId: user._id })).toBe(1);

    const later = new ScriptedLlm([say('Rahul is your designer.')]);
    await runAgent({ user, conversationId, text: 'who is Rahul?', now: NOW, provider: later });
    expect(later.requests[0]?.system).toContain('Rahul is our designer [about: Rahul]');
  });

  it('includes earlier conversation turns but not the current message twice', async () => {
    const { user, conversationId } = await setup();
    const base = { conversationId, userId: user._id, channel: 'telegram' as const };
    await MessageModel.create({ ...base, role: 'user', text: 'Find a time to meet Amit' });
    await MessageModel.create({ ...base, role: 'assistant', text: 'Which day?' });
    const current = await MessageModel.create({ ...base, role: 'user', text: 'tomorrow' });

    const llm = new ScriptedLlm([say('OK')]);
    await runAgent({
      user,
      conversationId,
      text: 'tomorrow',
      messageId: current._id,
      now: NOW,
      provider: llm,
    });

    expect(llm.requests[0]?.messages).toEqual([
      { role: 'user', text: 'Find a time to meet Amit' },
      { role: 'assistant', text: 'Which day?' },
      { role: 'user', text: 'tomorrow' },
    ]);
  });

  it('gives friendly replies when the LLM fails or is not configured', async () => {
    const { user, conversationId } = await setup();
    const limited = new ScriptedLlm([
      () => {
        throw new LlmError('rate_limited', '429');
      },
    ]);
    expect((await runAgent({ user, conversationId, text: 'hi', provider: limited })).reply).toMatch(
      /a lot of requests/,
    );
    expect((await runAgent({ user, conversationId, text: 'hi', provider: null })).reply).toBe(
      NOT_CONFIGURED_REPLY,
    );
  });

  it('stops after the step limit', async () => {
    const { user, conversationId } = await setup();
    const loop = new ScriptedLlm(Array.from({ length: 6 }, () => call('list_reminders', {})));
    const result = await runAgent({ user, conversationId, text: 'loop', provider: loop });
    expect(result.steps).toBe(6);
    expect(result.reply).toMatch(/more steps than I'm allowed/);
  });
});

describe('tool specs', () => {
  it('produce provider-friendly JSON Schema for every tool', () => {
    for (const tool of defaultTools) {
      const spec = toToolSpec(tool);
      const json = JSON.stringify(spec.parameters);
      expect(spec.parameters.type).toBe('object');
      expect(json).not.toContain('$schema');
      expect(json).not.toContain('additionalProperties');
    }
  });

  it('only exposes tools that are safe without confirmation', () => {
    expect(defaultTools.every((tool) => tool.risk === 'READ' || tool.risk === 'WRITE')).toBe(true);
  });
});

describe('Gemini mapping', () => {
  it('replays raw model turns and sends tool results as function responses', () => {
    const raw: Content = {
      role: 'model',
      parts: [{ functionCall: { id: 'c1', name: 'get_tasks', args: {} }, thoughtSignature: 'sig' }],
    };
    expect(
      toGeminiContents([
        { role: 'user', text: 'tasks?' },
        { role: 'assistant', raw, toolCalls: [] },
        { role: 'tool', results: [{ callId: 'c1', name: 'get_tasks', output: { tasks: [] } }] },
        { role: 'tool', results: [{ callId: 'c2', name: 'x', error: 'nope' }] },
        { role: 'assistant', text: 'earlier reply' },
      ]),
    ).toEqual([
      { role: 'user', parts: [{ text: 'tasks?' }] },
      raw,
      {
        role: 'user',
        parts: [
          {
            functionResponse: { id: 'c1', name: 'get_tasks', response: { output: { tasks: [] } } },
          },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { id: 'c2', name: 'x', response: { error: 'nope' } } }],
      },
      { role: 'model', parts: [{ text: 'earlier reply' }] },
    ]);
  });

  it('reads calls and visible text, ignoring thoughts', () => {
    const parsed = fromGeminiContent({
      role: 'model',
      parts: [
        { text: 'thinking about it…', thought: true },
        { text: 'Let me check. ' },
        { functionCall: { name: 'get_tasks', args: { includeCompleted: false } } },
      ],
    });
    expect(parsed.text).toBe('Let me check.');
    expect(parsed.toolCalls).toEqual([
      { id: expect.any(String), name: 'get_tasks', args: { includeCompleted: false } },
    ]);
  });
});

describe('markdownToTelegramHtml', () => {
  it('renders the agent’s light Markdown', () => {
    expect(
      markdownToTelegramHtml(
        '**Today**\n- 10:00 *Standup*\n- Call `Rahul`\nSee [the doc](https://example.com/a?b=1)',
      ),
    ).toBe(
      '<b>Today</b>\n• 10:00 <i>Standup</i>\n• Call <code>Rahul</code>\nSee <a href="https://example.com/a?b=1">the doc</a>',
    );
  });

  it('escapes everything else, so model output cannot inject markup', () => {
    expect(markdownToTelegramHtml('<script>x</script> & [bad](javascript:alert(1))')).toBe(
      '&lt;script&gt;x&lt;/script&gt; &amp; [bad](javascript:alert(1))',
    );
  });
});
