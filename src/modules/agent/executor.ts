import { AppError } from '../../utils/errors.js';
import { summarizeError } from '../../utils/error-summary.js';
import { logger } from '../../utils/logger.js';
import type { ToolCall, ToolResult } from './llm/types.js';
import { type AgentTool, type ToolContext, ToolError } from './tools/types.js';

/** Keep tool output small: it's sent to the model on every following step. */
const MAX_OUTPUT_CHARS = 12_000;

function truncate(output: unknown): unknown {
  const json = JSON.stringify(output);
  if (json.length <= MAX_OUTPUT_CHARS) return output;
  return { truncated: true, partial: json.slice(0, MAX_OUTPUT_CHARS) };
}

/**
 * Runs one tool call: finds the tool, validates the model's arguments against the tool's schema,
 * and turns failures into error messages the model can act on instead of exceptions.
 */
export async function executeToolCall(
  tools: AgentTool[],
  context: ToolContext,
  call: ToolCall,
): Promise<ToolResult> {
  const base = { callId: call.id, name: call.name };
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return { ...base, error: `Unknown tool "${call.name}"` };

  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
      .join('; ');
    return { ...base, error: `Invalid arguments — ${issues}` };
  }

  try {
    return { ...base, output: truncate(await tool.execute(context, parsed.data)) };
  } catch (error) {
    if (error instanceof ToolError || error instanceof AppError) {
      return { ...base, error: error.message };
    }
    logger.error(
      { tool: call.name, userId: context.user.id, error: summarizeError(error) },
      'Agent tool failed',
    );
    return { ...base, error: 'The tool failed unexpectedly. Tell the user to try again shortly.' };
  }
}
