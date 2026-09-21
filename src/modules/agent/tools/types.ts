import type { Types } from 'mongoose';
import { z } from 'zod';

import type { UserDocument } from '../../../models/user.model.js';
import type { JsonSchema, ToolSpec } from '../llm/types.js';

/**
 * Risk levels every tool declares. Phase 9's permission engine decides from these whether a call
 * runs straight away or needs the user's confirmation; until then only READ and low-risk WRITE
 * tools are exposed.
 */
export type ToolRisk = 'READ' | 'WRITE' | 'EXTERNAL_ACTION' | 'DESTRUCTIVE';

export interface ToolContext {
  user: UserDocument;
  conversationId: Types.ObjectId;
  now: Date;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: S;
  execute(context: ToolContext, args: z.infer<S>): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool {
  return tool;
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
