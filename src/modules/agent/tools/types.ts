import type { Types } from 'mongoose';
import { z } from 'zod';

import type { UserDocument } from '../../../models/user.model.js';
import type { JsonSchema, ToolSpec } from '../llm/types.js';

/**
 * Risk levels every tool declares. The permission policy (modules/actions/policy.ts) decides from
 * these, and the user's settings, whether a call runs straight away, waits for the user to approve
 * it on Telegram, or is refused:
 *
 * - READ: looks things up. Always runs.
 * - WRITE: changes the user's own data (a reminder, a task, a draft).
 * - EXTERNAL_ACTION: reaches other people (sends email, invites guests, moves a shared meeting).
 * - DESTRUCTIVE: can't be undone (cancelling a meeting). Always needs approval.
 */
export const TOOL_RISKS = ['READ', 'WRITE', 'EXTERNAL_ACTION', 'DESTRUCTIVE'] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

export interface ToolContext {
  user: UserDocument;
  conversationId: Types.ObjectId;
  now: Date;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Fixed, or worked out from the call (e.g. an event with guests reaches other people). */
  risk: ToolRisk | ((args: z.infer<S>, context: ToolContext) => ToolRisk | Promise<ToolRisk>);
  schema: S;
  /**
   * One plain line saying what this call will do ("Send an email to Rahul: …"). Shown when asking
   * the user to approve it and in the activity log. Required for anything that isn't READ.
   */
  describe?: (args: z.infer<S>, context: ToolContext) => string | Promise<string>;
  execute(context: ToolContext, args: z.infer<S>): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool {
  return tool;
}

export async function riskOf(
  tool: AgentTool,
  args: unknown,
  context: ToolContext,
): Promise<ToolRisk> {
  return typeof tool.risk === 'function' ? tool.risk(args, context) : tool.risk;
}

export async function describeCall(
  tool: AgentTool,
  args: unknown,
  context: ToolContext,
): Promise<string> {
  return tool.describe ? tool.describe(args, context) : tool.name.replace(/_/g, ' ');
}

/** An error whose message is meant for the model to relay (e.g. "Calendar isn't connected"). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** JSON Schema keys some providers (Gemini) reject; validation still uses the zod schema. */
const UNSUPPORTED_KEYS = new Set(['$schema', 'additionalProperties']);

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSUPPORTED_KEYS.has(key))
        .map(([key, child]) => [key, clean(child)]),
    );
  }
  return value;
}

export function toToolSpec(tool: AgentTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: clean(z.toJSONSchema(tool.schema)) as JsonSchema,
  };
}
