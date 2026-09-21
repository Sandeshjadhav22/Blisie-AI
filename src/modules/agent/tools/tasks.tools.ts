import { z } from 'zod';

import { listTasks } from '../../integrations/tasks/tasks.service.js';
import { requireFeature } from './format.js';
import { defineTool } from './types.js';

export const getTasks = defineTool({
  name: 'get_tasks',
  description: "Lists the user's Google Tasks (open ones by default), soonest due first.",
  risk: 'READ',
  schema: z.object({ includeCompleted: z.boolean().optional() }),
  async execute({ user }, { includeCompleted }) {
    await requireFeature(user, 'tasks', { needsSync: false });
    const tasks = await listTasks(user._id, { includeCompleted: includeCompleted ?? false });
    return {
      tasks: tasks.slice(0, 30).map((task) => ({
        title: task.title,
        due: task.due,
        done: task.status === 'completed',
        notes: task.notes?.slice(0, 200),
      })),
    };
  },
});
