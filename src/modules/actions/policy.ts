import type { PermissionMode, UserDocument } from '../../models/user.model.js';
import type { ToolRisk } from '../agent/tools/types.js';

/**
 * The permission policy. It runs in our code on every tool call, after the model has chosen the
 * call, so nothing the model says — or any instruction hidden in an email it read — can skip it.
 *
 * - READ always runs.
 * - WRITE and EXTERNAL_ACTION follow the user's settings (defaults: run / ask).
 * - DESTRUCTIVE always asks, or is refused; it can never run on its own, whatever is stored.
 */
export type PolicyDecision = 'allow' | 'confirm' | 'deny';

export const DEFAULT_PERMISSIONS = {
  write: 'auto',
  externalAction: 'confirm',
  destructive: 'confirm',
} as const satisfies Record<string, PermissionMode>;

const FROM_MODE: Record<PermissionMode, PolicyDecision> = {
  auto: 'allow',
  confirm: 'confirm',
  never: 'deny',
};

export function decide(risk: ToolRisk, user: Pick<UserDocument, 'permissions'>): PolicyDecision {
  const permissions = user.permissions;
  switch (risk) {
    case 'READ':
      return 'allow';
    case 'WRITE':
      return FROM_MODE[permissions.write];
    case 'EXTERNAL_ACTION':
      return FROM_MODE[permissions.externalAction];
    case 'DESTRUCTIVE':
      return permissions.destructive === 'never' ? 'deny' : 'confirm';
  }
}

export const RISK_LABELS: Record<ToolRisk, string> = {
  READ: 'looking things up',
  WRITE: 'changes to your own data',
  EXTERNAL_ACTION: 'actions that reach other people',
  DESTRUCTIVE: "actions that can't be undone",
};

/** How long an approval request stays valid. */
export const APPROVAL_TTL_MS = 60 * 60_000;
