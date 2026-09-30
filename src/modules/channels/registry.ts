import type { OutgoingMessage } from '../conversations/channel.types.js';
import type { ChatChannel } from './policy.js';

/**
 * What every chat app adapter provides. The rest of the backend sends through this, so adding a
 * chat app means writing one adapter and registering it — nothing else changes.
 */
export interface ChannelAdapter {
  channel: ChatChannel;
  /** Credentials are set, so the app can be offered and used. */
  isConfigured(): boolean;
  /** The link the user opens to connect this app, carrying a one-time code. */
  linkUrl(code: string): Promise<string>;
  /** Opens a chat with the assistant (used to send people back after something on the web). */
  chatUrl(): Promise<string>;
  /** Sends to a user's chat; returns the app's id for the sent message. */
  send(externalId: string, message: OutgoingMessage): Promise<string>;
  /** Replaces a sent message (e.g. approval buttons → outcome). Apps that can't, don't have it. */
  edit?(externalId: string, messageId: string, message: OutgoingMessage): Promise<void>;
}

const adapters = new Map<ChatChannel, ChannelAdapter>();

export function registerChannel(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function getChannel(channel: ChatChannel): ChannelAdapter | undefined {
  return adapters.get(channel);
}

/** Chat apps users can connect right now. */
export function availableChannels(): ChannelAdapter[] {
  return [...adapters.values()].filter((adapter) => adapter.isConfigured());
}
