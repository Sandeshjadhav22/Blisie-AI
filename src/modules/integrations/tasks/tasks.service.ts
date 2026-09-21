import { tasks as tasksApi, type tasks_v1 } from '@googleapis/tasks';
import type { OAuth2Client } from 'google-auth-library';
import type { Types } from 'mongoose';

import { NotFoundError } from '../../../utils/errors.js';
import { withGoogleAuth } from '../google/google-client.js';

/**
 * Google Tasks, read and written live (task lists are small, and staleness would be confusing).
 * Everything uses the user's default list.
 */
const LIST = '@default';

function api(auth: OAuth2Client) {
  return tasksApi({ version: 'v1', auth });
}

export interface PublicTask {
  id: string;
  title: string;
  notes: string | null;
  status: 'needsAction' | 'completed';
  /** "YYYY-MM-DD" — Google Tasks stores due dates without a time. */
  due: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export function toPublicTask(task: tasks_v1.Schema$Task): PublicTask {
  return {
    id: task.id ?? '',
    title: task.title ?? '',
    notes: task.notes ?? null,
    status: task.status === 'completed' ? 'completed' : 'needsAction',
    due: task.due ? task.due.slice(0, 10) : null,
    completedAt: task.completed ?? null,
    updatedAt: task.updated ?? null,
  };
}

/** Google Tasks wants an RFC 3339 timestamp and ignores the time part. */
function toDueTimestamp(date: string | null): string | null {
  return date ? `${date}T00:00:00.000Z` : null;
}

function rethrowNotFound(error: unknown): never {
  if ((error as { status?: number }).status === 404) throw new NotFoundError('Task not found');
  throw error;
}

export async function listTasks(
  userId: Types.ObjectId,
  options: { includeCompleted: boolean },
): Promise<PublicTask[]> {
  return withGoogleAuth(userId, 'tasks', async (auth) => {
    const tasks: tasks_v1.Schema$Task[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await api(auth).tasks.list({
        tasklist: LIST,
        showCompleted: options.includeCompleted,
        showHidden: options.includeCompleted,
        maxResults: 100,
        pageToken,
      });
      tasks.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    // Open tasks first, then by due date (undated last), then by title.
    return tasks.map(toPublicTask).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'needsAction' ? -1 : 1;
      if (a.due !== b.due)
        return a.due === null ? 1 : b.due === null ? -1 : a.due.localeCompare(b.due);
      return a.title.localeCompare(b.title);
    });
  });
}

export interface TaskInput {
  title: string;
  notes?: string;
  due?: string | null;
}

export async function createTask(userId: Types.ObjectId, input: TaskInput): Promise<PublicTask> {
  return withGoogleAuth(userId, 'tasks', async (auth) => {
    const { data } = await api(auth).tasks.insert({
      tasklist: LIST,
      requestBody: {
        title: input.title,
        notes: input.notes,
        due: toDueTimestamp(input.due ?? null),
      },
    });
    return toPublicTask(data);
  });
}

export type TaskPatch = Partial<TaskInput> & { status?: 'needsAction' | 'completed' };

export async function updateTask(
  userId: Types.ObjectId,
  taskId: string,
  patch: TaskPatch,
): Promise<PublicTask> {
  return withGoogleAuth(userId, 'tasks', async (auth) => {
    try {
      const { data } = await api(auth).tasks.patch({
        tasklist: LIST,
        task: taskId,
        requestBody: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.due !== undefined ? { due: toDueTimestamp(patch.due) } : {}),
          ...(patch.status !== undefined
            ? // Reopening a task requires clearing its completion time.
              {
                status: patch.status,
                ...(patch.status === 'needsAction' ? { completed: null } : {}),
              }
            : {}),
        },
      });
      return toPublicTask(data);
    } catch (error) {
      rethrowNotFound(error);
    }
  });
}

export async function completeTask(userId: Types.ObjectId, taskId: string): Promise<PublicTask> {
  return updateTask(userId, taskId, { status: 'completed' });
}
