import { AppError } from '../../../utils/errors.js';
import { summarizeError } from '../../../utils/error-summary.js';
import { logger } from '../../../utils/logger.js';
import { type AgentTool, type ToolContext, ToolError } from './types.js';

/** Keep tool output small: it's sent to the model on every following step. */
const MAX_OUTPUT_CHARS = 12_000;

function truncate(output: unknown): unknown {
  // `undefined` output (a tool with nothing to say) stringifies to undefined.
  const json = JSON.stringify(output) as string | undefined;
  if (json === undefined || json.length <= MAX_OUTPUT_CHARS) return output;
  return { truncated: true, partial: json.slice(0, MAX_OUTPUT_CHARS) };
}

export type ToolOutcome = { ok: true; output: unknown } | { ok: false; error: string };

/**
 * Runs a tool with already-validated arguments, turning failures into messages (for the model or
 * the user) instead of exceptions. Used for calls that run straight away and approved ones.
 */
export async function runTool(
  tool: AgentTool,
  context: ToolContext,
  args: unknown,
): Promise<ToolOutcome> {
  try {
    return { ok: true, output: truncate(await tool.execute(context, args)) };
  } catch (error) {
    if (error instanceof ToolError || error instanceof AppError) {
      return { ok: false, error: error.message };
    }
    logger.error(
      { tool: tool.name, userId: context.user.id, error: summarizeError(error) },
      'Agent tool failed',
    );
    return {
      ok: false,
      error: 'The tool failed unexpectedly. Tell the user to try again shortly.',
    };
  }
}
