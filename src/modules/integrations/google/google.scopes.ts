/**
 * Google scopes, requested incrementally. Sign-in only asks for identity; each feature's scopes
 * are requested when the user connects that feature.
 */
export const LOGIN_SCOPES = ['openid', 'email', 'profile'];

export const GOOGLE_FEATURE_SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  // Separate from reading, so connecting Gmail never implies letting the assistant send mail.
  gmailSend: [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
  ],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
} as const;

export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;

export const GOOGLE_FEATURES = Object.keys(GOOGLE_FEATURE_SCOPES) as GoogleFeature[];

export function scopesForFeatures(features: readonly GoogleFeature[]): string[] {
  // `openid email` lets us confirm the connected account is the signed-in user.
  return [...new Set(['openid', 'email', ...features.flatMap((f) => GOOGLE_FEATURE_SCOPES[f])])];
}

/** A feature counts as connected only if every one of its scopes was granted. */
export function featuresFromScopes(scopes: readonly string[]): Record<GoogleFeature, boolean> {
  const granted = new Set(scopes);
  return Object.fromEntries(
    GOOGLE_FEATURES.map((feature) => [
      feature,
      GOOGLE_FEATURE_SCOPES[feature].every((scope) => granted.has(scope)),
    ]),
  ) as Record<GoogleFeature, boolean>;
}
