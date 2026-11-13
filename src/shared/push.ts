// Notifications on the iPhone app (server/push.ts).

/** Which chat messages in a space notify you: every one, or only those that @mention you or reply to you. */
export type ChatNotify = "all" | "mentions";

/** Apple's test push servers take an Xcode build's token; TestFlight and App Store builds use the real ones. */
export type ApnsEnv = "sandbox" | "production";

/** GET /api/rooms/:id/notify: how many phones of yours take notifications, and what this space sends them. */
export interface NotifyStatus {
  devices: number;
  level: ChatNotify;
}

/** One notification, before it is put in Apple's shape. */
export interface PushMessage {
  title: string;
  body: string;
  /** Where a tap takes you, a path on Stand. */
  url: string;
  /** A newer notification with the same tag replaces the older one. */
  tag: string;
}
