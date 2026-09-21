import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ToolCall,
} from '../../src/modules/agent/llm/types.js';

type Step = LlmResponse | ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>);

/** An LLM that plays back a script, recording every request it receives. */
export class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-model';
  requests: LlmRequest[] = [];
  private steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    // Snapshot: the orchestrator keeps mutating its message list.
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.steps.shift();
    if (!step) throw new Error('ScriptedLlm ran out of steps');
    return typeof step === 'function' ? step(request) : step;
  }
}

export const say = (text: string): LlmResponse => ({ text, toolCalls: [], raw: { text } });

export const call = (
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}`,
): LlmResponse => {
  const toolCall: ToolCall = { id, name, args };
  return { text: null, toolCalls: [toolCall], raw: { model: 'raw', call: name } };
};

/** Echoes the latest user message — stands in for the agent in channel tests. */
export class EchoLlm implements LlmProvider {
  readonly name = 'echo';
  readonly model = 'echo';
  generate(request: LlmRequest): Promise<LlmResponse> {
    const last = [...request.messages].reverse().find((m) => m.role === 'user');
    return Promise.resolve(say(`You said: ${last?.role === 'user' ? last.text : ''}`));
  }
}
