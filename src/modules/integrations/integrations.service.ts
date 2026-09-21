import type { Types } from 'mongoose';

import { type IntegrationDocument, IntegrationModel } from '../../models/integration.model.js';
import { decrypt, encrypt } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import { type GoogleProfile, type GoogleTokens, revokeGoogleToken } from './google/google-oauth.js';
import { featuresFromScopes, type GoogleFeature } from './google/google.scopes.js';

export interface PublicIntegration {
  provider: string;
  status: string;
  email: string | null;
  scopes: string[];
  features: Record<GoogleFeature, boolean>;
  connectedAt: string;
  updatedAt: string;
}

export function toPublicIntegration(integration: IntegrationDocument): PublicIntegration {
  return {
    provider: integration.provider,
    status: integration.status,
    email: integration.email ?? null,
    scopes: integration.scopes,
    features: featuresFromScopes(integration.scopes),
    connectedAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
  };
}

export async function listIntegrations(userId: Types.ObjectId): Promise<IntegrationDocument[]> {
  return IntegrationModel.find({ userId }).sort({ provider: 1 });
}

/** Stores (or refreshes) the user's Google connection with tokens encrypted at rest. */
export async function saveGoogleIntegration(
  userId: Types.ObjectId,
  profile: GoogleProfile,
  tokens: GoogleTokens,
): Promise<IntegrationDocument> {
  const existing = await IntegrationModel.findOne({ userId, provider: 'google' }).select(
    '+refreshToken',
  );
  // Google only returns a refresh token on consent; keep the previous one if it's absent.
  const refreshToken = tokens.refreshToken ? encrypt(tokens.refreshToken) : existing?.refreshToken;

  const fields = {
    providerAccountId: profile.sub,
    email: profile.email,
    accessToken: encrypt(tokens.accessToken),
    // With include_granted_scopes, this is the full set currently granted.
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
  };
  // Without a refresh token, background jobs can't act once the access token expires.
  const update = refreshToken
    ? { $set: { ...fields, refreshToken, status: 'active' }, $unset: { lastError: 1 } }
    : { $set: { ...fields, status: 'error', lastError: 'No refresh token was granted' } };

  const integration = await IntegrationModel.findOneAndUpdate(
    { userId, provider: 'google' },
    update,
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  return integration;
}

/** Revokes the grant at Google (best effort) and deletes the stored connection. */
export async function disconnectGoogle(userId: Types.ObjectId): Promise<boolean> {
  const integration = await IntegrationModel.findOne({ userId, provider: 'google' }).select(
    '+accessToken +refreshToken',
  );
  if (!integration) return false;

  const token = integration.refreshToken ?? integration.accessToken;
  if (token) {
    try {
      // Revoking the refresh token revokes the whole grant.
      await revokeGoogleToken(decrypt(token));
    } catch (error) {
      // The token may already be revoked or expired; the local delete below is what matters.
      // Log only the reason: HTTP client errors carry the full request config.
      logger.warn(
        {
          userId: userId.toString(),
          reason: error instanceof Error ? error.message : String(error),
        },
        'Google token revocation failed',
      );
    }
  }

  await integration.deleteOne();
  return true;
}
