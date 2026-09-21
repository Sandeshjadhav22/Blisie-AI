import type { Credentials, OAuth2Client } from 'google-auth-library';
import type { Types } from 'mongoose';

import { IntegrationModel, REAUTH_REQUIRED } from '../../../models/integration.model.js';
import { decrypt, encrypt } from '../../../utils/crypto.js';
import { AppError } from '../../../utils/errors.js';
import { summarizeError } from '../../../utils/error-summary.js';
import { logger } from '../../../utils/logger.js';
import { createOAuthClient } from './google-oauth.js';
import { featuresFromScopes, type GoogleFeature } from './google.scopes.js';

/**
 * Authorized Google API clients for a user. The access token is refreshed automatically when it
 * expires, and the new token is saved (encrypted) so the next request doesn't refresh again.
 * The worker repo has an equivalent file — keep their behaviour in sync.
 */

export class GoogleNotConnectedError extends AppError {
  constructor() {
    super(409, 'GOOGLE_NOT_CONNECTED', 'Connect Google in Settings first');
  }
}

const FEATURE_LABELS: Record<GoogleFeature, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  tasks: 'Google Tasks',
};

export class GoogleFeatureNotConnectedError extends AppError {
  constructor(public readonly feature: GoogleFeature) {
    super(
      409,
      'GOOGLE_FEATURE_NOT_CONNECTED',
      `Connect ${FEATURE_LABELS[feature]} in Settings first`,
      {
        feature,
      },
    );
  }
}

export class GoogleReauthRequiredError extends AppError {
  constructor() {
    super(
      409,
      'GOOGLE_REAUTH_REQUIRED',
      'Google access was revoked. Reconnect Google in Settings.',
    );
  }
}

async function persistTokens(integrationId: Types.ObjectId, tokens: Credentials): Promise<void> {
  const update: Record<string, unknown> = {};
  if (tokens.access_token) update.accessToken = encrypt(tokens.access_token);
  if (tokens.expiry_date) update.expiresAt = new Date(tokens.expiry_date);
  // Google occasionally rotates the refresh token; keep the newest.
  if (tokens.refresh_token) update.refreshToken = encrypt(tokens.refresh_token);
  if (Object.keys(update).length > 0) {
    await IntegrationModel.updateOne({ _id: integrationId }, { $set: update });
  }
}

export async function getGoogleAuthClient(
  userId: Types.ObjectId,
  feature?: GoogleFeature,
): Promise<OAuth2Client> {
  const integration = await IntegrationModel.findOne({ userId, provider: 'google' }).select(
    '+accessToken +refreshToken',
  );
  if (!integration) {
    throw feature ? new GoogleFeatureNotConnectedError(feature) : new GoogleNotConnectedError();
  }
  if (feature && !featuresFromScopes(integration.scopes)[feature]) {
    throw new GoogleFeatureNotConnectedError(feature);
  }
  if (!integration.refreshToken || integration.lastError === REAUTH_REQUIRED) {
    throw new GoogleReauthRequiredError();
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: integration.accessToken ? decrypt(integration.accessToken) : undefined,
    refresh_token: decrypt(integration.refreshToken),
    expiry_date: integration.expiresAt?.getTime(),
  });
  client.on('tokens', (tokens) => {
    persistTokens(integration._id, tokens).catch((error: unknown) => {
      logger.error(
        { err: error, userId: userId.toString() },
        'Failed to save refreshed Google token',
      );
    });
  });
  return client;
}

/** True when Google says the refresh token is no longer valid (revoked, expired, password change). */
export function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const data = (error as { response?: { data?: { error?: unknown } } }).response?.data;
  return data?.error === 'invalid_grant' || (error as Error).message === 'invalid_grant';
}

export async function markReauthRequired(userId: Types.ObjectId): Promise<void> {
  await IntegrationModel.updateOne(
    { userId, provider: 'google' },
    { $set: { status: 'error', lastError: REAUTH_REQUIRED } },
  );
  logger.warn({ userId: userId.toString() }, 'Google grant revoked; user must reconnect');
}

/**
 * Runs a Google API call, translating a revoked grant into GoogleReauthRequiredError and flagging
 * the integration so the UI can ask the user to reconnect.
 */
export async function withGoogleAuth<T>(
  userId: Types.ObjectId,
  feature: GoogleFeature,
  fn: (auth: OAuth2Client) => Promise<T>,
): Promise<T> {
  const auth = await getGoogleAuthClient(userId, feature);
  try {
    return await fn(auth);
  } catch (error) {
    if (isInvalidGrant(error)) {
      await markReauthRequired(userId);
      throw new GoogleReauthRequiredError();
    }
    if (error instanceof AppError) throw error;
    // Anything else from Google (rate limits, outages): log a summary, answer with a clean 502.
    logger.error(
      { userId: userId.toString(), error: summarizeError(error) },
      'Google API request failed',
    );
    throw new AppError(502, 'GOOGLE_API_ERROR', 'Google request failed. Please try again.');
  }
}
