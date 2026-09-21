import { env } from '../../../config/env.js';
import { GeminiProvider } from './gemini.provider.js';
import type { LlmProvider } from './types.js';

let provider: LlmProvider | null | undefined;

/** The configured LLM, or null when no API key is set. */
export function getLlmProvider(): LlmProvider | null {
  if (provider === undefined) {
    provider = env.LLM_API_KEY ? new GeminiProvider(env.LLM_API_KEY, env.LLM_MODEL) : null;
  }
  return provider;
}

/** For tests and evals. */
export function setLlmProvider(next: LlmProvider | null): void {
  provider = next;
}
