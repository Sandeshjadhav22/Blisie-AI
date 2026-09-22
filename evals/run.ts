/**
 * Runs the agent evaluation set against the real LLM.
 *
 *   pnpm eval               # all cases
 *   pnpm eval reminder      # cases whose name contains "reminder"
 *
 * Needs LLM_API_KEY (and optionally LLM_MODEL). Uses an in-memory MongoDB; live Google calls and
 * reminder queuing are replaced with fakes, so nothing touches real accounts.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';

import { CalendarEventModel } from '../src/models/calendar-event.model.js';
import { CommitmentModel } from '../src/models/commitment.model.js';
import { EmailModel } from '../src/models/email.model.js';
import { MemoryModel } from '../src/models/memory.model.js';
import { UserModel } from '../src/models/user.model.js';
import { getLlmProvider } from '../src/modules/agent/llm/index.js';
import { runAgent } from '../src/modules/agent/orchestrator.js';
import { formatLocal, localDateTimeToUtc } from '../src/modules/agent/tools/format.js';
import { defaultTools } from '../src/modules/agent/tools/index.js';
import type { AgentTool } from '../src/modules/agent/tools/types.js';
import { encrypt } from '../src/utils/crypto.js';
import { type EvalCase, cases } from './cases.js';
import { IntegrationModel } from '../src/models/integration.model.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-09-22T03:30:00Z'); // Tue 22 Sep 2026, 9:00 AM IST
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

function local(value: string): Date {
  return localDateTimeToUtc(value.includes('T') ? value : `2026-09-22T${value}`, TZ);
}

function parseFrom(value: string) {
  const match = /^(.*)<(.+)>$/.exec(value);
  return match ? { name: match[1]?.trim(), email: match[2]?.trim() ?? value } : { email: value };
}

async function seed(testCase: EvalCase) {
  await mongoose.connection.db?.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  const user = await UserModel.create({
    name: 'Sandesh Jadhav',
    email: 'sandesh@example.com',
    googleId: 'eval',
    timezone: TZ,
    telegramId: '1',
  });
  await IntegrationModel.create({
    userId: user._id,
    provider: 'google',
    providerAccountId: 'eval',
    scopes: SCOPES,
    refreshToken: encrypt('x'),
    gmailSync: { lastSyncedAt: NOW },
    calendarSync: { lastSyncedAt: NOW },
  });
  const setup = testCase.setup ?? {};
  await EmailModel.insertMany(
    (setup.emails ?? []).map((email) => ({
      userId: user._id,
      gmailId: email.id,
      threadId: `t-${email.id}`,
      from: parseFrom(email.from),
      subject: email.subject,
      snippet: email.snippet,
      receivedAt: new Date(NOW.getTime() - email.minutesAgo * 60_000),
      isUnread: email.unread ?? false,
      isImportant: email.important ?? false,
      isInbox: true,
    })),
  );
  await CalendarEventModel.insertMany(
    (setup.events ?? []).map((event, index) => ({
      userId: user._id,
      googleEventId: `ev-${String(index)}`,
      summary: event.title,
      start: local(event.start),
      end: local(event.end),
      attendees: (event.attendees ?? []).map((email) => ({ email })),
      myResponseStatus: 'accepted',
    })),
  );
  await CommitmentModel.insertMany(
    (setup.commitments ?? []).map((commitment) => ({
      userId: user._id,
      description: commitment.description,
      direction: commitment.direction ?? 'outgoing',
      person: { name: commitment.person },
      source: 'user',
      confidence: 1,
      detectedAt: NOW,
      dueAt: commitment.dueLocal ? local(commitment.dueLocal) : undefined,
      dedupeKey: commitment.description.toLowerCase(),
    })),
  );
  await MemoryModel.insertMany(
    (setup.memories ?? []).map((memory) => ({ userId: user._id, ...memory })),
  );
  return user;
}

/** Real tools, except the ones that would call Google live or queue jobs. */
function toolsFor(testCase: EvalCase): AgentTool[] {
  const setup = testCase.setup ?? {};
  const fakes: Record<string, AgentTool['execute']> = {
    get_tasks: () =>
      Promise.resolve({
        tasks: (setup.tasks ?? []).map((t) => ({
          title: t.title,
          due: t.due ?? null,
          done: false,
        })),
      }),
    read_email: (_ctx, args) => {
      const email = setup.emails?.find((e) => e.id === (args as { id: string }).id);
      return email
        ? Promise.resolve({
            from: email.from,
            subject: email.subject,
            body: email.body ?? email.snippet,
          })
        : Promise.reject(new Error('Email not found'));
    },
    find_free_time: () =>
      Promise.resolve({
        workingHours: '09:00–18:00',
        freeSlots: (setup.freeSlots ?? []).map((start) => {
          const from = local(start);
          return `${formatLocal(from, TZ)} – ${formatLocal(new Date(from.getTime() + 30 * 60_000), TZ)}`;
        }),
      }),
    create_reminder: (_ctx, args) => {
      const { text, localDateTime } = args as { text: string; localDateTime: string };
      return Promise.resolve({
        id: 'r1',
        text,
        at: formatLocal(localDateTimeToUtc(localDateTime, TZ), TZ),
      });
    },
  };
  return defaultTools.map((tool) => {
    const execute = fakes[tool.name];
    return execute ? { ...tool, execute } : tool;
  });
}

function check(
  testCase: EvalCase,
  reply: string,
  calls: { name: string; args: Record<string, unknown> }[],
) {
  const failures: string[] = [];
  const called = new Set(calls.map((c) => c.name));
  const { expect } = testCase;
  for (const name of expect.calls ?? []) {
    if (!called.has(name)) failures.push(`expected a call to ${name}`);
  }
  for (const name of expect.notCalls ?? []) {
    if (called.has(name)) failures.push(`must not call ${name}`);
  }
  for (const rule of expect.args ?? []) {
    const matching = calls.filter((c) => c.name === rule.tool);
    if (!matching.some((c) => rule.check(c.args))) {
      failures.push(
        `${rule.tool} args: ${rule.describe} (got ${JSON.stringify(matching.map((c) => c.args))})`,
      );
    }
  }
  for (const pattern of expect.reply ?? []) {
    if (!pattern.test(reply)) failures.push(`reply should match ${String(pattern)}`);
  }
  for (const pattern of expect.replyNot ?? []) {
    if (pattern.test(reply)) failures.push(`reply must not match ${String(pattern)}`);
  }
  return failures;
}

async function main() {
  const provider = getLlmProvider();
  if (!provider) {
    process.stderr.write('Set LLM_API_KEY (and optionally LLM_MODEL) to run the evals.\n');
    process.exit(2);
  }
  const filter = process.argv[2]?.toLowerCase();
  const selected = cases.filter((c) => !filter || c.name.toLowerCase().includes(filter));

  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());

  let passed = 0;
  for (const testCase of selected) {
    const user = await seed(testCase);
    const started = Date.now();
    const result = await runAgent({
      user,
      conversationId: new Types.ObjectId(),
      text: testCase.message,
      now: NOW,
      provider,
      tools: toolsFor(testCase),
    });
    const failures = check(testCase, result.reply, result.toolCalls);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (failures.length === 0) passed += 1;
    process.stdout.write(
      `${failures.length === 0 ? '✅' : '❌'} ${testCase.name} (${seconds}s, tools: ${
        result.toolCalls.map((c) => c.name).join(', ') || 'none'
      })\n`,
    );
    if (failures.length > 0) {
      for (const failure of failures) process.stdout.write(`     - ${failure}\n`);
      process.stdout.write(`     reply: ${result.reply.replace(/\n/g, ' ⏎ ').slice(0, 300)}\n`);
    }
  }

  process.stdout.write(
    `\n${String(passed)}/${String(selected.length)} passed (${provider.name} ${provider.model})\n`,
  );
  await mongoose.disconnect();
  await server.stop();
  process.exit(passed === selected.length ? 0 : 1);
}

void main();
