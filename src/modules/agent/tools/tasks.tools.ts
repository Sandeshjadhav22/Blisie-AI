import { z } from 'zod';

import { completeTask, createTask, listTasks } from '../../integrations/tasks/tasks.service.js';
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
        id: task.id,
        title: task.title,
        due: task.due,
        done: task.status === 'completed',
        notes: task.notes?.slice(0, 200),
      })),
    };
  },
});

export const createTaskTool = defineTool({
  name: 'create_task',
  description: "Adds a task to the user's Google Tasks (default list), with an optional due date.",
  risk: 'WRITE',
  schema: z.object({
    title: z.string().trim().min(1).max(500),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("YYYY-MM-DD in the user's timezone (Google Tasks has no due time)."),
    notes: z.string().trim().max(2000).optional(),
  }),
  describe: ({ title, due }) => `Add a task: “${title}”${due ? ` (due ${due})` : ''}`,
  async execute({ user }, { title, due, notes }) {
    await requireFeature(user, 'tasks', { needsSync: false });
    const task = await createTask(user._id, { title, due: due ?? null, notes });
    return { id: task.id, title: task.title, due: task.due };
  },
});

export const completeTaskTool = defineTool({
  name: 'complete_task',
  description: 'Ticks off a Google Task by id (from get_tasks).',
  risk: 'WRITE',
  schema: z.object({ id: z.string().min(1).max(200) }),
  describe: () => 'Mark a task as done',
  async execute({ user }, { id }) {
    await requireFeature(user, 'tasks', { needsSync: false });
    const task = await completeTask(user._id, id);
    return { done: task.title };
  },
});
