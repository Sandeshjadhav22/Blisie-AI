import { env } from '../../../config/env.js';
import { AppError } from '../../../utils/errors.js';
import type { OutgoingMessage } from '../../conversations/channel.types.js';
import { registerCommand } from '../../conversations/responder.js';
import { listTasks } from './tasks.service.js';

const MAX_LISTED = 15;

/** `/tasks` — open Google Tasks, soonest due first. */
async function openTasks(userId: Parameters<typeof listTasks>[0]): Promise<OutgoingMessage[]> {
  try {
    const tasks = await listTasks(userId, { includeCompleted: false });
    if (tasks.length === 0) return [{ text: 'No open tasks. 🎉' }];
    const lines = tasks.slice(0, MAX_LISTED).map((task) => {
      const due = task.due ? ` _(due ${task.due})_` : '';
      return `☐ ${task.title || '(untitled)'}${due}`;
    });
    const more = tasks.length > MAX_LISTED ? `\n…and ${tasks.length - MAX_LISTED} more` : '';
    return [
      {
        text: `✅ **${tasks.length} open task${tasks.length === 1 ? '' : 's'}**\n\n${lines.join('\n')}${more}`,
        format: 'markdown',
      },
    ];
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) {
      const link = new URL('/settings/integrations', env.FRONTEND_URL).toString();
      return [{ text: `${error.message}: ${link}` }];
    }
    throw error;
  }
}

export function registerTasksCommands(): void {
  registerCommand('tasks', (message) => openTasks(message.userId));
}
