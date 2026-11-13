# Stand for iPhone

A native shell around the live site, like the Mac app (`desktop/`). Web changes ship with a normal
deploy; only changes in this folder need a new build through Xcode and TestFlight.

What the app adds over the website:

- **Push notifications for chat.** Once someone is signed in, the app asks to notify them and tells
  Stand this phone's token (`POST /api/push/devices`). Stand sends through Apple (`src/server/push.ts`,
  `src/server/apns.ts`). A tap opens the space's chat.
- **Google sign-in.** Google refuses sign-in inside an app's web view, so the app catches
  "Sign in with Google" and runs it in the system's sign-in sheet (`/api/auth/app`), then swaps the
  code for a session (`/api/auth/desktop/redeem`, with PKCE).

All native code is in `ios/App/App/AppDelegate.swift`.

## Build it (on a Mac with Xcode 16 or newer)

    cd iphone
    npm install
    npx cap sync ios
    npx cap open ios

In Xcode: pick the App target, check Signing uses team DV9FSZ65K2, plug in an iPhone and press Run.
A build from Xcode gets push through Apple's test servers ("sandbox"); TestFlight builds use the real ones.

To send it to TestFlight: `npm --prefix iphone run release` from the repo root (`iphone/scripts/release.sh`; add `-- --no-upload` to only build). Claude can do it with the `release-iphone` skill.

## What the server needs (Railway variables)

From Apple Developer > Certificates, Identifiers & Profiles > Keys, make a key with
**Apple Push Notifications service (APNs)** and download its `.p8` file (Apple only lets you download it once).

- `APNS_KEY`: the `.p8` file's whole text.
- `APNS_KEY_ID`: the key's 10-character id.
- `APNS_TEAM_ID`: DV9FSZ65K2.
- `APNS_TOPIC`: the bundle id, `studio.conxt.stand` (the default).

Without `APNS_KEY`, Stand sends no notifications and everything else works as before.

The bundle id must also be registered under Identifiers with Push Notifications ticked. Xcode's
automatic signing does this the first time it builds for a device.
