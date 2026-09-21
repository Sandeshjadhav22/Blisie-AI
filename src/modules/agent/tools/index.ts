import { findFreeTime, getCalendarEvents } from './calendar.tools.js';
import { readEmail, searchEmailsTool } from './email.tools.js';
import {
  forgetMemoryTool,
  saveMemoryTool,
  searchMemoryTool,
  updateMemoryTool,
} from './memory.tools.js';
import { cancelReminderTool, createReminderTool, listRemindersTool } from './reminder.tools.js';
import { getTasks } from './tasks.tools.js';
import type { AgentTool } from './types.js';

/**
 * Tools the agent may call. Only READ and low-risk, user-private WRITE tools for now: anything
 * that acts on the outside world (sending email, inviting people, moving meetings) waits for the
 * Phase 9 permission and confirmation system.
 */
export const defaultTools: AgentTool[] = [
  getCalendarEvents,
  findFreeTime,
  searchEmailsTool,
  readEmail,
  getTasks,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
  saveMemoryTool,
  searchMemoryTool,
  updateMemoryTool,
  forgetMemoryTool,
];
