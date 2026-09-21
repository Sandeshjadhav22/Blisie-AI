import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** The worker repo keeps an identical copy of this schema — change both together. */
export const INTEGRATION_PROVIDERS = ['google'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['active', 'error'] as const;

export const REAUTH_REQUIRED = 'reauth_required';

const integrationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: INTEGRATION_PROVIDERS, required: true },
    // The account's ID at the provider (Google `sub`) and its email.
    providerAccountId: { type: String, required: true },
    email: { type: String },
    // Encrypted with utils/crypto. Never selected unless explicitly requested.
    accessToken: { type: String, select: false },
    refreshToken: { type: String, select: false },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date },
    status: { type: String, enum: INTEGRATION_STATUSES, required: true, default: 'active' },
    // `reauth_required` means Google revoked the grant; the user must reconnect.
    lastError: { type: String },
    // Incremental Gmail sync cursor, maintained by the worker.
    gmailSync: {
      historyId: { type: String },
      lastSyncedAt: { type: Date },
      lastError: { type: String },
    },
    // Rolling-window calendar sync state, maintained by the worker.
    calendarSync: {
      lastSyncedAt: { type: Date },
      lastError: { type: String },
    },
  },
  { timestamps: true },
);

integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export type Integration = InferSchemaType<typeof integrationSchema>;
export type IntegrationDocument = HydratedDocument<Integration>;

export const IntegrationModel = model('Integration', integrationSchema);
