import { randomUUID } from 'node:crypto';

import { ApiError, type Content, GoogleGenAI, type Part } from '@google/genai';

import {
  type AgentMessage,
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './types.js';

/** Converts our messages to Gemini `contents`. Exported for tests. */
export function toGeminiContents(messages: AgentMessage[]): Content[] {
  return messages.map((message): Content => {
    switch (message.role) {
      case 'user':
        return { role: 'user', parts: [{ text: message.text }] };
      case 'assistant':
        // Replay the model's own output unchanged: thought parts and their signatures must be
        // sent back exactly as received during function calling.
        if (message.raw) return message.raw;
        return { role: 'model', parts: [{ text: message.text ?? '' }] };
      case 'tool':
        return {
          role: 'user',
          parts: message.results.map((result): Part => ({
            functionResponse: {
              id: result.callId,
              name: result.name,
              response:
                result.error !== undefined ? { error: result.error } : { output: result.output },
            },
          })),
        };
    }
  });
}

/** Extracts visible text and tool calls from the model's parts (thoughts are not shown). */
export function fromGeminiContent(content: Content | undefined): Omit<LlmResponse, 'usage'> {
  const parts = content?.parts ?? [];
  const text = parts
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();
  const toolCalls = parts
    .filter((part) => part.functionCall?.name)
    .map((part) => ({
      id: part.functionCall?.id ?? randomUUID(),
      name: part.functionCall?.name ?? '',
      args: part.functionCall?.args ?? {},
    }));
  return { text: text || null, toolCalls, raw: content };
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: toGeminiContents(request.messages),
        config: {
          systemInstruction: request.system,
          tools: request.tools.length
            ? [
                {
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.parameters,
                  })),
                },
              ]
            : undefined,
          // We run tools ourselves so every call goes through validation and (later) permissions.
          automaticFunctionCalling: { disable: true },
        },
      });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429) throw new LlmError('rate_limited', error.message);
        if (error.status >= 500) throw new LlmError('unavailable', error.message);
        throw new LlmError('invalid_request', error.message);
      }
      throw new LlmError('unavailable', error instanceof Error ? error.message : String(error));
    }

    const candidate = response.candidates?.[0];
    if (!candidate?.content) {
      const reason =
        response.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no content';
      throw new LlmError('blocked', `Gemini returned no content (${reason})`);
    }

    return {
      ...fromGeminiContent(candidate.content),
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
