import { enqueueManualBriefing } from '../../jobs/briefing.js';
import { registerCommand } from '../conversations/responder.js';

/** `/briefing` — today's briefing, now, from the worker (same message as the morning one). */
export function registerBriefingCommands(): void {
  registerCommand('briefing', async (message) => {
    await enqueueManualBriefing(message.userId.toString());
    return [{ text: 'Putting your briefing together — it will arrive in a moment.' }];
  });
}
