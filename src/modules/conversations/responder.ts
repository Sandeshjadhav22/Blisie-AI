import { UserModel } from '../../models/user.model.js';
import { runAgent } from '../agent/orchestrator.js';
import type { IncomingMessage, OutgoingMessage } from './channel.types.js';

/**
 * Decides what to say back: slash commands are handled directly (fast, no LLM); everything else
 * goes to the agent.
 */
export type CommandHandler = (message: IncomingMessage, args: string) => Promise<OutgoingMessage[]>;

const HELP_TEXT = [
  "Hi! I'm your assistant. Just ask me things in plain words, like:",
  '',
  "- What's important today?",
  '- What meetings do I have tomorrow?',
  '- Did Rahul email me?',
  '- Remind me to call Rahul at 6',
  '- Remember that Rahul is our designer',
  '',
  'Shortcuts: /today · /free · /inbox · /tasks · /help',
].join('\n');

const commands = new Map<string, CommandHandler>([
  ['start', () => Promise.resolve([{ text: HELP_TEXT }])],
  ['help', () => Promise.resolve([{ text: HELP_TEXT }])],
]);

/** Lets feature modules add commands (e.g. `/inbox`) without this file importing them. */
export function registerCommand(name: string, handler: CommandHandler): void {
  commands.set(name, handler);
}

/** Parses `/command args` (also `/command@BotName args`, as Telegram sends in some clients). */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

export async function respond(message: IncomingMessage): Promise<OutgoingMessage[]> {
  const command = parseCommand(message.text);
  if (command) {
    const handler = commands.get(command.name);
    if (handler) return handler(message, command.args);
    return [{ text: `I don't know /${command.name} yet. Try /help.` }];
  }
  const user = await UserModel.findById(message.userId);
  if (!user) return [];
  const result = await runAgent({
    user,
    conversationId: message.conversationId,
    text: message.text,
    messageId: message.messageId,
  });
  return [
    {
      text: result.reply,
      format: 'markdown',
      metadata: {
        agent: {
          model: result.model,
          steps: result.steps,
          usage: result.usage,
          toolCalls: result.toolCalls,
        },
      },
    },
  ];
}
