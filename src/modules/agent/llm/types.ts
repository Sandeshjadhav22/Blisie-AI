/**
 * Provider-agnostic LLM interface. The orchestrator only speaks these types, so swapping Gemini
 * for another model means writing one new provider, nothing else.
 */

/** JSON Schema for a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  output?: unknown;
  error?: string;
}

export type AgentMessage =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text?: string | null;
      toolCalls?: ToolCall[];
      /**
       * The provider's native form of this turn, replayed verbatim on the next request.
       * Some models (Gemini thinking models) require their exact output, including signatures,
       * to be sent back during tool calling.
       */
      raw?: unknown;
    }
  | { role: 'tool'; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: ToolCall[];
  raw: unknown;
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/** Errors a provider raises that the orchestrator turns into a friendly reply. */
export class LlmError extends Error {
  constructor(
    public readonly kind:
      'rate_limited' | 'quota_exhausted' | 'unavailable' | 'blocked' | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
