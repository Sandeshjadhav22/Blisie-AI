import { Router } from 'express';

import { authRouter } from './modules/auth/auth.routes.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { registerCalendarCommands } from './modules/integrations/calendar/calendar.commands.js';
import { calendarRouter } from './modules/integrations/calendar/calendar.routes.js';
import { registerGmailCommands } from './modules/integrations/gmail/gmail.commands.js';
import { emailsRouter } from './modules/integrations/gmail/gmail.routes.js';
import { integrationsRouter } from './modules/integrations/integrations.routes.js';
import { memoriesRouter } from './modules/memory/memory.routes.js';
import { remindersRouter } from './modules/reminders/reminders.routes.js';
import { registerTasksCommands } from './modules/integrations/tasks/tasks.commands.js';
import { tasksRouter } from './modules/integrations/tasks/tasks.routes.js';
import { telegramRouter } from './modules/telegram/telegram.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/** Versioned API router mounted at /api/v1. Feature modules register their routers here. */
export const apiRouter = Router();

apiRouter.get('/', (_req, res) => {
  res.json({ name: 'assistant-api', version: 'v1' });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/telegram', telegramRouter);
apiRouter.use('/conversations', conversationsRouter);
apiRouter.use('/emails', emailsRouter);
apiRouter.use('/calendar', calendarRouter);
apiRouter.use('/tasks', tasksRouter);
apiRouter.use('/reminders', remindersRouter);
apiRouter.use('/memories', memoriesRouter);

// Chat commands contributed by feature modules.
registerGmailCommands();
registerCalendarCommands();
registerTasksCommands();
