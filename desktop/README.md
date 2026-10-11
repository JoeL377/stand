# Stand for Mac

The Stand app in its own window, plus **Snap from anywhere**: press **⌃⇧S** (Control-Shift-S) in any app and a capture toolbar like macOS's ⌘⇧5 opens over the screen.

- **Entire screen**: click anywhere.
- **Window**: hover a window to highlight it, click to snap it.
- **Selected portion**: a box you drag to move and pull by its handles to resize; it's where you left it last time. Capture, Enter or a double-click snaps it.
- **Options**: save to Stand and/or the clipboard, both on by default, and a 5 or 10 second timer. In a meeting, Stand means the meeting, on whatever is being discussed. Out of a meeting, Stand means a note for the bar's space: the snap is pinned to the top of the note card under the bar (see **Notes** below), and saved when you press Enter there. Everyone in the space sees it once it's saved.

Each snap's text is read on the Mac with Apple's Vision framework (`native/stand-ocr`) and saved with it, so it's searchable and agents can read it without looking at the picture.

Snapping happens here only: the web page shows snaps but doesn't take them.

Esc or ⌃⇧S again closes it. Snapping from another app never brings Stand forward: the app you're in stays in front, full screen or on another desktop included. The toolbar remembers its mode and options in `snap.json` in the app's data folder.

**The floating bar.** Whenever the app runs and you're signed in, a small bar floats at the top of the screen, over Stand and every other app and Space. Out of a meeting it holds a space: its name (click it to pick another of your spaces, or open it in Stand; a green dot means people are talking there), a note field, its open to-dos (click one to copy it for your agent), a mic that starts talking in that space or joins whoever is, and **Snap**, which pins the snap to a note for that space. Opening a space in Stand makes it the bar's space.

**Notes.** Click the bar's note field, or press **Control + Shift + N** in any app, and the bar opens downward into a note box (upward when the bar is low on the screen), one piece with the bar, with the keyboard in it (Stand stays in the background). While it's open the bar's row shows the space, the keys and Snap; the box follows the bar if you drag it. Type the note, or click its mic (or press the Mac's dictation key) and say it; Enter saves it to the bar's space, Shift + Enter starts a new line, Esc puts it away and keeps what you wrote for next time. Stand files it under the agenda item it's about, marked ✦ until someone confirms it, and it shows on the space page and in Up next. A snap out of a meeting is pinned to the top of the card (up to six), with the keyboard in the note: write or say what it's about and Enter saves the note with its pictures, or press Enter with nothing written to save the snaps by themselves. ✕ on a picture, or Backspace in an empty note, takes it off. Esc keeps the pictures and the note for later, and the bar's note field says how many snaps are pinned. Nothing leaves the Mac before Enter; a snap that doesn't save stays pinned, and Enter tries it again. The mic starts macOS dictation through `native/stand-native.mm`; without that code, the card says which key starts it. Right-click the bar to hide it; View > Show Floating Bar brings it back. In a meeting the bar shows the Stand logo (click it to go back to Stand), what's in focus in the meeting, your mic, and **Snap**. Snap opens the same toolbar; the bar steps out of the picture while it reads the screen, and the snap goes on everyone's middle screen. Clicking the bar never takes focus from the app you're in, or brings Stand forward (that part is native Mac code, `native/stand-native.mm`). Drag it anywhere and it stays there (`bar.json` in the app's data folder). It asks macOS to keep it out of screen sharing and screenshots, which some macOS versions ignore.

Guests still join in the browser. The app loads the live Stand site, so web changes show up without a new build.

## Build it (on a Mac)

```sh
cd desktop
npm install
npm run app        # Stand.app in dist/mac-arm64 (or dist/mac), signed for this Mac only
open dist/mac*/Stand.app
```

Drag it to Applications to keep it. `npm start` runs it straight from the source.

Both build the native Mac code first (the floating bar's, and the text reading), which needs Apple's command line tools (`xcode-select --install`). Run from source without them, the app still starts: the bar just brings Stand forward for a moment when clicked, snaps save without their text, and `native/build.log` and `native/build-ocr.log` say what went wrong.

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
- The floating bar (`bar.html`): the meeting page tells the app what's in focus and whether the mic is on (`standApp.meeting`), and the bar's mic button goes back to the page (`standApp.onCommand`). Out of a meeting the app reads `/api/spaces` and the space's `/api/rooms/<id>` itself, signed in as you, when it starts, when you sign in or out, when Stand's window changes page, every 30 seconds, and as the pointer reaches the bar.
- Sign-in: the app opens `/api/auth/desktop` in your browser with a PKCE challenge and the port of a one-off listener on 127.0.0.1. After Google, the browser brings a one-time code back to that listener, and the app swaps it for its own session (`/api/auth/desktop/redeem`).
- No title bar or window buttons: Stand runs edge to edge with its logo in the corner; ⌘W closes, ⌘M minimizes and ⌃⌘F goes full screen. `preload.js` marks the page `html.mac-app` and adds a strip along the top that drags the window.
- Snap: a still of the display under the pointer, shown in `snap.html` with the toolbar. Windows and their positions come from CoreGraphics through `osascript` (no extra permission); a window snap is the window by itself from `desktopCapturer`. The snap is uploaded to `/api/rooms/<space>/snaps` like a snap taken in the page, and written to the clipboard. With the timer, the screen is captured again when it runs out.
