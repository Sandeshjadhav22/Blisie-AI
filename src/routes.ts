import { Router } from 'express';

import { actionsRouter } from './modules/actions/actions.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { registerBriefingCommands } from './modules/briefing/briefing.commands.js';
import { briefingRouter } from './modules/briefing/briefing.routes.js';
import { registerCommitmentCommands } from './modules/commitments/commitments.commands.js';
import { commitmentsRouter } from './modules/commitments/commitments.routes.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { buildOpenApiSpec } from './openapi/spec.js';
import { registerCalendarCommands } from './modules/integrations/calendar/calendar.commands.js';
import { calendarRouter } from './modules/integrations/calendar/calendar.routes.js';
import { registerGmailCommands } from './modules/integrations/gmail/gmail.commands.js';
import { emailsRouter } from './modules/integrations/gmail/gmail.routes.js';
import { registerFollowUpCommands } from './modules/follow-ups/follow-ups.commands.js';
import { followUpsRouter } from './modules/follow-ups/follow-ups.routes.js';
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

let spec: unknown;
/** The OpenAPI description of this API (the frontend generates its types from it). */
apiRouter.get('/openapi.json', (_req, res) => {
  spec ??= buildOpenApiSpec();
  res.json(spec);
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
apiRouter.use('/commitments', commitmentsRouter);
apiRouter.use('/follow-ups', followUpsRouter);
apiRouter.use('/briefing', briefingRouter);
apiRouter.use('/actions', actionsRouter);

// Chat commands contributed by feature modules.
registerGmailCommands();
registerCalendarCommands();
registerTasksCommands();
registerCommitmentCommands();
registerFollowUpCommands();
registerBriefingCommands();
