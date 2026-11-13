// Notifications on a phone or computer (server/push.ts).

/** Which chat messages in a space notify you: every one, or only those that @mention you or reply to you. */
export type ChatNotify = "all" | "mentions";

/** GET /api/push: whether Stand can send notifications at all, and how many of your devices take them. */
export interface PushStatus {
  /** The server's public key for subscribing; null when notifications aren't set up on this server. */
  key: string | null;
  devices: number;
}

/** What a notification carries to the service worker (public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap takes you. */
  url: string;
  /** A newer notification with the same tag replaces the older one. */
  tag: string;
}
