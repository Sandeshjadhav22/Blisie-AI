import { Router } from 'express';

import { actionsRouter } from './modules/actions/actions.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { registerBriefingCommands } from './modules/briefing/briefing.commands.js';
import { briefingRouter } from './modules/briefing/briefing.routes.js';
import { channelsRouter } from './modules/channels/channels.routes.js';
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
import { handoffRouter } from './modules/handoff/handoff.routes.js';
import { integrationsRouter } from './modules/integrations/integrations.routes.js';
import { memoriesRouter } from './modules/memory/memory.routes.js';
import { remindersRouter } from './modules/reminders/reminders.routes.js';
import { registerTasksCommands } from './modules/integrations/tasks/tasks.commands.js';
import { tasksRouter } from './modules/integrations/tasks/tasks.routes.js';
import { registerTelegramChannel } from './modules/telegram/telegram.adapter.js';
import { telegramRouter } from './modules/telegram/telegram.routes.js';
import { registerWhatsAppChannel } from './modules/whatsapp/whatsapp.adapter.js';
import { whatsappRouter } from './modules/whatsapp/whatsapp.routes.js';
import { waitlistRouter } from './modules/waitlist/waitlist.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { requireApproved } from './middleware/require-auth.js';

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

apiRouter.use('/waitlist', waitlistRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/handoff', handoffRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/channels', channelsRouter);
apiRouter.use('/telegram', telegramRouter);
apiRouter.use('/whatsapp', whatsappRouter);
apiRouter.use('/conversations', requireApproved, conversationsRouter);
apiRouter.use('/emails', requireApproved, emailsRouter);
apiRouter.use('/calendar', requireApproved, calendarRouter);
apiRouter.use('/tasks', requireApproved, tasksRouter);
apiRouter.use('/reminders', requireApproved, remindersRouter);
apiRouter.use('/memories', requireApproved, memoriesRouter);
apiRouter.use('/commitments', requireApproved, commitmentsRouter);
apiRouter.use('/follow-ups', requireApproved, followUpsRouter);
apiRouter.use('/briefing', requireApproved, briefingRouter);
apiRouter.use('/actions', requireApproved, actionsRouter);

// Chat apps. Each is off until its credentials are set.
registerTelegramChannel();
registerWhatsAppChannel();

// Chat commands contributed by feature modules.
registerGmailCommands();
registerCalendarCommands();
registerTasksCommands();
registerCommitmentCommands();
registerFollowUpCommands();
registerBriefingCommands();
