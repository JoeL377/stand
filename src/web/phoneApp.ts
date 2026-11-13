// The Stand iPhone app (ios/): a native shell around this site. It marks the page with
// html.ios-app and tells it this phone's push token, so signing out stops its notifications.

interface PhoneBridge {
  platform: "ios";
  /** This phone's Apple push token, once notifications are on. */
  pushToken?: string;
}

export const phoneApp = (): PhoneBridge | undefined => (window as { standPhone?: PhoneBridge }).standPhone;
