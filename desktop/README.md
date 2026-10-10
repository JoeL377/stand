# Stand for Mac

The Stand app in its own window, plus **Snap from anywhere**: press **⌃⇧S** (Control-Shift-S) in any app and a capture toolbar like macOS's ⌘⇧5 opens over the screen.

- **Entire screen**: click anywhere.
- **Window**: hover a window to highlight it, click to snap it.
- **Selected portion**: a box you drag to move and pull by its handles to resize; it's where you left it last time. Capture, Enter or a double-click snaps it.
- **Options**: save to the meeting (on whatever is being discussed) and/or the clipboard, both on by default, and a 5 or 10 second timer. Out of a meeting, a snap goes to the clipboard.

Esc or ⌃⇧S again closes it. Snapping from another app never brings Stand forward: the app you're in stays in front, full screen or on another desktop included. The toolbar remembers its mode and options in `snap.json` in the app's data folder.

**The floating bar.** In a meeting, whenever Stand isn't the app in front (you're presenting a web page, say), a small bar floats at the top of the screen, over every app and Space: the Stand logo (click it to go back to Stand), what's in focus in the meeting, your mic, and **Snap**. Snap opens the same toolbar; the bar steps out of the picture while it reads the screen, and the snap goes on everyone's middle screen. The bar never takes focus from the app you're in. Drag it anywhere and it stays there (`bar.json` in the app's data folder). It asks macOS to keep it out of screen sharing and screenshots, which some macOS versions ignore.

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

Run from source, Snap writes each step to `desktop/snap-debug.log`, which helps when a snap does nothing.

The app's icon is `build/icon.png`: the built app carries it, and run from source it's set on the Dock when the app starts.

Run it again after a `git pull` and it replaces whatever is still running: an older Stand server on ports 5173 or 3001 (from this copy or another) is stopped first, and an app window that's still open is closed for the new one. If another program holds one of those ports, it says which and stops.

Google sign-in on the local Stand needs `http://localhost:5173/api/auth/google/callback` among the authorized redirect URIs of your Google OAuth client (Google Cloud console › APIs & Services › Credentials). Without Google keys in `.env`, you sign in with a name and email instead.

## First run

- **Sign in** opens your browser. Sign in with Google there (or you already are), and the browser hands you back to the app.
- **Screen Recording.** The first ⌃⇧S asks for it. Allow Stand in System Settings › Privacy & Security › Screen & System Audio Recording (Screen Recording on older macOS), then quit and reopen Stand. Sharing your screen in a meeting needs the same permission.
- **Microphone.** macOS asks the first time you talk.

## Share it with your team

`npm run dist` makes `dist/Stand-<version>-mac.dmg`: one app for Apple silicon and Intel Macs (macOS 13 or later), signed with your Developer ID and notarized by Apple, so it opens on a teammate's Mac with no warning. Send the `.dmg` however you like (Slack, Drive, AirDrop). Teammates sign in with Google, so their email has to be in `ALLOWED_EMAILS` on Railway.

It needs three things on the Mac that builds it, set up once:

1. **An Apple Developer Program membership** ($99 a year): developer.apple.com/programs/enroll.
2. **A "Developer ID Application" certificate** in your keychain. With Xcode: Xcode › Settings › Accounts › your team › Manage Certificates › + › Developer ID Application. Without Xcode: make a certificate request in Keychain Access (Certificate Assistant › Request a Certificate From a Certificate Authority, saved to disk), upload it at developer.apple.com/account › Certificates › + › Developer ID Application, and double-click the downloaded certificate.
3. **A notary sign-in saved in your keychain**, named `stand-notary`. Make an app-specific password at account.apple.com (Sign-In and Security › App-Specific Passwords), then run the line below and paste the password when it asks. Your Team ID is under Membership details at developer.apple.com/account.

   ```sh
   xcrun notarytool store-credentials stand-notary --apple-id you@example.com --team-id ABCDE12345
   ```

Then:

```sh
cd desktop
npm install
npm run dist       # checks the certificate and sign-in first, then builds, signs and notarizes
```

The first build downloads Electron for both kinds of Mac, and Apple's notary check usually takes a few minutes. The first time it signs, macOS asks whether `codesign` may use your key: click Always Allow. To use another notary profile, set `APPLE_KEYCHAIN_PROFILE`.

Without a Developer ID, `npm run dist:unsigned` makes `Stand-<version>-mac-unsigned.dmg`. That one opens on another Mac only after macOS blocks it once: System Settings › Privacy & Security › Open Anyway.

Web changes reach everyone's app without a new build, since the app loads the live site. Only changes in `desktop/` need a new `.dmg`; bump `version` in `package.json` first so people can tell builds apart.

## How it fits together

- `main.js`: the window, browser sign-in, Snap and the floating bar.
- The floating bar (`bar.html`): the meeting page tells the app what's in focus and whether the mic is on (`standApp.meeting`), and the bar's mic button goes back to the page (`standApp.onCommand`).
- Sign-in: the app opens `/api/auth/desktop` in your browser with a PKCE challenge and the port of a one-off listener on 127.0.0.1. After Google, the browser brings a one-time code back to that listener, and the app swaps it for its own session (`/api/auth/desktop/redeem`).
- No title bar or window buttons: Stand runs edge to edge with its logo in the corner; ⌘W closes, ⌘M minimizes and ⌃⌘F goes full screen. `preload.js` marks the page `html.mac-app` and adds a strip along the top that drags the window.
- Snap: a still of the display under the pointer, shown in `snap.html` with the toolbar. Windows and their positions come from CoreGraphics through `osascript` (no extra permission); a window snap is the window by itself from `desktopCapturer`. The snap is uploaded to `/api/rooms/<space>/snaps` like a snap taken in the page, and written to the clipboard. With the timer, the screen is captured again when it runs out.
