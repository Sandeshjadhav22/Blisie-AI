import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

import { CHAT_CHANNELS } from '../modules/channels/policy.js';

/**
 * The audit log: every non-READ tool call the agent made or proposed, and what became of it.
 * A call that needs the user's approval is stored `pending` and runs only once they approve it.
 *
 * - pending → executing → executed | failed      (approved)
 * - pending → rejected | expired                 (declined, or never answered)
 * - executed | failed                            (ran straight away: allowed by the policy)
 * - blocked                                      (the user's settings forbid it)
 */
export const ACTION_STATUSES = [
  'pending',
  'executing',
  'executed',
  'failed',
  'rejected',
  'expired',
  'blocked',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_RISKS = ['READ', 'WRITE', 'EXTERNAL_ACTION', 'DESTRUCTIVE'] as const;

/** How a decision was made: by the policy, on the web, or with a chat app's buttons. */
export const ACTION_DECIDERS = ['policy', 'web', ...CHAT_CHANNELS] as const;
export type ActionDecider = (typeof ACTION_DECIDERS)[number];

const actionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    tool: { type: String, required: true },
    risk: { type: String, enum: ACTION_RISKS, required: true },
    /** The validated arguments, re-validated before an approved call runs. */
    args: { type: Schema.Types.Mixed, default: () => ({}) },
    /** What the call does, in plain words — what the user approves. */
    summary: { type: String, required: true, maxlength: 4000 },
    status: { type: String, enum: ACTION_STATUSES, required: true },
    decidedBy: { type: String, enum: ACTION_DECIDERS },
    decidedAt: { type: Date },
    executedAt: { type: Date },
    /** The tool's output (small), or why it failed. */
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    /** Pending approvals lapse after this, so a stale "Yes" can't send last week's email. */
    expiresAt: { type: Date },
    /** The chat message with the Yes/No buttons, so it can be updated once decided. */
    channelMessage: {
      channel: { type: String, enum: CHAT_CHANNELS },
      chatId: { type: String },
      messageId: { type: String },
    },
  },
  // Keep `{}` arguments as `{}` rather than dropping the field.
  { timestamps: true, minimize: false },
);

actionSchema.index({ userId: 1, createdAt: -1 });
actionSchema.index({ userId: 1, status: 1, expiresAt: 1 });

export type Action = InferSchemaType<typeof actionSchema>;
export type ActionDocument = HydratedDocument<Action>;

export const ActionModel = model('Action', actionSchema);
