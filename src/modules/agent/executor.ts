import { createPendingAction, recordAction } from '../actions/actions.service.js';
import { decide, RISK_LABELS } from '../actions/policy.js';
import type { ToolCall, ToolResult } from './llm/types.js';
import { runTool } from './tools/run.js';
import { type AgentTool, describeCall, riskOf, type ToolContext } from './tools/types.js';

/** A call stored for the user to approve; the channel shows it with Yes / No buttons. */
export interface PendingApproval {
  actionId: string;
  summary: string;
}

export interface ExecutedCall {
  result: ToolResult;
  pendingApproval?: PendingApproval;
}

/**
 * Runs one tool call: finds the tool, validates the model's arguments against the tool's schema,
 * then applies the permission policy. READ calls just run. Anything else runs, waits for the
 * user's approval, or is refused, depending on its risk and the user's settings — and is written
 * to the audit log either way. Failures become messages the model can act on, not exceptions.
 */
export async function executeToolCall(
  tools: AgentTool[],
  context: ToolContext,
  call: ToolCall,
): Promise<ExecutedCall> {
  const base = { callId: call.id, name: call.name };
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return { result: { ...base, error: `Unknown tool "${call.name}"` } };

  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
      .join('; ');
    return { result: { ...base, error: `Invalid arguments — ${issues}` } };
  }

  const risk = await riskOf(tool, parsed.data, context);
  const decision = decide(risk, context.user);

  if (risk === 'READ') {
    const outcome = await runTool(tool, context, parsed.data);
    return {
      result: outcome.ok ? { ...base, output: outcome.output } : { ...base, error: outcome.error },
    };
  }

  const action = {
    userId: context.user._id,
    conversationId: context.conversationId,
    tool: tool.name,
    risk,
    args: parsed.data,
    summary: (await describeCall(tool, parsed.data, context)).slice(0, 4000),
  };

  if (decision === 'deny') {
    await recordAction(action, { status: 'blocked' }, context.now);
    return {
      result: {
        ...base,
        error: `Not allowed: the user has turned off ${RISK_LABELS[risk]} in Settings → Permissions. Tell them, and don't try another way around it.`,
      },
    };
  }

  if (decision === 'confirm') {
    const pending = await createPendingAction(action, context.now);
    return {
      result: {
        ...base,
        output: {
          status: 'awaiting_approval',
          summary: action.summary,
          note: 'Nothing has happened yet. The user has been shown this with Yes / No buttons and it runs only if they tap Yes. Tell them in one line what you prepared and that it needs their OK. Do not say it is done.',
        },
      },
      pendingApproval: { actionId: pending.id, summary: action.summary },
    };
  }

  const outcome = await runTool(tool, context, parsed.data);
  await recordAction(
    action,
    outcome.ok
      ? { status: 'executed', result: outcome.output }
      : { status: 'failed', error: outcome.error },
    context.now,
  );
  return {
    result: outcome.ok ? { ...base, output: outcome.output } : { ...base, error: outcome.error },
  };
}
