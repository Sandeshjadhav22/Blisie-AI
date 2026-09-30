/**
 * The chat apps the assistant talks through, and each one's rules. Everything outside the channel
 * adapters works with these instead of knowing about Telegram or WhatsApp.
 * The worker repo keeps an identical copy (worker/src/channels/policy.ts) — change both together.
 */
export const CHAT_CHANNELS = ['telegram', 'whatsapp'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

export interface ChannelRules {
  name: string;
  /** May the assistant start conversations (briefing, alerts, nudges)? */
  proactive: boolean;
  /**
   * After the user's last message, how long free-form replies are allowed (WhatsApp's customer
   * service window). Null: no limit.
   */
  sessionWindowMs: number | null;
  /** Can a sent message be edited later (e.g. replace approval buttons with the outcome)? */
  canEditMessages: boolean;
  /** Most buttons one message can carry. */
  maxButtons: number;
}

export const CHANNEL_RULES: Record<ChatChannel, ChannelRules> = {
  telegram: {
    name: 'Telegram',
    proactive: true,
    sessionWindowMs: null,
    canEditMessages: true,
    maxButtons: 8,
  },
  whatsapp: {
    name: 'WhatsApp',
    // Only answer when the user writes: messages outside the 24-hour window need paid templates.
    proactive: false,
    sessionWindowMs: 24 * 60 * 60 * 1000,
    canEditMessages: false,
    maxButtons: 3,
  },
};

/**
 * Why a message is being sent, which decides whether a channel allows it:
 * - `reply`: answering the user's message right now.
 * - `requested`: something the user asked for that arrives a little later (an approval outcome,
 *   an on-demand briefing).
 * - `reminder`: a reminder the user set for a later time.
 * - `proactive`: the assistant starting a conversation (briefing, alerts, nudges).
 */
export type DeliveryKind = 'reply' | 'requested' | 'reminder' | 'proactive';

/**
 * - `send`: send it as a normal message.
 * - `template`: outside the window; send the channel's pre-approved template instead.
 * - `hold`: outside the window with no template; keep it for the user's next message.
 * - `skip`: this channel doesn't do this kind of message.
 */
export type DeliveryDecision = 'send' | 'template' | 'hold' | 'skip';

export function decideDelivery(
  channel: ChatChannel,
  kind: DeliveryKind,
  options: { lastInboundAt?: Date | null; now: Date; hasTemplate: boolean },
): DeliveryDecision {
  const rules = CHANNEL_RULES[channel];
  if (kind === 'proactive' && !rules.proactive) return 'skip';

  const windowOpen =
    rules.sessionWindowMs === null ||
    (options.lastInboundAt != null &&
      options.now.getTime() - options.lastInboundAt.getTime() < rules.sessionWindowMs);
  if (windowOpen) return 'send';

  if (kind === 'reminder') return options.hasTemplate ? 'template' : 'hold';
  return 'skip';
}

/** Stored per linked chat app; `key` ("telegram:123") is unique across all users. */
export function channelKey(channel: ChatChannel, externalId: string): string {
  return `${channel}:${externalId}`;
}
