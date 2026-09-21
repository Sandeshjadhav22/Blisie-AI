import type { IncomingMessage, OutgoingMessage } from './channel.types.js';

/**
 * Decides what to say back. Slash commands are handled here; everything else is echoed until the
 * agent takes over in Phase 6.
 */
export type CommandHandler = (message: IncomingMessage, args: string) => Promise<OutgoingMessage[]>;

const HELP_TEXT = [
  "Hi! I'm your assistant. Here's what I can do so far:",
  '',
  '/inbox — emails you received today',
  '/help — show this message',
  '',
  "Soon you'll be able to just ask me things, and I'll keep track of what you've promised people and send you a morning briefing.",
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
  return [{ text: `You said: ${message.text}` }];
}
