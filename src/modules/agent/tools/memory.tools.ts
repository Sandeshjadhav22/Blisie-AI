import { z } from 'zod';

import {
  deleteMemory,
  saveMemory,
  searchMemories,
  updateMemory,
} from '../../memory/memory.service.js';
import { defineTool } from './types.js';

export const saveMemoryTool = defineTool({
  name: 'save_memory',
  description:
    "Remembers a lasting fact about the user's life or work, e.g. 'Rahul is our designer', 'I prefer morning meetings'. Use when they say 'remember …' or share something clearly worth keeping. Not for one-off tasks (use create_reminder).",
  risk: 'WRITE',
  schema: z.object({
    content: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('The fact, as a short standalone sentence.'),
    subject: z.string().trim().max(100).optional().describe("Who/what it's about, e.g. 'Rahul'."),
  }),
  async execute({ user }, { content, subject }) {
    const memory = await saveMemory(user._id, { content, subject, source: 'user' });
    return { id: memory.id, saved: memory.content };
  },
});

export const searchMemoryTool = defineTool({
  name: 'search_memory',
  description:
    "Searches facts you've been asked to remember, e.g. before answering 'who is Rahul?' or when a person is mentioned.",
  risk: 'READ',
  schema: z.object({ query: z.string().trim().min(1).max(200) }),
  async execute({ user }, { query }) {
    const memories = await searchMemories(user._id, query, 10);
    return {
      memories: memories.map((m) => ({ id: m.id, content: m.content, subject: m.subject })),
    };
  },
});

export const updateMemoryTool = defineTool({
  name: 'update_memory',
  description: 'Corrects a remembered fact by id (e.g. Rahul moved from design to sales).',
  risk: 'WRITE',
  schema: z.object({
    id: z.string(),
    content: z.string().trim().min(1).max(1000),
    subject: z.string().trim().max(100).optional(),
  }),
  async execute({ user }, { id, content, subject }) {
    const memory = await updateMemory(user._id, id, { content, subject });
    return { id: memory.id, saved: memory.content };
  },
});

export const forgetMemoryTool = defineTool({
  name: 'forget_memory',
  description: 'Deletes a remembered fact by id when the user asks you to forget it.',
  risk: 'WRITE',
  schema: z.object({ id: z.string() }),
  async execute({ user }, { id }) {
    await deleteMemory(user._id, id);
    return { forgotten: true };
  },
});
