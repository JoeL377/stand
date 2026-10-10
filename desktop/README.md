# Stand for Mac

The Stand app in its own window, plus **Snap from anywhere**: press **⌃⇧S** (Control-Shift-S) in any app during a meeting, drag over what you want, and the still lands in the meeting on whatever is being discussed. Click instead of dragging to snap the whole screen; Esc cancels.

Guests still join in the browser. The app loads the live Stand site, so web changes show up without a new build.

## Build it (on a Mac)

```sh
cd desktop
npm install
npm run app        # Stand.app in dist/mac-arm64 (or dist/mac), signed for this Mac only
open dist/mac*/Stand.app
```

Drag it to Applications to keep it. `npm start` runs it straight from the source, but signing in needs the built app, because macOS only sends `stand://` links to an installed app.

To point it at another Stand (a local one, say): `STAND_URL=http://localhost:5173 npm start`.

## First run

- **Sign in** opens your browser. Sign in with Google there (or you already are), and the browser hands you back to the app.
- **Screen Recording.** The first ⌃⇧S asks for it. Allow Stand in System Settings › Privacy & Security › Screen Recording, then quit and reopen Stand. Sharing your screen in a meeting needs the same permission.
- **Microphone.** macOS asks the first time you talk.

## Sharing a build with someone else

`npm run dist` makes a `.dmg`. Without an Apple Developer ID it isn't notarized, so on another Mac it opens only via System Settings › Privacy & Security › Open Anyway. Signing it properly needs a Developer ID certificate on the building Mac.

## How it fits together

- `main.js`: the window, browser sign-in, and Snap.
- Sign-in: the app sends you to `/api/auth/desktop` with a PKCE challenge, the server hands back a one-time code via `stand://signed-in`, and the app swaps it for its own session (`/api/auth/desktop/redeem`).
- Snap: a screen capture of the display under the pointer, frozen in `snap.html` for picking a region, then uploaded to `/api/rooms/<space>/snaps` like a snap taken in the page.
