# Stand for Mac

The Stand app in its own window, plus **Snap from anywhere**: press **⌃⇧S** (Control-Shift-S) in any app and a capture toolbar like macOS's ⌘⇧5 opens over the screen.

- **Entire screen**: click anywhere.
- **Window**: hover a window to highlight it, click to snap it.
- **Selected portion**: a box you drag to move and pull by its handles to resize; it's where you left it last time. Capture, Enter or a double-click snaps it.
- **Options**: save to the meeting (on whatever is being discussed) and/or the clipboard, both on by default, and a 5 or 10 second timer. Out of a meeting, a snap goes to the clipboard.

Esc or ⌃⇧S again closes it. The toolbar remembers its mode and options in `snap.json` in the app's data folder.

Guests still join in the browser. The app loads the live Stand site, so web changes show up without a new build.

## Build it (on a Mac)

```sh
cd desktop
npm install
npm run app        # Stand.app in dist/mac-arm64 (or dist/mac), signed for this Mac only
open dist/mac*/Stand.app
```

Drag it to Applications to keep it. `npm start` runs it straight from the source.

To point it at another Stand: `STAND_URL=http://localhost:5173 npm start`.

## Try it against a local Stand

From the repo root (with your `.env` in place):

```sh
npm install && npm --prefix desktop install
npm run try:mac
```

This starts a local Stand with your `.env` and opens the app on it. Quitting the app or pressing Ctrl-C stops both. The first launch downloads Electron, so it takes a minute.

Run it again after a `git pull` and it replaces whatever is still running: an older Stand server on ports 5173 or 3001 (from this copy or another) is stopped first, and an app window that's still open is closed for the new one. If another program holds one of those ports, it says which and stops.

Google sign-in on the local Stand needs `http://localhost:5173/api/auth/google/callback` among the authorized redirect URIs of your Google OAuth client (Google Cloud console › APIs & Services › Credentials). Without Google keys in `.env`, you sign in with a name and email instead.

## First run

- **Sign in** opens your browser. Sign in with Google there (or you already are), and the browser hands you back to the app.
- **Screen Recording.** The first ⌃⇧S asks for it. Allow Stand in System Settings › Privacy & Security › Screen Recording, then quit and reopen Stand. Sharing your screen in a meeting needs the same permission.
- **Microphone.** macOS asks the first time you talk.

## Sharing a build with someone else

`npm run dist` makes a `.dmg`. Without an Apple Developer ID it isn't notarized, so on another Mac it opens only via System Settings › Privacy & Security › Open Anyway. Signing it properly needs a Developer ID certificate on the building Mac.

## How it fits together

- `main.js`: the window, browser sign-in, and Snap.
- Sign-in: the app opens `/api/auth/desktop` in your browser with a PKCE challenge and the port of a one-off listener on 127.0.0.1. After Google, the browser brings a one-time code back to that listener, and the app swaps it for its own session (`/api/auth/desktop/redeem`).
- No title bar or window buttons: Stand runs edge to edge with its logo in the corner; ⌘W closes, ⌘M minimizes and ⌃⌘F goes full screen. `preload.js` marks the page `html.mac-app` and adds a strip along the top that drags the window.
- Snap: a still of the display under the pointer, shown in `snap.html` with the toolbar. Windows and their positions come from CoreGraphics through `osascript` (no extra permission); a window snap is the window by itself from `desktopCapturer`. The snap is uploaded to `/api/rooms/<space>/snaps` like a snap taken in the page, and written to the clipboard. With the timer, the screen is captured again when it runs out.
