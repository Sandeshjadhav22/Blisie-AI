import {
  cancelCalendarEvent,
  createCalendarEvent,
  findFreeTime,
  getCalendarEvents,
  updateCalendarEvent,
} from './calendar.tools.js';
import {
  cancelCommitment,
  completeCommitment,
  createCommitment,
  getCommitments,
} from './commitment.tools.js';
import { draftEmail, readEmail, searchEmailsTool, sendEmailTool } from './email.tools.js';
import { closeFollowUp, getWaitingOn } from './follow-up.tools.js';
import {
  forgetMemoryTool,
  saveMemoryTool,
  searchMemoryTool,
  updateMemoryTool,
} from './memory.tools.js';
import { cancelReminderTool, createReminderTool, listRemindersTool } from './reminder.tools.js';
import { completeTaskTool, createTaskTool, getTasks } from './tasks.tools.js';
import type { AgentTool } from './types.js';

/**
 * Tools the agent may call. Every call goes through the permission policy in the executor:
 * READ tools run, the rest run, wait for the user's approval, or are refused depending on their
 * risk and the user's settings (Settings → Permissions).
 */
export const defaultTools: AgentTool[] = [
  getCalendarEvents,
  findFreeTime,
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  searchEmailsTool,
  readEmail,
  draftEmail,
  sendEmailTool,
  getTasks,
  createTaskTool,
  completeTaskTool,
  getCommitments,
  createCommitment,
  completeCommitment,
  cancelCommitment,
  getWaitingOn,
  closeFollowUp,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
  saveMemoryTool,
  searchMemoryTool,
  updateMemoryTool,
  forgetMemoryTool,
];
