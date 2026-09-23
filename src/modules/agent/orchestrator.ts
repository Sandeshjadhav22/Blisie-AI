import type { Types } from 'mongoose';

import type { UserDocument } from '../../models/user.model.js';
import { summarizeError } from '../../utils/error-summary.js';
import { logger } from '../../utils/logger.js';
import { loadContext } from './context.js';
import { executeToolCall, type PendingApproval } from './executor.js';
import { getLlmProvider } from './llm/index.js';
import { type AgentMessage, LlmError, type LlmProvider, type LlmUsage } from './llm/types.js';
import { buildSystemPrompt } from './prompts/system.js';
import { defaultTools } from './tools/index.js';
import { type AgentTool, toToolSpec } from './tools/types.js';

/**
 * The agent loop:
 *
 *   message → context retrieval → LLM reasoning ⇄ tool calls (validated, executed by us) → reply
 *
 * The LLM only ever *proposes* tool calls; this code decides whether and how they run. The
 * executor applies the permission policy: calls that need the user's OK come back as pending
 * approvals, which the channel shows with Yes / No buttons after the reply.
 */

const MAX_STEPS = 6;
const MAX_CALLS_PER_STEP = 8;

export interface AgentRunInput {
  user: UserDocument;
  conversationId: Types.ObjectId;
  text: string;
  /** The stored user message, so it isn't also loaded as history. */
  messageId?: Types.ObjectId;
  now?: Date;
  /** Overrides for tests and evals. */
  provider?: LlmProvider | null;
  tools?: AgentTool[];
}

export interface AgentRunResult {
  reply: string;
  toolCalls: { name: string; args: Record<string, unknown>; ok: boolean }[];
  /** Calls waiting for the user's approval, in the order the model made them. */
  pendingApprovals: PendingApproval[];
  steps: number;
  usage: LlmUsage;
  model?: string;
}

export const NOT_CONFIGURED_REPLY =
  "My AI brain isn't switched on yet (no LLM API key on the server). Meanwhile, try /today, /inbox, /tasks or /help.";

function failureReply(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.kind === 'rate_limited')
      return "I'm getting a lot of requests right now. Try again in a minute.";
    if (error.kind === 'quota_exhausted') {
      return "I've hit today's AI usage limit, so I can't answer questions until it resets. Shortcuts like /today, /inbox and /tasks still work.";
    }
    if (error.kind === 'blocked') return "Sorry, I can't help with that one.";
  }
  return 'Sorry, something went wrong on my side. Please try again in a moment.';
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const provider = input.provider === undefined ? getLlmProvider() : input.provider;
  const toolCalls: AgentRunResult['toolCalls'] = [];
  const pendingApprovals: PendingApproval[] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  if (!provider) {
    return { reply: NOT_CONFIGURED_REPLY, toolCalls, pendingApprovals, steps: 0, usage };
  }

  const now = input.now ?? new Date();
  const tools = input.tools ?? defaultTools;
  const context = await loadContext({
    user: input.user,
    conversationId: input.conversationId,
    text: input.text,
    beforeMessageId: input.messageId,
  });
  const system = buildSystemPrompt(input.user, context, now);
  const specs = tools.map(toToolSpec);
  const messages: AgentMessage[] = [...context.history, { role: 'user', text: input.text }];
  const toolContext = { user: input.user, conversationId: input.conversationId, now };

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    let response;
    try {
      response = await provider.generate({ system, messages, tools: specs });
    } catch (error) {
      logger.error(
        { userId: input.user.id, step, error: summarizeError(error) },
        'LLM request failed',
      );
      return {
        reply: failureReply(error),
        toolCalls,
        pendingApprovals,
        steps: step,
        usage,
        model: provider.model,
      };
    }
    usage.inputTokens = (usage.inputTokens ?? 0) + (response.usage?.inputTokens ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (response.usage?.outputTokens ?? 0);

    if (response.toolCalls.length === 0) {
      return {
        reply: response.text ?? "Sorry, I didn't catch that. Could you rephrase?",
        toolCalls,
        pendingApprovals,
        steps: step,
        usage,
        model: provider.model,
      };
    }

    const calls = response.toolCalls.slice(0, MAX_CALLS_PER_STEP);
    messages.push({ role: 'assistant', text: response.text, toolCalls: calls, raw: response.raw });
    const executed = await Promise.all(
      calls.map((call) => executeToolCall(tools, toolContext, call)),
    );
    const results = executed.map((item) => item.result);
    for (const item of executed) {
      if (item.pendingApproval) pendingApprovals.push(item.pendingApproval);
    }
    results.forEach((result, index) => {
      toolCalls.push({
        name: result.name,
        args: calls[index]?.args ?? {},
        ok: result.error === undefined,
      });
    });
    messages.push({ role: 'tool', results });
  }

  logger.warn({ userId: input.user.id, toolCalls: toolCalls.length }, 'Agent hit the step limit');
  return {
    reply: "That took more steps than I'm allowed. Could you break it into a smaller question?",
    toolCalls,
    pendingApprovals,
    steps: MAX_STEPS,
    usage,
    model: provider.model,
  };
}
