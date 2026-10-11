// Stand for Mac. One window on the live Stand app, sign-in through the browser
// (Google won't sign people in inside an app's own window), and Snap from
// anywhere: a global shortcut opens a capture toolbar like macOS's ⌘⇧5, and the
// snap lands in the meeting you're in, pinned to whatever is in focus, and on the clipboard.
// A small floating bar is up whenever the app runs: out of a meeting it holds the space you're
// in (pick another from it), a note field, its to-dos and Snap; in a meeting, the item in focus
// and your mic.

const {
  app,
  BrowserWindow,
  ClipboardItem,
  Menu,
  Notification,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
} = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const STAND_URL = (process.env.STAND_URL || "https://stand-production-3d3f.up.railway.app").replace(/\/$/, "");
const STAND_ORIGIN = new URL(STAND_URL).origin;
/** ⌃⇧S: ⌘⇧S is Save As in most apps, and a global shortcut would take it from them. */
const SNAP_SHORTCUT = process.env.STAND_SNAP_SHORTCUT || "Control+Shift+S";
/** A note to the space the bar holds, from any app. */
const NOTE_SHORTCUT = process.env.STAND_NOTE_SHORTCUT || "Control+Shift+N";
/** Mute and unmute from any app, during a meeting only. In Stand's window ⌘D does it too. */
const MUTE_SHORTCUT = process.env.STAND_MUTE_SHORTCUT || "Control+Shift+M";
const PARTITION = "persist:stand";
/** Stand's sign-in cookie (src/server/auth.ts). */
const SESSION_COOKIE = "standup_session";
const mac = process.platform === "darwin";
/** No title bar and no window buttons on the Mac: Stand runs edge to edge, the logo
 *  sits in the corner, and ⌘W, ⌘M and ⌃⌘F close, minimize and go full screen. */
/** @type {Electron.BrowserWindowConstructorOptions} */
const chrome = mac ? { titleBarStyle: "hidden" } : {};

let win = null;
/** The browser sign-in in flight, if any. */
let signingIn = null;
/** Quitting for real (asked and answered): ⌘W in a meeting only puts the window away. */
let quitting = false;

// ---- one instance -----------------------------------------------------------------

// A second launch brings up the window that's already open. Run from source (npm
// start, npm run try:mac) it replaces the running copy instead, so the app always runs
// the code you just pulled rather than quietly handing over to the old one.
let primary = app.requestSingleInstanceLock();
const replacing = !primary && !app.isPackaged ? replaceRunningCopy() : null;
if (!primary && !replacing) app.quit();
app.on("second-instance", () => showWindow());

/** Stops the copy holding the lock and takes the lock over. */
async function replaceRunningCopy() {
  try {
    // Chromium's lock is a symlink in the app's data folder that points at "<host>-<pid>".
    const pid = Number(fs.readlinkSync(path.join(app.getPath("userData"), "SingletonLock")).split("-").pop());
    if (pid > 0 && pid !== process.pid) process.kill(pid);
  } catch {}
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

// ---- the window -----------------------------------------------------------------

/** Behind the page while it loads: Stand's own light or dark, so the window doesn't flash. */
const backdrop = () => (nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff");

const windowFile = () => path.join(app.getPath("userData"), "window.json");
/** Where the window was last time, if that's still on a display. */
function savedPlace() {
  try {
    const { x, y, width, height, fullScreen } = JSON.parse(fs.readFileSync(windowFile(), "utf8"));
    if (![x, y, width, height].every(Number.isFinite)) return {};
    // Enough of the top edge on some display to grab it.
    const onScreen = screen
      .getAllDisplays()
      .some(({ workArea: a }) => x + width - 80 > a.x && x + 80 < a.x + a.width && y >= a.y - 10 && y + 40 < a.y + a.height);
    return onScreen ? { bounds: { x, y, width: Math.max(width, 960), height: Math.max(height, 600) }, fullScreen: Boolean(fullScreen) } : {};
  } catch {
    return {};
  }
}
function savePlace() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const place = { ...win.getNormalBounds(), fullScreen: win.isFullScreen() || putAwayFull };
  fs.promises.writeFile(windowFile(), JSON.stringify(place)).catch(() => {});
}
let placeTimer;
/** Put away from full screen during a call: it goes back to full screen when shown. */
let putAwayFull = false;

function showWindow(path) {
  if (!win) {
    const place = savedPlace();
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      ...place.bounds,
      minWidth: 960,
      minHeight: 600,
      title: "Stand",
      backgroundColor: backdrop(),
      fullscreen: place.fullScreen || undefined,
      ...chrome,
      webPreferences: { partition: PARTITION, preload: `${__dirname}/preload.js`, contextIsolation: true, sandbox: true },
    });
    // The window buttons are hidden on the main window only; Stand's logo sits in that corner.
    if (mac) win.setWindowButtonVisibility(false);
    for (const change of ["resized", "moved", "enter-full-screen", "leave-full-screen"])
      win.on(change, () => {
        if (putAwayFull) return;
        clearTimeout(placeTimer);
        placeTimer = setTimeout(savePlace, 500);
      });
    win.on("close", (e) => {
      savePlace();
      // In a meeting, ⌘W puts the window away rather than leaving the call, as call apps do:
      // the floating bar takes over, and the Dock, ⌘Tab or the bar's logo bring it back.
      if (!meeting || quitting) return;
      e.preventDefault();
      if (win.isFullScreen()) {
        // Back in full screen when it's brought back, and the saved place keeps it.
        putAwayFull = true;
        win.once("leave-full-screen", () => win?.hide());
        win.setFullScreen(false);
      } else win.hide();
      setTimeout(updateBar, 50);
    });
    win.on("closed", () => {
      win = null;
      // Lets go of the mute shortcut and resets the menus too.
      setMeeting(null);
      // On the Mac the app, and its bar, keep running with no window. Elsewhere the bar is a
      // window too: gone with the main one, so closing it still quits.
      if (!mac) bar?.destroy();
    });
    // A reload or a crash leaves the meeting page; it says so again when it's back.
    win.webContents.on("did-navigate", (_e, url) => {
      setMeeting(null);
      followPage(url, true);
    });
    win.webContents.on("did-navigate-in-page", (_e, url) => followPage(url, false));
    win.webContents.on("render-process-gone", () => setMeeting(null));
    if (!path) void win.loadURL(STAND_URL);
  }
  if (path) void win.loadURL(`${STAND_URL}${path}`);
  // The floating bar makes the window unfocusable while the pointer is on it.
  if (mac) win.setFocusable(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (putAwayFull) {
    putAwayFull = false;
    win.setFullScreen(true);
  }
}

/** Opening a space in Stand makes it the one the bar holds. A page load brings the bar up to
 *  date; moving around within the page does too, at most every few seconds. */
function followPage(url, load) {
  const id = spaceInPage(url);
  if (id && id !== resting?.spaceId) void holdSpace(id, "page");
  else if (load || Date.now() - restAt > 5000) void refreshRest("page");
}

/** Every Stand page stays on Stand: other sites open in the browser, and Google sign-in goes the app's own way. */
function keepOnStand(wc) {
  const signIn = (url) => {
    const u = new URL(url);
    if (u.origin === STAND_ORIGIN && u.pathname === "/api/auth/google") return void startSignIn(u.searchParams.get("next"));
    if (u.hostname === "accounts.google.com") return void startSignIn(null);
    return false;
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (signIn(url) !== false) return { action: "deny" };
    // Stand's own links (the recap, a brief) open as another app window.
    // They keep a normal title bar and window buttons; only the main window goes without.
    if (new URL(url).origin === STAND_ORIGIN)
      return { action: "allow", overrideBrowserWindowOptions: { ...cascade(otherSize()), minWidth: 640, minHeight: 480, backgroundColor: backdrop() } };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (signIn(url) !== false) return e.preventDefault();
    if (new URL(url).origin !== STAND_ORIGIN) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  // A page with changes that haven't reached Stand holds the window open; say so instead of
  // ⌘W or ⌘Q silently doing nothing.
  wc.on("will-prevent-unload", (e) => {
    const w = BrowserWindow.fromWebContents(wc);
    const choice = dialog.showMessageBoxSync(w ?? undefined, {
      type: "warning",
      message: "Leave with changes that haven't been saved?",
      detail: "Some of your changes haven't reached Stand yet. If you leave now, they're lost.",
      buttons: ["Leave", "Stay"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) e.preventDefault();
    // Staying also calls off a quit that was under way.
    else quitting = false;
  });
  wc.on("context-menu", (_e, p) => contextMenu(wc, p));
  // Windows it opens come back where they were last left, at that size.
  wc.on("did-create-window", (w) => {
    const keep = () => {
      if (w.isDestroyed() || w.isFullScreen() || w.isMaximized()) return;
      fs.promises.writeFile(path.join(app.getPath("userData"), "other-window.json"), JSON.stringify(w.getBounds())).catch(() => {});
    };
    w.on("resized", keep);
    w.on("moved", keep);
  });
}

/** Where Stand's other windows (a recap, a brief) were last left, and their size. The place
 *  only if it's still on a screen. */
function otherSize() {
  try {
    const { x, y, width, height } = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "other-window.json"), "utf8"));
    if ([width, height].every((n) => Number.isFinite(n) && n >= 480)) {
      const onScreen =
        [x, y].every(Number.isFinite) &&
        screen.getAllDisplays().some(({ workArea: a }) => x >= a.x - 40 && y >= a.y - 40 && x + 200 <= a.x + a.width && y + 100 <= a.y + a.height);
      return onScreen ? { x, y, width, height } : { width, height };
    }
  } catch {}
  return { width: 1100, height: 800 };
}

/** A window opening where another of Stand's already is goes a little down and right, as Mac apps do. */
function cascade(b) {
  if (!Number.isFinite(b.x)) return b;
  const taken = (x, y) => BrowserWindow.getAllWindows().some((w) => w !== win && w !== bar && !w.isDestroyed() && w.getBounds().x === x && w.getBounds().y === y);
  let { x, y } = b;
  for (let i = 0; i < 10 && taken(x, y); i++) (x += 24), (y += 24);
  return { ...b, x, y };
}

/** Help outside a meeting: what Stand is for and its shortcuts, in a sheet. */
async function howStandWorks() {
  const opts = {
    type: "info",
    message: "How Stand works",
    detail: [
      "Open a space and press Start talking. Stand records what's said against the agenda item in focus, and writes notes, to-dos and decisions as you go.",
      "",
      "In a meeting:",
      `• Snap: ${SNAP_SHORTCUT.replace(/\+/g, " + ")}, from any app`,
      `• Mute: ${MUTE_SHORTCUT.replace(/\+/g, " + ")}, from any app (Command + D in Stand)`,
      "• Next or previous agenda item: Option + Down or Up",
      "• All shortcuts: ? in the meeting",
    ].join("\n"),
    buttons: ["OK"],
  };
  await (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

/** Right-click: spelling, the edit commands, and links and images, as in any Mac app. */
function contextMenu(wc, p) {
  const groups = [];
  if (p.misspelledWord)
    groups.push([
      ...p.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) })),
      ...(p.dictionarySuggestions.length ? [] : [{ label: "No Guesses Found", enabled: false }]),
      { label: "Learn Spelling", click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
    ]);
  if (p.linkURL && !p.linkURL.startsWith("javascript:"))
    groups.push([
      { label: "Open Link in Browser", click: () => void shell.openExternal(p.linkURL) },
      { label: "Copy Link", click: () => clipboard.writeText(p.linkURL) },
    ]);
  if (p.mediaType === "image") groups.push([{ label: "Copy Image", click: () => wc.copyImageAt(p.x, p.y) }]);
  if (p.isEditable)
    groups.push([
      { role: "cut", enabled: p.editFlags.canCut },
      { role: "copy", enabled: p.editFlags.canCopy },
      { role: "paste", enabled: p.editFlags.canPaste },
      { role: "selectAll", enabled: p.editFlags.canSelectAll },
    ]);
  else if (p.selectionText.trim()) groups.push([{ role: "copy" }]);
  if (mac && p.selectionText.trim()) {
    const words = p.selectionText.trim().replace(/\s+/g, " ");
    groups.push([{ label: `Look Up “${words.length > 24 ? `${words.slice(0, 24)}…` : words}”`, click: () => wc.showDefinitionForSelection() }]);
  }
  if (!groups.length) return;
  const items = groups.flatMap((g, i) => (i ? [{ type: "separator" }, ...g] : g));
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) ?? undefined });
}

// ---- signing in through the browser ---------------------------------------------

const SIGNED_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in · Stand</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;font:15px -apple-system,system-ui;color-scheme:light dark">
<p>You're signed in. Head back to the Stand app; you can close this tab.</p>`;

/** The browser signs in, then comes back to a one-off listener on this computer
 *  with a code that only this app's secret (PKCE) can turn into a session. */
async function startSignIn(next) {
  signingIn?.close();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const land = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const listener = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/signed-in") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SIGNED_IN_PAGE);
    close();
    void finishSignIn(url.searchParams.get("code"), verifier, land);
  });
  const timer = setTimeout(() => close(), 10 * 60_000);
  const close = () => {
    clearTimeout(timer);
    listener.close();
    if (signingIn?.close === close) signingIn = null;
  };
  signingIn = { close };
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", () => resolve(null)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (listener.address());
  await shell.openExternal(`${STAND_URL}/api/auth/desktop?challenge=${challenge}&port=${port}`);
}

async function finishSignIn(code, verifier, land) {
  if (mac) app.focus({ steal: true });
  if (!code) return showWindow();
  const res = await fetch(`${STAND_URL}/api/auth/desktop/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  }).catch(() => null);
  if (!res?.ok) {
    showWindow();
    return notify("Couldn't sign in", (await res?.json().catch(() => null))?.error ?? "Try again from the app.");
  }
  const s = await res.json();
  await session.fromPartition(PARTITION).cookies.set({
    url: STAND_URL,
    name: s.cookie,
    value: s.session,
    path: "/",
    httpOnly: true,
    secure: STAND_URL.startsWith("https:"),
    sameSite: "lax",
    expirationDate: Math.floor((Date.now() + s.maxAgeMs) / 1000),
  });
  showWindow(land);
}

// ---- microphone and screen sharing inside the window ----------------------------

function isStand(url) {
  try {
    return new URL(url).origin === STAND_ORIGIN;
  } catch {
    return false;
  }
}

function allowMediaAndSharing(ses) {
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-sanitized-write", "fullscreen"]);
  ses.setPermissionRequestHandler((wc, permission, done, details) =>
    done(allowed.has(permission) && isStand(details.requestingUrl || wc.getURL())),
  );
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && isStand(origin));
  // Where macOS has its own window-and-screen picker (15 and later) it's used; otherwise the screen.
  // With more than one display there, it asks which.
  ses.setDisplayMediaRequestHandler(
    async (_req, done) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length < 2) {
        trace("share", { picker: "fallback", source: sources[0]?.name ?? null });
        return done(sources[0] ? { video: sources[0] } : {});
      }
      const displays = screen.getAllDisplays();
      const name = (s, i) => displays.find((d) => String(d.id) === s.display_id)?.label || `Screen ${i + 1}`;
      const { response } = await dialog.showMessageBox(win ?? undefined, {
        message: "Share which screen?",
        buttons: [...sources.map(name), "Cancel"],
        defaultId: 0,
        cancelId: sources.length,
      });
      trace("share", { picker: "fallback", source: sources[response]?.name ?? null });
      done(response < sources.length ? { video: sources[response] } : {});
    },
    { useSystemPicker: true },
  );
}

// ---- Snap from anywhere ---------------------------------------------------------
// ⌃⇧S puts a capture toolbar like macOS's ⌘⇧5 over the display under the pointer:
// the entire screen, one window, or a box you move and resize (it's where you left
// it last time). The snap goes to the meeting you're in, on whatever is in focus,
// and to the clipboard; Options turns either off and sets a 5 or 10 second timer. Out of a
// meeting it's pinned to a note for the bar's space, in the note card that opens under the bar.

/** What the toolbar remembers between snaps. toMeeting is "to Stand": the meeting you're in,
 *  or out of a meeting a note for the bar's space; space is the space the bar holds. */
const SNAP_DEFAULTS = { mode: "portion", toMeeting: true, toClipboard: true, timer: 0, box: null, space: null };
const prefsFile = () => path.join(app.getPath("userData"), "snap.json");

function snapPrefs() {
  try {
    return cleanPrefs(JSON.parse(fs.readFileSync(prefsFile(), "utf8")));
  } catch {
    return { ...SNAP_DEFAULTS };
  }
}

function cleanPrefs(p) {
  const unit = (v) => typeof v === "number" && v >= 0 && v <= 1;
  const box = p?.box && ["x", "y", "w", "h"].every((k) => unit(p.box[k])) ? p.box : null;
  return {
    mode: ["screen", "window", "portion"].includes(p?.mode) ? p.mode : SNAP_DEFAULTS.mode,
    toMeeting: p?.toMeeting !== false,
    toClipboard: p?.toClipboard !== false || p?.toMeeting === false,
    timer: [5, 10].includes(p?.timer) ? p.timer : 0,
    box,
    space: typeof p?.space === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.space) ? p.space : null,
  };
}

const savePrefs = (p) => fs.promises.writeFile(prefsFile(), JSON.stringify(cleanPrefs(p))).catch(() => {});

/** The space whose meeting the main window is in, if any. The page says which; an older page
 *  doesn't, so then it's read from the address (/s/ and /r/ both open a space). */
function spaceId() {
  if (!win || !meeting) return null;
  if (meeting.roomId) return meeting.roomId;
  const m = /^\/[sr]\/([A-Za-z0-9_-]+)/.exec(new URL(win.webContents.getURL()).pathname);
  return m ? m[1] : null;
}

/** The toolbar or the timer, while either is up: the shortcut again closes it. */
let picking = null;

/** The space of a call you're in outside this app (in a browser), or null. Asked fresh, but
 *  never waited on for long: without an answer, it's what the bar last knew. */
async function callElsewhere() {
  await Promise.race([refreshRest("snap"), new Promise((r) => setTimeout(r, 2500))]);
  return !meeting && resting?.call ? resting.spaceId : null;
}

/** Snaps, and resolves to what to tell the person ({ title, body }), or nothing when they
 *  cancelled. The shortcut shows it as a notification; the page's Snap button shows it in
 *  the page, where it can't be missed. */
async function snap(from, onDisplay) {
  const report = await snapOn(from, onDisplay);
  // A click on another display moves the toolbar there.
  return report?.switchTo ? snap(from, report.switchTo) : report;
}

async function snapOn(from, onDisplay) {
  // Pressed again while the screen is still being read (macOS asking for permission, say):
  // give up on this one and free the shortcut, so it can never get stuck.
  if (picking) {
    // The last one is past the toolbar and only saving: say so rather than doing nothing.
    if (picking.saving) return { title: "Still saving the last snap", body: "Try again in a moment." };
    trace("cancel");
    return picking.cancel();
  }
  // The "Snapped" corner from the last one mustn't end up in this picture.
  if (hud && !hud.isDestroyed()) hud.close();
  const me = {
    cancelled: false,
    cancel: () => {
      me.cancelled = true;
      if (picking === me) picking = null;
    },
  };
  picking = me;
  const t0 = Date.now();
  const wasInStand = BrowserWindow.getFocusedWindow() != null;
  const display = onDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // What doesn't need the bar out of the way starts now, so the toolbar can show as soon as
  // the screen is read: the toolbar's window (hidden until then), the window list, the app in front.
  const windows = within(windowsOn(display), 8000).then((w) => {
    trace("windows", { count: w?.length ?? null, ms: Date.now() - t0 });
    return w ?? [];
  });
  const asked = frontInfo();
  // Joined a call in a browser since the bar last looked? Asked now, answered by the time you've picked.
  const call = meeting ? null : callElsewhere();
  const overlay = makeToolbar(display);
  const others = elsewhere(me, display);
  // The bar is up when Stand is in the background, which is when people snap: keep it out of
  // the picture, and the note card with it. macOS takes them off the screen within a frame or two.
  barAway = true;
  const noteUp = Boolean(noteWin?.isVisible());
  if (noteUp) noteWin.hide();
  if (bar?.isVisible() || noteUp) {
    closeBarList();
    hideBar();
    barSnapped = true;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    trace("start", { from, display: display.bounds, scale: display.scaleFactor, permission: screenStatus(), wasInStand });
    const still = await within(grabDisplay(display), 8000);
    trace("grabbed", { still: still?.getSize() ?? null, permission: screenStatus(), cancelled: me.cancelled, ms: Date.now() - t0 });
    if (me.cancelled) return;
    if (!still || !screenAllowed()) return cantSee();
    const at = Date.now();
    const roomId = spaceId();
    // In a call in a browser, a snap goes into that call, as it does in one here.
    const callId = roomId ? null : resting?.call ? resting.spaceId : null;
    void asked.then((front) => {
      // Snapped from another app: that's the app to hand the screen back to afterwards.
      if (!wasInStand && front?.pid && front.pid !== process.pid) theirApp = front;
      trace("front", { front: front?.name });
    });
    for (const o of others) o.showInactive();
    const choice = await openToolbar(me, overlay, display, still, windows, { prefs: snapPrefs(), inMeeting: Boolean(roomId || callId), space: resting?.space ?? null, t0 });
    trace("toolbar", { choice: choice && (choice.failed ?? (choice.cancel ? "cancel" : choice.mode)) });
    if (me.switchTo) return { switchTo: me.switchTo };
    // The other displays were only dimmed for choosing one: give them back now, not after saving.
    for (const o of others) if (!o.isDestroyed()) o.close();
    if (choice?.failed) return { title: "Snap's toolbar didn't open", body: choice.failed };
    if (choice?.prefs) void savePrefs(choice.prefs);
    // Snapping from another app leaves Stand in the background (the toolbar never makes it
    // the active app). Should Stand have come forward anyway, give the screen back.
    if (mac && !wasInStand) await handBack();
    if (!choice || choice.cancel) return;
    const prefs = cleanPrefs(choice.prefs);
    let shot = still;
    let shotAt = at;
    if (prefs.timer) {
      // The timer is for setting the screen up (opening a menu, say), so it snaps the screen as it is then.
      if (!(await countdown(me, display, prefs.timer))) return;
      shot = await within(grabDisplay(display), 8000);
      shotAt = Date.now();
      if (!shot) return cantSee();
    }
    const image = await cut(choice, display, shot, await windows);
    trace("cut", { size: image.getSize() });
    // The text in it, read on this Mac while it saves (or while you pick where it goes).
    const reading = readText(image);
    // The screen's been read: the bar can come back while the snap saves, and say that it is.
    barAway = false;
    updateBar();
    const to = roomId ?? (await call);
    // Out of a meeting it's pinned to the note card under the bar, and saved with the note.
    if (!to && prefs.toMeeting) return await pinSnap(image, shotAt, prefs, reading);
    me.saving = true;
    // Where it began says where it's reported: from the page's Snap button, in the page;
    // otherwise on the bar while it's up, else in the page if Stand is in front (and in the meeting).
    const onBar = Boolean(to && prefs.toMeeting && from !== "page" && bar?.isVisible());
    if (onBar) bar.webContents.send("bar:report", { title: "Saving snap…", pending: true });
    const inPage = Boolean(roomId && prefs.toMeeting && !onBar && win?.isVisible());
    if (inPage) win.webContents.send("app:command", "saving");
    const report = await deliver(image, shotAt, prefs, to).finally(() => inPage && !win.isDestroyed() && win.webContents.send("app:command", "saved"));
    void addText(report.snapId, reading);
    // The bar said it was saving, so the bar says how it went, wherever the snap began.
    if (onBar && bar && !bar.isDestroyed()) {
      bar.webContents.send("bar:report", report);
      report.onBar = true;
    }
    return report;
  } catch (err) {
    trace("error", { error: String(err?.stack ?? err), permission: screenStatus() });
    // Without the permission, reading the screen can fail outright instead of coming back blank.
    if (mac && screenStatus() !== "granted") return cantSee();
    return { title: "Snap didn't work", body: String(err?.message ?? err) };
  } finally {
    if (!overlay.isDestroyed()) overlay.close();
    for (const o of others) if (!o.isDestroyed()) o.close();
    if (picking === me) picking = null;
    barAway = false;
    updateBar();
    // The note card, if it stepped out of the picture.
    if (noteUp && noteWin && !noteWin.isDestroyed() && !noteWin.isVisible()) {
      noteWin.showInactive();
      noteWin.focus();
      tieNote();
    }
  }
}

/** Shows what snap() came back with: on the floating bar when it's up; else a snap that worked
 *  shows as a thumbnail in the corner for a moment, as macOS's own screenshots do, and a
 *  problem as a notification. */
function tell(report) {
  // The note card shows a pinned snap.
  if (!report || report.quiet) return;
  if (bar?.isVisible()) {
    if (!report.onBar) bar.webContents.send("bar:report", report);
  } else if (report.thumb) thumbnail(report);
  else notify(report.title, report.body, report.settings);
}

/** "Snapped" with a small picture, bottom right, for a few seconds. A click opens Stand. */
let hud = null;
function thumbnail(report) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width, height] = [260, 84];
  if (hud && !hud.isDestroyed()) hud.close();
  hud = new BrowserWindow({
    x: d.x + d.width - width - 16,
    y: d.y + d.height - height - 16,
    width,
    height,
    ...(mac ? { type: "panel" } : {}),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    acceptFirstMouse: true,
    webPreferences: { contextIsolation: true, sandbox: true, javascript: false },
  });
  hud.setAlwaysOnTop(true, "floating");
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  staysInBackground(hud, "thumbnail");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>Snapped</title>
<style>html,body{margin:0;height:100%;background:transparent;font:12px -apple-system,system-ui;color:#e8e8ee;user-select:none;cursor:default}
a{position:absolute;inset:4px;display:flex;gap:10px;align-items:center;padding:6px;border-radius:12px;background:rgb(24 25 30 / .97);box-shadow:0 0 0 1px rgb(255 255 255 / .14),0 6px 18px rgb(0 0 0 / .35);color:inherit;text-decoration:none}
img{height:100%;max-width:110px;border-radius:6px;object-fit:cover}strong{display:block;margin-bottom:2px;font-size:12.5px}span{color:#a5a5b3}
@keyframes fade{to{opacity:0}}a{animation:fade .2s ease-out 3.8s forwards}
@media (prefers-reduced-motion:no-preference){a{animation:in .18s cubic-bezier(.23,1,.32,1) 60ms both,out .2s cubic-bezier(.23,1,.32,1) 3.8s forwards}@keyframes in{from{opacity:0;transform:translateY(6px)}}@keyframes out{to{opacity:0;transform:translateY(6px)}}}</style>
<a href="https://stand.invalid/open"><img src="${report.thumb}" alt=""><div role="status"><strong>${esc(report.title)}</strong><span>${esc(report.snapId ? "In the meeting. Click to open Stand." : report.body)}</span></div></a>`;
  hud.webContents.on("will-navigate", (e) => {
    e.preventDefault();
    if (!hud.isDestroyed()) hud.close();
    showWindow();
  });
  hud.webContents.once("did-finish-load", () => hud.showInactive());
  void hud.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const mine = hud;
  setTimeout(() => !mine.isDestroyed() && mine.close(), 4100);
}

/** Run from source, each Snap step goes to desktop/snap-debug.log, so a snap that
 *  does nothing on someone's Mac can be read back afterwards. */
function trace(step, data = {}) {
  if (app.isPackaged) return;
  const line = `${new Date().toISOString()} ${step} ${JSON.stringify(data)}\n`;
  fs.promises.appendFile(path.join(__dirname, "snap-debug.log"), line).catch(() => {});
}

/** After the toolbar closes: a Stand window in front now means Stand came forward during
 *  the snap. Put back the app that was in front before (hiding Stand if it's unknown). */
async function handBack() {
  await new Promise((r) => setTimeout(r, 100));
  const standInFront = BrowserWindow.getFocusedWindow() != null;
  trace("after", { standInFront, front: await frontApp() });
  if (!standInFront) return;
  if (theirApp) await giveBack("toolbar");
  else app.hide();
}

/** The app in front on the Mac: its name, bundle id and process id, from Launch Services. */
async function frontInfo() {
  if (!mac) return null;
  try {
    const asn = await run("lsappinfo", ["front"]);
    // Each answer looks like "CFBundleIdentifier"="com.google.Chrome" or "pid"=1234.
    const field = async (key) => /=\s*"?([^"\n]*)"?\s*$/.exec(await run("lsappinfo", ["info", "-only", key, asn]))?.[1] ?? "";
    const [name, bundleId, pid] = await Promise.all(["name", "bundleid", "pid"].map(field));
    return { name, bundleId, pid: Number(pid) || null };
  } catch {
    return null;
  }
}

/** The app in front, by name, for the Snap log. Only run from source. */
const frontApp = async () => (app.isPackaged ? undefined : ((await frontInfo())?.name ?? null));

/** Null if it takes longer than ms. */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

const screenStatus = () => (mac ? systemPreferences.getMediaAccessStatus("screen") : "granted");
/** Without the permission, macOS hands back a still of just the wallpaper, so ask it directly. */
const screenAllowed = () => !["denied", "restricted"].includes(screenStatus());

/** Says what's missing, with the way to the right page of System Settings (opened only when
 *  the person asks: macOS may be showing its own prompt right now). Run from source, macOS
 *  asks on behalf of the terminal app it was started from, not Stand. */
const SETTINGS = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};
const openSettings = (which) => SETTINGS[which] && mac && void shell.openExternal(SETTINGS[which]);
function cantSee() {
  return {
    settings: "screen",
    title: "Stand can't see your screen",
    body: app.isPackaged
      ? "Turn on Stand in Screen & System Audio Recording, then quit and reopen Stand."
      : "Turn on the terminal app you ran npm run try:mac in (Terminal, Warp…) in Screen & System Audio Recording, then quit that app, reopen it and run npm run try:mac again.",
  };
}

/** The display at full resolution. */
async function grabDisplay(display) {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
}

/** Ordinary app windows on this display, front to back, in screen points. */
async function windowsOn(display) {
  const all = await listWindows().catch(() => []);
  const b = display.bounds;
  return all.filter((w) => w.w >= 40 && w.h >= 40 && w.x < b.x + b.width && w.x + w.w > b.x && w.y < b.y + b.height && w.y + w.h > b.y);
}

/** On the Mac, from CoreGraphics: through the native code, or osascript if that didn't
 *  build. No extra permission, and the window ids match desktopCapturer's. Elsewhere
 *  (trying the app on Linux), xdotool if it's there. */
const WINDOWS_JXA = `ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
JSON.stringify(list.filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0).map((w) => ({
  id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || "",
  x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height,
})));`;

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 3000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim()))),
  );
}

async function listWindows() {
  if (mac && native()?.windows) return JSON.parse(native().windows());
  if (mac) return JSON.parse(await run("osascript", ["-l", "JavaScript", "-e", WINDOWS_JXA]));
  if (process.platform !== "linux") return [];
  // xdotool lists top-level windows bottom to top.
  // A window coming or going mid-search (Snap's own toolbar, say) can make it fail: once more
  // then, leaving out Stand's own windows other than the main one.
  const search = () => run("xdotool", ["search", "--onlyvisible", "--name", "."]);
  const found = await search().catch(() => new Promise((r) => setTimeout(r, 50)).then(search));
  const ours = new Set(BrowserWindow.getAllWindows().filter((w) => w !== win).map((w) => w.getNativeWindowHandle().readUInt32LE(0)));
  const ids = found
    .split("\n")
    .filter((id) => id && !ours.has(Number(id)))
    .reverse();
  const geo = await Promise.all(ids.map((id) => run("xdotool", ["getwindowgeometry", "--shell", id]).catch(() => "")));
  return geo
    .map((g, i) => {
      const v = Object.fromEntries(g.split("\n").map((l) => l.split("=")));
      return { id: Number(ids[i]), app: "", x: Number(v.X), y: Number(v.Y), w: Number(v.WIDTH), h: Number(v.HEIGHT) };
    })
    .filter((w) => Number.isFinite(w.w));
}

/** The toolbar's window over one display, hidden, with its page loading. `loaded` resolves
 *  to null once it's ready, or to why it couldn't load. */
function makeToolbar(display) {
  const overlay = new BrowserWindow({
    ...display.bounds,
    ...(mac ? { type: "panel" } : {}),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    roundedCorners: false,
    enableLargerThanScreen: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: `${__dirname}/snap-preload.js`, contextIsolation: true, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlay.setBounds(display.bounds);
  staysInBackground(overlay, "toolbar");
  overlay.loaded = new Promise((resolve) => {
    overlay.webContents.once("did-finish-load", () => resolve(null));
    overlay.webContents.once("did-fail-load", (_e, code, why) => resolve(`It couldn't load (${why || code}).`));
  });
  overlay.webContents.on("console-message", (e, ...old) => trace("toolbar-console", { message: e.message ?? old[1] }));
  void overlay.loadFile(`${__dirname}/snap.html`);
  return overlay;
}

/** The toolbar over a still of one display, in the window makeToolbar made. The window list
 *  follows when it's ready. Resolves to what to snap, or a cancel (with the settings to
 *  keep), or null if it closed some other way. */
function openToolbar(me, overlay, display, still, windows, { prefs, inMeeting, space, t0 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      clearTimeout(slow);
      clearTimeout(escTimer);
      ipcMain.removeListener("snap:done", onDone);
      ipcMain.removeListener("snap:ready", onReady);
      ipcMain.removeListener("snap:kept", onKept);
      globalShortcut.unregister("Escape");
      if (!overlay.isDestroyed()) overlay.close();
      resolve(choice);
    };
    const onDone = (e, choice) => e.sender === overlay.webContents && finish(choice);
    // The page handles Esc (it closes Options before the toolbar); this is in case it can't.
    let escTimer;
    const onKept = (e) => e.sender === overlay.webContents && clearTimeout(escTimer);
    const onReady = (e) => {
      if (e.sender !== overlay.webContents || overlay.isDestroyed()) return;
      clearTimeout(slow);
      // The toolbar is a panel: it takes the keyboard without making Stand the active app.
      // Activating Stand here would bring its window up over the app you're in, or switch to
      // Stand's Space when that app is full screen or on another desktop.
      overlay.show();
      overlay.focus();
      const ms = Date.now() - t0;
      void frontApp().then((front) =>
        trace("shown", { visible: overlay.isDestroyed() ? null : overlay.isVisible(), focused: !overlay.isDestroyed() && overlay.isFocused(), front, ms, jpegMs }),
      );
    };
    // The toolbar shows once its still has loaded. If that never happens, say so rather
    // than leave an invisible toolbar holding Snap.
    const slow = setTimeout(() => finish({ failed: "It didn't finish loading. Try again, or quit and reopen Stand." }), 10_000);
    overlay.webContents.on("render-process-gone", (_e, d) => finish({ failed: `It stopped (${d.reason}).` }));
    me.cancel = () => finish(null);
    ipcMain.on("snap:done", onDone);
    ipcMain.on("snap:ready", onReady);
    ipcMain.on("snap:kept", onKept);
    // Esc works even if the toolbar didn't get keyboard focus.
    globalShortcut.register("Escape", () => {
      if (overlay.isDestroyed()) return finish(null);
      overlay.webContents.send("snap:escape");
      clearTimeout(escTimer);
      escTimer = setTimeout(() => finish(null), 400);
    });
    overlay.on("closed", () => finish(null));
    const b = display.bounds;
    const t1 = Date.now();
    const image = `data:image/jpeg;base64,${still.toJPEG(90).toString("base64")}`;
    const jpegMs = Date.now() - t1;
    const open = () => !done && !overlay.isDestroyed();
    void overlay.loaded.then((failed) => {
      if (failed) return finish({ failed });
      if (!open()) return;
      const accent = mac ? systemPreferences.getAccentColor?.() : null;
      overlay.webContents.send("snap:open", { image, windows: [], prefs, inMeeting, space, accent: accent ? `#${accent.slice(0, 6)}` : null });
      void windows.then(
        (list) => open() && overlay.webContents.send("snap:windows", list.map((w) => ({ id: w.id, x: w.x - b.x, y: w.y - b.y, w: w.w, h: w.h }))),
      );
    });
  });
}

/** "Snapping in 5…" at the top of the screen, out of the way and never focused.
 *  Resolves true when it's time, false if it was cancelled. */
function countdown(me, display, seconds) {
  return new Promise((resolve) => {
    const width = 180;
    const height = 44;
    const tick = new BrowserWindow({
      x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
      y: display.bounds.y + 36,
      width,
      height,
      ...(mac ? { type: "panel" } : {}),
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#1f1f21",
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    tick.setAlwaysOnTop(true, "screen-saver");
    tick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    let left = seconds;
    let timer = null;
    const page = (n) =>
      `data:text/html;charset=utf-8,${encodeURIComponent(`<title>Snap timer</title><body role="timer" aria-live="polite" style="margin:0;height:100vh;display:grid;place-items:center;background:#1f1f21;color:#fff;font:14px -apple-system,system-ui;user-select:none">Snapping in ${n}…</body>`)}`;
    const end = (go) => {
      clearInterval(timer);
      globalShortcut.unregister("Escape");
      if (!tick.isDestroyed()) tick.close();
      // Give the screen a moment to lose the countdown before it's snapped.
      setTimeout(() => resolve(go), go ? 250 : 0);
    };
    me.cancel = () => end(false);
    globalShortcut.register("Escape", () => end(false));
    tick.webContents.once("did-finish-load", () => tick.showInactive());
    void tick.loadURL(page(left));
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) return end(true);
      // In place: reloading the page each second can flicker.
      if (!tick.isDestroyed()) void tick.webContents.executeJavaScript(`document.body.textContent = "Snapping in ${left}…"`).catch(() => {});
    }, 1000);
  });
}

/** The part of the screen that was picked, in image pixels. */
async function cut(choice, display, shot, windows) {
  const { width: iw, height: ih } = shot.getSize();
  const crop = (r, [cw, ch]) => {
    const sx = iw / cw;
    const sy = ih / ch;
    const x = Math.max(0, Math.round(r.x * sx));
    const y = Math.max(0, Math.round(r.y * sy));
    const width = Math.min(iw - x, Math.round((r.x + r.w) * sx) - x);
    const height = Math.min(ih - y, Math.round((r.y + r.h) * sy) - y);
    return width > 0 && height > 0 ? shot.crop({ x, y, width, height }) : shot;
  };
  if (choice.mode === "portion" && choice.rect) return crop(choice.rect, choice.size);
  if (choice.mode === "window") {
    const w = windows.find((w) => w.id === choice.windowId);
    if (!w) return shot;
    // On the Mac, the window by itself, as macOS draws it even where something covers it.
    const alone = mac ? await grabWindow(w, display).catch(() => null) : null;
    if (alone) return alone;
    const b = display.bounds;
    return crop({ x: w.x - b.x, y: w.y - b.y, w: w.w, h: w.h }, [b.width, b.height]);
  }
  return shot;
}

async function grabWindow(w, display) {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: Math.round(w.w * display.scaleFactor), height: Math.round(w.h * display.scaleFactor) },
  });
  const source = sources.find((s) => s.id.startsWith(`window:${w.id}:`));
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
}

/** How long saving a snap may take, all tries together. */
const SAVE_WITHIN_MS = 90_000;

/** A request to Stand as the person signed in to the app, with its cookies. */
const standFetch = (p, opts = {}) => session.fromPartition(PARTITION).fetch(`${STAND_URL}${p}`, { credentials: "include", ...opts });

const copyImage = (image) => clipboard.write([new ClipboardItem({ "image/png": new Blob([image.toPNG()], { type: "image/png" }) })]);

/** Sends a snap to a space: to its meeting, or with to=space straight to the space (and with
 *  jot=, pinned to a note). A blip in the connection shouldn't lose it: a few tries, each with a
 *  time limit, as in the page. extra.key, when given, is the key for every try instead of a new
 *  one. Resolves to {ok, id} or {ok: false, why}. */
async function postSnap(image, at, roomId, extra = {}, line = "") {
  const { width: w, height: h } = image.getSize();
  const body = image.toJPEG(90);
  // One key for every try, so a try that got through before timing out isn't saved twice.
  const query = new URLSearchParams({ at: String(at), w: String(w), h: String(h), key: crypto.randomUUID(), ...extra });
  // Longer for a bigger picture: at least 15 s, and as long as a slow (50 KB/s) line needs,
  // but all the tries together get 90 s, so Snap is never held up for long.
  const limit = Math.min(SAVE_WITHIN_MS, Math.max(15_000, body.length / 50));
  const deadline = Date.now() + SAVE_WITHIN_MS;
  let res = null;
  for (const wait of [0, 1000, 3000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const left = deadline - Date.now();
    if (left < 2000) break;
    res = await standFetch(`/api/rooms/${encodeURIComponent(roomId)}/snaps?${query}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", ...(line ? { "x-stand-line": encodeURIComponent(line) } : {}) },
      body,
      signal: AbortSignal.timeout(Math.min(limit, left)),
    }).catch(() => null);
    if (res && res.status < 502) break;
  }
  if (!res?.ok) return { ok: false, why: (await res?.json().catch(() => null))?.error ?? (res ? `Stand said ${res.status}.` : "Stand didn't answer.") };
  return { ok: true, id: (await res.json().catch(() => null))?.id ?? null };
}

/** To the clipboard and the meeting, as the options say. */
async function deliver(image, at, prefs, roomId) {
  const toMeeting = Boolean(roomId) && prefs.toMeeting;
  const copy = prefs.toClipboard || !toMeeting;
  if (copy) await copyImage(image);
  const thumb = image.resize({ height: 152 }).toDataURL();
  if (!toMeeting) return { title: "Snapped", body: "It's on your clipboard.", thumb };
  const saved = await postSnap(image, at, roomId);
  if (!saved.ok) {
    return copy
      ? { title: "Copied, but not added to the meeting", body: `${saved.why} Paste it into Stand to add it.` }
      : { title: "Snap didn't save", body: saved.why };
  }
  return {
    title: "Snapped",
    body: copy ? "It's on your clipboard and in the meeting, on the item in focus." : "It's in the meeting, on the item in focus. Crop or delete it in Stand.",
    snapId: saved.id,
    thumb,
  };
}

/** The Mac's accent color, and black or white text on it, whichever reads. */
function accentColors() {
  const a = mac ? systemPreferences.getAccentColor?.() : null;
  if (!a) return {};
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return { accent: `#${a.slice(0, 6)}`, onAccent: 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#000" : "#fff" };
}

// ---- a note to the space -----------------------------------------------------------------
//
// From the bar's note field, or the note shortcut in any app: a small card just under the bar
// (over it, when the bar is low on the screen) where you type the note or say it with the Mac's
// dictation, and Enter saves it to the space the bar holds (the meeting's, in one). It takes the
// keyboard without bringing Stand forward (it's a panel), and closing it hands the keyboard back.
// A snap out of a meeting is pinned to the top of it: Enter saves the note with its pictures, or
// with nothing written, the pictures by themselves. Nothing leaves the Mac before Enter.

let noteWin = null;
/** What was written when the card was put away unsaved: it's there again next time. */
let noteDraft = "";
/** Snaps pinned to the note, waiting for Enter: {id, image, at, thumb, reading, key}. */
let notePins = [];
const MAX_PINS = 6;
/** A note already saved whose snaps didn't all make it: Enter again adds the rest to it. */
let noteSaved = null;

/** Pins a snap to the note card, opening it if it's closed. Resolves to a report that says
 *  nothing (the card shows it), or why it wasn't pinned. */
async function pinSnap(image, at, prefs, reading) {
  const thumb = image.resize({ height: 152 }).toDataURL();
  if (prefs.toClipboard) await copyImage(image);
  if (notePins.length >= MAX_PINS) {
    if (!prefs.toClipboard) await copyImage(image);
    return { title: `${MAX_PINS} snaps are pinned already`, body: "Save the note, or take one off it, then snap again. This one is on your clipboard.", thumb };
  }
  // Shown as wide as the bar on a Retina screen.
  const { width: w } = image.getSize();
  const shown = w > 800 ? image.resize({ width: 800 }) : image;
  notePins.push({ id: crypto.randomUUID(), image, at, thumb: `data:image/jpeg;base64,${shown.toJPEG(82).toString("base64")}`, reading, key: crypto.randomUUID() });
  trace("pin", { pins: notePins.length });
  sendBarState();
  if (noteWin && !noteWin.isDestroyed()) {
    sendPins();
    return { quiet: true };
  }
  const opened = await openNote();
  // No space to save it to (signed out, say): it's on the clipboard instead.
  if (opened === false) {
    notePins.pop();
    sendBarState();
    if (!prefs.toClipboard) await copyImage(image);
    return { title: "Copied, not pinned to a note", body: "Sign in to Stand and make a space; then snaps can go there.", thumb };
  }
  return { quiet: true };
}

const sendPins = () => noteWin && !noteWin.isDestroyed() && noteWin.webContents.send("note:pins", notePins.map(({ id, thumb }) => ({ id, thumb })));

/** Room the card wants over the bar before it opens that way: a snap shown big and a few lines. */
const NOTE_ROOM = 340;

/** Where the card goes for a given height: joined to the bar's upper edge when there's room over
 *  it, else its lower edge (the bar at the top of the screen, where it starts), so the two read as
 *  one piece and the snaps, on the card's far side, are on the outside of it. Once open it stays
 *  on its side while it fits. Away from the bar (the bar is down): the top of the screen the
 *  pointer is on. */
function notePlace(height) {
  if (bar?.isVisible()) {
    const [x, y] = bar.getPosition();
    const a = screen.getDisplayMatching({ x, y, ...BAR }).workArea;
    // The bar's pill runs from 4 px to BAR.height - 4 px down its window.
    const roomAbove = y + 4 - a.y;
    const roomBelow = a.y + a.height - (y + BAR.height - 4);
    const was = notePlaced?.fused ? notePlaced.above : null;
    const fits = (up) => height <= (up ? roomAbove : roomBelow);
    const above = was !== null && fits(was) ? was : roomAbove >= Math.max(height, NOTE_ROOM) || !fits(false);
    return { x, y: above ? y - height + 4 : y + BAR.height - 4, above, fused: true };
  }
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return { x: Math.round(a.x + (a.width - BAR.width) / 2), y: a.y + 8, above: false, fused: false };
}

/** On the Mac the card is the bar's child window while it hangs from the bar, so macOS moves the
 *  two together, in the same frame, as the bar is dragged: following the bar's "moved" events
 *  lagged a frame or two behind, and the card came apart from the bar. */
let noteTied = false;
function tieNote() {
  if (!mac || !noteWin || noteWin.isDestroyed()) return;
  const tie = Boolean(notePlaced?.fused && bar && !bar.isDestroyed() && bar.isVisible() && noteWin.isVisible());
  if (tie === noteTied) return;
  noteTied = tie;
  noteWin.setParentWindow(tie ? bar : null);
}
/** Before the bar goes away: macOS would take its child, the card, with it. */
function untieNote() {
  if (!noteTied) return;
  noteTied = false;
  if (noteWin && !noteWin.isDestroyed()) noteWin.setParentWindow(null);
}

let noteHeight = 96;
/** How the card was last told to draw itself: {above, fused}. */
let notePlaced = null;

/** Puts the card where it goes for its height, as the bar moves or it grows, and tells it and the
 *  bar when the way they join changes. */
function placeNote() {
  if (!noteWin || noteWin.isDestroyed()) return;
  const place = notePlace(noteHeight);
  noteWin.setBounds({ x: place.x, y: place.y, width: BAR.width, height: noteHeight });
  if (notePlaced?.above !== place.above || notePlaced?.fused !== place.fused) {
    notePlaced = { above: place.above, fused: place.fused };
    noteWin.webContents.send("note:place", notePlaced);
  }
  tieNote();
  sendBarNote();
}

/** The bar squares off the edge the card hangs from while it's open. */
function sendBarNote() {
  if (!barLoaded || !bar || bar.isDestroyed()) return;
  const open = noteWin && !noteWin.isDestroyed() && noteWin.isVisible() && notePlaced?.fused;
  bar.webContents.send("bar:note", open ? { above: notePlaced.above } : null);
}

/** Opens the card, or brings the keyboard back to it. False when there's no space to write to. */
async function openNote() {
  if (noteWin && !noteWin.isDestroyed()) {
    noteWin.focus();
    noteWin.webContents.send("note:focus");
    return true;
  }
  if (!meeting && !resting) await refreshRest("note");
  const to = meeting ? spaceId() : resting?.spaceId;
  const space = meeting ? meeting.space : resting?.space;
  if (!to) {
    notify(resting ? "No space to save it to" : "Sign in to Stand", resting ? "Make a space in Stand first." : "Then notes can go to your spaces.");
    return false;
  }
  closeBarList();
  noteHeight = notePins.length ? 320 : 96;
  notePlaced = null;
  const place = notePlace(noteHeight);
  notePlaced = { above: place.above, fused: place.fused };
  const card = new BrowserWindow({
    x: place.x,
    y: place.y,
    width: BAR.width,
    height: noteHeight,
    ...(mac ? { type: "panel" } : {}),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    acceptFirstMouse: true,
    webPreferences: { preload: `${__dirname}/note-preload.js`, contextIsolation: true, sandbox: true },
  });
  noteWin = card;
  card.setAlwaysOnTop(true, "floating");
  card.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  card.setContentProtection(true);
  staysInBackground(card, "note");
  const mine = (e) => e.sender === card.webContents;
  let saving = false;
  let done = false;
  // Esc is caught for the card only while it has the keyboard, never from the app you're in.
  const esc = () => !card.isDestroyed() && card.webContents.send("note:escape");
  const finish = () => {
    if (done) return;
    done = true;
    for (const [name, fn] of handlers) ipcMain.removeListener(name, fn);
    if (globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
    if (noteWin === card) untieNote();
    if (!card.isDestroyed()) card.close();
    if (noteWin === card) noteWin = null;
    sendBarNote();
  };
  const handlers = [
    [
      "note:ready",
      (e) => {
        if (!mine(e) || card.isDestroyed()) return;
        card.showInactive();
        card.focus();
        tieNote();
        sendBarNote();
      },
    ],
    [
      "note:size",
      (e, h) => {
        if (!mine(e) || card.isDestroyed()) return;
        noteHeight = Math.max(40, Math.min(520, Math.round(Number(h) || 0)));
        placeNote();
      },
    ],
    [
      "note:cancel",
      (e, draft) => {
        if (!mine(e) || saving) return;
        noteDraft = typeof draft === "string" ? draft.slice(0, 2000) : "";
        finish();
      },
    ],
    [
      "note:unpin",
      (e, id) => {
        if (!mine(e) || saving) return;
        notePins = notePins.filter((p) => p.id !== id);
        sendPins();
        sendBarState();
      },
    ],
    [
      "note:go",
      async (e, text) => {
        if (!mine(e) || saving || typeof text !== "string" || (!text.trim() && !notePins.length)) return;
        saving = true;
        const n = notePins.length;
        const saved = await saveNote(to, text.trim().slice(0, 2000));
        saving = false;
        trace("note", { ok: saved.ok, chars: text.length, pins: n, left: notePins.length });
        sendBarState();
        if (card.isDestroyed()) return;
        sendPins();
        card.webContents.send("note:result", saved.ok ? { ok: true, space, text: Boolean(text.trim()), snaps: n } : { ok: false, why: saved.why });
        if (!saved.ok) return;
        noteDraft = "";
        setTimeout(finish, 1200);
      },
    ],
  ];
  for (const [name, fn] of handlers) ipcMain.on(name, fn);
  card.on("focus", () => !globalShortcut.isRegistered("Escape") && globalShortcut.register("Escape", esc));
  card.on("blur", () => globalShortcut.isRegistered("Escape") && globalShortcut.unregister("Escape"));
  card.on("closed", finish);
  card.webContents.once("did-finish-load", () => {
    card.webContents.send("note:open", { space, draft: noteDraft, ...notePlaced, dictateKey: "🎤, or Fn twice", ...accentColors() });
    sendPins();
  });
  void card.loadFile(`${__dirname}/note.html`);
  return true;
}

/** Saves the note to a space with the snaps pinned to it: the note first, then each snap pinned
 *  to it (with nothing written, each snap by itself). The note's key makes a retry of one that
 *  got through come back as the same note; a snap that saved comes off the card, so Enter again
 *  sends only the ones that didn't. Resolves to {ok} or {ok: false, why}. */
async function saveNote(to, text) {
  if (noteSaved && noteSaved.to !== to) noteSaved = null;
  let jot = noteSaved?.id ?? null;
  if (text && !jot) {
    const made = await postNote(to, text);
    if (!made.ok) return made;
    jot = made.id;
  } else if (text && text !== noteSaved?.text) {
    // Saved before with snaps left over, and changed since: the note says what it says now.
    await standFetch(`/api/jots/${encodeURIComponent(jot)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
  }
  const failed = [];
  for (const pin of [...notePins]) {
    const saved = await postSnap(pin.image, pin.at, to, { to: "space", key: pin.key, ...(jot ? { jot } : {}) });
    if (!saved.ok) {
      failed.push(saved.why);
      continue;
    }
    notePins = notePins.filter((p) => p !== pin);
    void addText(saved.id, pin.reading);
  }
  if (!failed.length) {
    noteSaved = null;
    return { ok: true };
  }
  if (jot) noteSaved = { id: jot, to, text };
  const of = jot ? `The note saved, but ${failed.length === 1 ? "a snap" : `${failed.length} snaps`} didn't` : failed.length === 1 ? "The snap didn't save" : `${failed.length} snaps didn't save`;
  return { ok: false, why: `${of}: ${failed[0]} ${failed.length === 1 ? "It's" : "They're"} still here; Enter tries again.` };
}

/** The note by itself, with a retry for a blip in the connection. Resolves to {ok, id} or {ok: false, why}. */
async function postNote(to, text) {
  const body = JSON.stringify({ text, at: Date.now(), key: crypto.randomUUID() });
  let why = "Stand didn't answer. Try again.";
  for (let i = 0; i < 2; i++) {
    const res = await standFetch(`/api/rooms/${encodeURIComponent(to)}/jots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.ok) return { ok: true, id: (await res.json().catch(() => null))?.id ?? null };
    if (res) {
      why = res.status === 401 ? "Sign in to Stand again, then try again." : ((await res.json().catch(() => null))?.error ?? `Stand said ${res.status}.`);
      if (res.status < 500) break;
    }
  }
  return { ok: false, why: `${why} Your note is still here.` };
}

// ---- the text in a snap ----------------------------------------------------------------

/** native/stand-ocr, built by scripts/build-native.js; in the built app it's unpacked from the asar. */
const OCR = path.join(__dirname, "native", "stand-ocr").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

/** The text in a snap, read on this Mac by Apple's Vision. Null when there's none, or it
 *  can't be read here (stand-ocr didn't build, say): the snap saves without it. */
async function readText(image) {
  if (!mac || !fs.existsSync(OCR)) return null;
  const t0 = Date.now();
  const file = path.join(app.getPath("temp"), `stand-snap-${crypto.randomUUID()}.png`);
  try {
    await fs.promises.writeFile(file, image.toPNG());
    const out = await new Promise((resolve) =>
      execFile(OCR, [file], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) trace("text", { error: String(stderr || err.message).trim().slice(0, 200) });
        resolve(err ? null : stdout);
      }),
    );
    trace("text", { chars: out?.trim().length ?? null, ms: Date.now() - t0 });
    return out?.trim() || null;
  } catch (err) {
    trace("text", { error: String(err?.message ?? err) });
    return null;
  } finally {
    fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

/** Once it's read, the text goes on the saved snap, for search and for agents. */
async function addText(snapId, reading) {
  const text = await reading;
  if (!snapId || !text) return;
  await standFetch(`/api/snaps/${encodeURIComponent(snapId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ screenText: text }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
}

/** A notification, for problems. With `settings`, a click opens that page of System Settings. */
function notify(title, body, settings) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: settings ? `${body} Click to open System Settings.` : body, silent: true });
  if (settings) n.on("click", () => openSettings(settings));
  n.show();
}

/** On each other display while the toolbar is up: dimmed, and a click there moves the toolbar
 *  to it, so any screen can be snapped, as with ⌘⇧5. */
function elsewhere(me, display) {
  return screen
    .getAllDisplays()
    .filter((d) => d.id !== display.id)
    .map((d) => {
      const w = new BrowserWindow({
        ...d.bounds,
        ...(mac ? { type: "panel" } : {}),
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        hasShadow: false,
        enableLargerThanScreen: true,
        acceptFirstMouse: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        webPreferences: { contextIsolation: true, sandbox: true, javascript: false },
      });
      w.setAlwaysOnTop(true, "screen-saver");
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      staysInBackground(w, "elsewhere");
      w.webContents.on("will-navigate", (e) => {
        e.preventDefault();
        me.switchTo = d;
        me.cancel();
      });
      const html = `<!doctype html><title>Snap another screen</title><style>html,body{margin:0;height:100%;background:rgb(0 0 0 / .42);font:13px -apple-system,system-ui;user-select:none}
a{position:absolute;inset:0;display:grid;place-items:center;text-decoration:none;cursor:pointer}span{padding:8px 14px;border-radius:10px;background:rgb(30 30 32 / .92);color:#fff}</style>
<a href="https://stand.invalid/here"><span>Click to snap this screen</span></a>`;
      void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return w;
    });
}

// ---- the floating bar -------------------------------------------------------------
//
// A small bar floats over every app and Space whenever the app runs and you're signed in.
// Out of a meeting it holds the space you're in: its name (click to pick another), a field
// for a note to it, its to-dos, a way to start talking there, and Snap, which goes to it. In a meeting: what's in
// focus, your mic, and Snap. It never takes focus from the app you're in, stays out of snaps
// (and, where macOS allows, out of screen sharing), and goes wherever you drag it, which it
// remembers.

/** The meeting the main window is in, as its page last described it, or null. */
let meeting = null;
let bar = null;
let barLoaded = false;
/** True while a snap reads the screen. */
let barAway = false;
/** Put away from the bar's own menu: "meeting" until the meeting ends, "always" until it's
 *  shown again from the View menu (or the app starts again). */
let barOff = null;
const BAR = { width: 400, height: 48 };
const barFile = () => path.join(app.getPath("userData"), "bar.json");
const short = (v) => (typeof v === "string" ? v.slice(0, 200) : "");

function setMeeting(m) {
  meeting =
    m && typeof m === "object"
      ? {
          roomId: typeof m.roomId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(m.roomId) ? m.roomId : null,
          space: short(m.space),
          itemKey: short(m.itemKey) || null,
          item: short(m.item) || null,
          micOn: m.micOn !== false,
          todos: todosOf(m.todos),
          nudge: short(m.nudge) || null,
          nudgeFromTalk: m.nudgeFromTalk === true,
          switched: short(m.switched) || null,
          notRecording: m.notRecording === true,
          offline: m.offline === true,
          ending: m.ending === true,
        }
      : null;
  const sharing = Boolean(m?.sharing);
  if (sharing !== wasSharing) trace("sharing", { on: sharing, barUp: Boolean(bar?.isVisible()) });
  wasSharing = sharing;
  if (!meeting) {
    // Hidden for the meeting, the bar comes back when it ends.
    if (barOff === "meeting") barOff = null;
    pulsedFor = null;
  }
  muteKey(Boolean(meeting));
  sendBarState();
  buildMenus();
  updateBar();
  // Back out of a meeting, the bar shows the space again, with its to-dos as the meeting left them.
  if (inMeeting && !meeting) void refreshRest("meeting-ended");
  inMeeting = Boolean(meeting);
}
let inMeeting = false;

/** What the bar shows: the meeting, or out of one the space you're in. */
function sendBarState() {
  if (!barLoaded) return;
  const state = meeting
    ? { ...meeting, muteKey: muteKeyOn ? MUTE_SHORTCUT : null }
    : resting
      ? { rest: true, ...resting, pins: notePins.length, snapKey: SNAP_SHORTCUT.replace(/\+/g, " + "), noteKey: NOTE_SHORTCUT.replace(/\+/g, " + ") }
      : null;
  bar.webContents.send("bar:state", state);
}

// ---- the bar out of a meeting ----------------------------------------------------------

/** The space the bar holds out of a meeting, or null when there's none to show (signed out):
 *  {spaceId, space, live: {names} | null, todos, none}. It's the space snaps go to (snap.json's
 *  space): the one last picked on the bar, or last opened in Stand. */
let resting = null;
/** The spaces you're in, most recently active first, for the bar's space menu. */
let restSpaces = [];
let restAt = 0;
let restLoading = null;
let restQueued = null;

/** Reads the spaces, and the to-dos of the one the bar holds. Offline, the bar keeps what it
 *  shows. Asked again while it reads, it reads once more after. */
function refreshRest(why) {
  if (restLoading)
    return (restQueued ??= restLoading.then(() => {
      restQueued = null;
      return refreshRest(why);
    }));
  restLoading = (async () => {
    const res = await standFetch("/api/spaces", { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res) return;
    const list = res.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(list)) {
      // Signed out: nothing to hold, so no bar until you sign in.
      if (res.status === 401 || res.status === 403) {
        resting = null;
        restSpaces = [];
      }
      return;
    }
    restSpaces = list
      .map((s) => ({
        id: String(s.id),
        name: short(s.name) || "Untitled space",
        at: Number(s.activeAt) || 0,
        live: s.live && Array.isArray(s.live.people) && s.live.people.length ? { names: s.live.people.slice(0, 6).map((p) => short(p?.name)) } : null,
        // You're in its call: the meeting isn't in this app (it would be `meeting`), so a browser.
        call: s.live?.you ? { focus: short(s.live.focusTitle) || null } : null,
      }))
      .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s.id))
      .sort((a, b) => b.at - a.at);
    if (!restSpaces.length) {
      resting = { spaceId: null, space: null, live: null, todos: [], none: true };
      return;
    }
    const want = snapPrefs().space;
    // In a call in a browser, the bar is about that call, as it is about one in this app.
    const at = restSpaces.find((s) => s.call) ?? restSpaces.find((s) => s.id === want) ?? restSpaces[0];
    const room = await roomOf(at.id);
    // Picked another while this one loaded: that one's answer is the one to show.
    if (snapPrefs().space && snapPrefs().space !== want && !at.call) return;
    resting = { spaceId: at.id, space: at.name, live: at.live, call: at.call, todos: room ? openTodos(room) : (resting?.spaceId === at.id ? resting.todos : []) };
  })().finally(() => {
    restLoading = null;
    restAt = Date.now();
    trace("rest", { why, space: Boolean(resting?.spaceId), spaces: restSpaces.length, todos: resting?.todos.length ?? null });
    sendBarState();
    buildMenus();
    updateBar();
  });
  return restLoading;
}

/** A space as Stand's page gets it: its items and open to-dos among the rest. */
async function roomOf(spaceId) {
  const res = await standFetch(`/api/rooms/${encodeURIComponent(spaceId)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  return res?.ok ? await res.json().catch(() => null) : null;
}

/** A space's open to-dos for the bar's list: who has it and the item it's on. */
function openTodos(room) {
  const items = new Map((room.items ?? []).map((i) => [i.id, i]));
  const open = (Array.isArray(room.followUps) ? room.followUps : []).filter((n) => n && !n.doneAt);
  return todosOf(
    open.map((n) => {
      const item = items.get(n.itemId);
      return { id: n.id, text: n.text, owner: n.owner, itemKey: item ? short(item.externalId) || short(item.title).slice(0, 40) : null };
    }),
  );
}

/** Makes this the space the bar holds, and snaps go to. */
async function holdSpace(id, why) {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  const prefs = snapPrefs();
  if (prefs.space === id && resting?.spaceId === id) return;
  await savePrefs({ ...prefs, space: id });
  const s = restSpaces.find((x) => x.id === id);
  // Shown at once; its to-dos follow.
  if (s && resting) {
    resting = { ...resting, spaceId: s.id, space: s.name, live: s.live, none: false, todos: resting.spaceId === s.id ? resting.todos : [] };
    sendBarState();
  }
  await refreshRest(why);
}

/** The bar's space menu: every space you're in (those with people talking say so), then the
 *  ways into Stand. */
function spaceMenu() {
  const here = resting?.spaceId;
  const name = resting?.space;
  const template = [
    ...restSpaces.map((s) => ({
      label: s.live ? `${s.name}  ·  ${s.live.names.length} talking` : s.name,
      type: "radio",
      checked: s.id === here,
      click: () => void holdSpace(s.id, "picked"),
    })),
    ...(restSpaces.length ? [{ type: "separator" }] : []),
    ...(here ? [{ label: `Open ${name} in Stand`, click: () => goTo(`/s/${here}`) }] : []),
    { label: restSpaces.length ? "All Spaces" : "Make a Space in Stand", click: () => goTo("/") },
  ];
  // Under the space's pill (macOS moves it up when the bar is low on the screen).
  Menu.buildFromTemplate(template).popup({ window: bar ?? undefined, x: 45, y: 46 });
}

/** Opens a page of Stand in the main window: in place when Stand is already loaded there
 *  (nothing reloads), else by loading it. */
function goTo(p) {
  const loaded = win && !win.webContents.isLoading() && isStand(win.webContents.getURL());
  if (!loaded) return showWindow(p);
  showWindow();
  void win.webContents
    .executeJavaScript(`history.pushState(null, "", ${JSON.stringify(p)}); dispatchEvent(new PopStateEvent("popstate")); true`)
    .catch(() => showWindow(p));
}

/** The space a Stand page is on, from its address (/s/ and /r/ both open a space). */
function spaceInPage(url) {
  try {
    const u = new URL(url);
    if (u.origin !== STAND_ORIGIN) return null;
    return /^\/[sr]\/([A-Za-z0-9_-]{1,64})/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The space's open to-dos, as the meeting page lists them for the bar. */
const todosOf = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t.id === "string" && /^[a-z0-9]{4,40}$/.test(t.id))
    .slice(0, 60)
    .map((t) => ({ id: t.id, text: short(t.text), owner: short(t.owner) || null, itemKey: short(t.itemKey) || null }));

/** The bar's to-do list makes the window taller: down from the bar, or up when the bar is
 *  near the bottom of the screen. Returns whether it goes up; `ask` only says which, so the
 *  page can lay itself out first and the bar doesn't jump. 0 folds the list away. */
let barList = null;
let wasSharing = false;
let barResizing = false;
function sizeBar(extra, ask) {
  if (!bar) return false;
  // The list and the note card would hang from the same edge: the note steps aside, keeping what's written.
  if (extra && !ask && noteWin && !noteWin.isDestroyed()) noteWin.webContents.send("note:escape");
  const [x, y] = bar.getPosition();
  const top = barList?.up ? y + barList.h : y; // where the bar itself is
  const a = screen.getDisplayMatching({ x, y: top, ...BAR }).workArea;
  const up = Boolean(extra) && top + BAR.height + extra > a.y + a.height && top - extra >= a.y;
  if (ask) return up;
  barList = extra ? { up, h: extra } : null;
  barResizing = true;
  bar.setBounds({ x, y: up ? top - extra : top, width: BAR.width, height: BAR.height + (extra || 0) });
  setTimeout(() => (barResizing = false), 150);
  return up;
}

function closeBarList() {
  if (!barList) return;
  sizeBar(0);
  bar?.webContents.send("bar:close-list");
}

/** Puts one of the space's to-dos on the clipboard: the prompt Stand's Copy for agent
 *  makes (its words plus its Stand reference, for Claude Code, Cursor or Codex), or just its words. */
async function copyTodo(id, plain) {
  const todo = (meeting ?? resting)?.todos.find((t) => t.id === id);
  if (!todo) return false;
  let text = todo.text;
  if (!plain) {
    // Signed in as you, the way the page's own Copy for agent button asks.
    const res = await standFetch(`/api/refs/action/${encodeURIComponent(id)}/prompt`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const prompt = res?.ok ? (await res.json().catch(() => null))?.text : null;
    if (typeof prompt === "string" && prompt) text = prompt;
  }
  await clipboard.writeText(text);
  trace("copied", { plain: Boolean(plain), agent: text !== todo.text });
  return true;
}

/** The mute shortcut works from any app while there's a meeting, and is let go after.
 *  muteKeyOn is false if another app has it. */
let muteKeyWanted = false;
let muteKeyOn = false;
function muteKey(on) {
  if (on === muteKeyWanted) return;
  muteKeyWanted = on;
  if (on) muteKeyOn = globalShortcut.register(MUTE_SHORTCUT, () => win?.webContents.send("app:command", "mic"));
  else if (muteKeyOn) {
    globalShortcut.unregister(MUTE_SHORTCUT);
    muteKeyOn = false;
  }
}

/** The menu bar and the Dock menu, which follow the meeting (Mute or Unmute, say). */
let menuKey = "";
function buildMenus() {
  if (!mac) return;
  const key = JSON.stringify([Boolean(meeting), meeting?.micOn, barOff, muteKeyOn, Boolean(resting)]);
  if (key === menuKey) return;
  menuKey = key;
  const inMeeting = Boolean(meeting);
  const mic = { label: meeting?.micOn === false ? "Unmute" : "Mute", enabled: inMeeting, click: () => win?.webContents.send("app:command", "mic") };
  const snapItem = { label: "Snap…", click: () => void snap("menu").then(tell) };
  const noteItem = { label: "Note…", accelerator: NOTE_SHORTCUT, registerAccelerator: false, click: () => void openNote() };
  const history = () => win?.webContents.navigationHistory;
  const dev = app.isPackaged ? [] : [{ type: "separator" }, { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }];
  const template = [
    { role: "appMenu" },
    { label: "File", submenu: [{ role: "close" }] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Show Floating Bar",
          type: "checkbox",
          checked: !barOff,
          enabled: Boolean(meeting || resting),
          click: (item) => {
            barOff = item.checked ? null : "always";
            buildMenus();
            updateBar();
          },
        },
        { type: "separator" },
        // Off in a meeting: going back would leave the call without asking.
        { label: "Back", accelerator: "Command+[", enabled: !inMeeting, click: () => history()?.canGoBack() && history().goBack() },
        { label: "Forward", accelerator: "Command+]", enabled: !inMeeting, click: () => history()?.canGoForward() && history().goForward() },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...dev,
      ],
    },
    {
      label: "Meeting",
      submenu: [
        // Shown, not registered: the mute shortcut is global (it works in Stand too), else the page handles ⌘D.
        { ...mic, accelerator: muteKeyOn ? MUTE_SHORTCUT : "Command+D", registerAccelerator: false },
        { ...snapItem, accelerator: SNAP_SHORTCUT, registerAccelerator: false },
        noteItem,
        { type: "separator" },
        { label: "Meeting Shortcuts", accelerator: "Command+/", enabled: inMeeting, click: () => (showWindow(), win?.webContents.send("app:command", "shortcuts")) },
      ],
    },
    { role: "windowMenu" },
    // The help Stand has is the meeting's "How Stand works" sheet.
    {
      role: "help",
      submenu: [{ label: "How Stand Works", click: () => (inMeeting ? (showWindow(), win?.webContents.send("app:command", "shortcuts")) : void howStandWorks()) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.dock?.setMenu(Menu.buildFromTemplate([snapItem, noteItem, mic]));
}

/** Where the bar goes: where it was left, or the top middle of the screen Stand is on. */
function barPlace() {
  try {
    const { x, y } = JSON.parse(fs.readFileSync(barFile(), "utf8"));
    const fits = screen
      .getAllDisplays()
      .some(({ workArea: a }) => x >= a.x && y >= a.y && x + BAR.width <= a.x + a.width && y + BAR.height <= a.y + a.height);
    if (fits) return { x, y };
  } catch {}
  const a = (win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()).workArea;
  return { x: Math.round(a.x + (a.width - BAR.width) / 2), y: a.y + 8 };
}

function makeBar() {
  bar = new BrowserWindow({
    ...BAR,
    ...barPlace(),
    ...(mac ? { type: "panel" } : {}),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    acceptFirstMouse: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: `${__dirname}/bar-preload.js`, contextIsolation: true, sandbox: true },
  });
  bar.setAlwaysOnTop(true, "floating");
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // If this doesn't take, giveBack() undoes what a click on the bar does.
  barPrevents = staysInBackground(bar, "bar");
  bar.setContentProtection(true);
  bar.on("moved", () => {
    if (barResizing) return;
    const [x, y] = bar.getPosition();
    fs.promises.writeFile(barFile(), JSON.stringify({ x, y: barList?.up ? y + barList.h : y })).catch(() => {});
    // The note card goes where the bar goes. Tied to it on the Mac, it's there already and this
    // changes nothing, unless it has to change sides.
    placeNote();
    // Dragging the bar is a click on it too. On the Mac this fires all through the drag.
    clearTimeout(dragged);
    dragged = setTimeout(() => void giveBack("drag"), 300);
  });
  // So the log says when the bar went away and whether Stand did it (bar-down) or macOS.
  bar.on("hide", () => trace("bar-hidden", { meeting: Boolean(meeting), barAway, appHidden: mac && !win?.isVisible() }));
  bar.on("show", () => trace("bar-shown", {}));
  bar.on("closed", () => {
    untieNote();
    bar = null;
    barLoaded = false;
    barList = null;
  });
  bar.webContents.once("did-finish-load", () => {
    barLoaded = true;
    sendBarState();
    updateBar();
  });
  void bar.loadFile(`${__dirname}/bar.html`);
}

/** Clicks on this window leave Stand in the background, the app the person is in stays in
 *  front. Electron's panels don't fully opt out of macOS making the clicked app active;
 *  native/stand-native.mm does. */
function staysInBackground(w, name) {
  if (!mac) return false;
  let prevents = false;
  try {
    prevents = Boolean(native()?.preventActivation(w.getNativeWindowHandle()));
  } catch (err) {
    trace("native", { error: String(err?.message || err) });
  }
  trace("window", { name, prevents });
  return prevents;
}

/** Stand's native Mac code (native/stand-native.mm), when scripts/build-native.js built it. */
let nativeCode;
function native() {
  if (nativeCode === undefined) {
    try {
      nativeCode = require("./native/stand-native.node");
    } catch (err) {
      nativeCode = null;
      trace("native", { error: String(err?.message || err).split("\n")[0] });
    }
  }
  return nativeCode;
}

/** Up whenever the app runs and you're signed in, Stand in front or not (joe's call): the
 *  meeting's bar in one, the space's out of one. Down while a snap reads the screen. */
function updateBar() {
  if (barHold) return;
  const want = Boolean((meeting ? win : resting) && !barAway && !barOff);
  if (want && !bar) makeBar();
  if (!barLoaded) return;
  if (want && !bar.isVisible()) {
    trace("bar-up", {});
    // Shown see-through until the page has drawn its first frame of arriving, so macOS
    // can't flash the bar as it was when it went away.
    bar.setOpacity(0);
    barRevealed = false;
    bar.showInactive();
    clearTimeout(barReveal);
    barReveal = setTimeout(revealBar, 300);
    // It catches the eye once, when a meeting starts: not when it's back after a snap.
    const pulse = Boolean(meeting) && !barSnapped && meeting.roomId !== pulsedFor;
    if (pulse) pulsedFor = meeting.roomId;
    bar.webContents.send("bar:shown", { pulse });
    barSnapped = false;
    tieNote();
    void noteTheirApp();
  } else if (!want && bar.isVisible()) {
    trace("bar-down", { meeting: Boolean(meeting), barAway });
    closeBarList();
    hideBar();
  }
}
let barReveal;
let barRevealed = false;
/** The bar's page has drawn itself, still see-through: show the window, then let it arrive,
 *  so the whole arrival is seen. */
function revealBar() {
  clearTimeout(barReveal);
  if (!bar || bar.isDestroyed() || barRevealed) return;
  barRevealed = true;
  bar.setOpacity(1);
  bar.webContents.send("bar:visible");
}
/** The meeting whose bar has had its glow. */
let pulsedFor = null;
function hideBar() {
  untieNote();
  bar.setOpacity(0);
  bar.hide();
  // The pointer can't be on a bar that's gone, and no "leave" will come to say so.
  barPointer = false;
}

async function pressOnBar(button) {
  if (button === "hover" || button === "leave") barPointer = button === "hover";
  if (button === "hover") {
    // A press on the bar can make Stand the active app, and macOS then brings up Stand's
    // window to take the keyboard. While the pointer is on the bar, that window can't.
    if (mac && !barPrevents && win && !win.isFocused()) win.setFocusable(false);
    // Out of a meeting, what it shows is brought up to date as you reach for it.
    if (!meeting && Date.now() - restAt > 20_000) void refreshRest("hover");
    return void noteTheirApp();
  }
  if (button === "leave") return void (mac && !barHold && win?.setFocusable(true));
  if (button === "settings") return openSettings("screen");
  if (button === "menu")
    return Menu.buildFromTemplate([
      { label: "Open Stand", click: () => showWindow() },
      { type: "separator" },
      {
        label: meeting ? "Hide Until the Meeting Ends" : "Hide the Bar",
        click: () => {
          barOff = meeting ? "meeting" : "always";
          buildMenus();
          updateBar();
          if (barOff === "always") notify("The bar is hidden", "Bring it back from Stand's View menu: Show Floating Bar.");
        },
      },
    ]).popup({ window: bar ?? undefined });
  if (button === "note") return void openNote();
  // Out of a meeting: the space menu, or straight into talking there. Both are meant to bring Stand up.
  if (button === "spaces") return void (resting?.none ? goTo("/") : spaceMenu());
  if (button === "talk") return void (resting?.spaceId && goTo(`/s/${resting.spaceId}?join`));
  trace("bar", { button, theirApp: theirApp?.name });
  if (button === "open") return showWindow();
  if (button === "mic" || button === "switch" || button === "undo") win?.webContents.send("app:command", button);
  // Without the native code, the press made Stand the active app; keep the bar up while that's undone.
  if (!barPrevents) {
    barHold = true;
    try {
      await giveBack(button);
    } finally {
      barHold = false;
      if (mac) win?.setFocusable(true);
    }
  }
  if (button === "snap") tell(await snap("bar"));
  else updateBar();
}

/** The app the person is in while the bar is up: noted when the bar appears and when the
 *  pointer reaches it, before any click. */
let theirApp = null;
async function noteTheirApp() {
  const front = await frontInfo();
  if (front?.pid && front.pid !== process.pid) theirApp = front;
}

/** While a click on the bar is being undone, the bar stays put rather than blinking off. */
let barHold = false;
/** The pointer is on the bar. */
let barPointer = false;
/** Clicks on the bar leave Stand in the background (staysInBackground), so there's nothing to undo. */
let barPrevents = false;
/** The bar went down for a snap, so it comes back up quietly. */
let barSnapped = false;
let dragged;

/** macOS makes an app active when one of its windows is clicked, and Electron's panels
 *  don't fully opt out of that: without the native code (see makeBar), a click on the bar
 *  makes Stand the active app and brings its window up over the app the person is in.
 *  Bring that app back to the front. */
async function giveBack(why) {
  if (!mac || !theirApp) return;
  const front = await frontInfo();
  if (!front || front.pid !== process.pid) return trace("giveback", { why, needed: false, front: front?.name });
  const them = theirApp;
  const t0 = Date.now();
  const held = barHold;
  barHold = true;
  try {
    // Launch Services brings it forward the way the Dock does, then macOS takes a moment to
    // switch. Not Finder: with no Finder window open, that would open one.
    let now = front;
    if (them.bundleId && them.bundleId !== "com.apple.finder") {
      await run("open", ["-b", them.bundleId]).catch(() => {});
      for (let i = 0; i < 25 && now?.pid === process.pid; i++) {
        await new Promise((r) => setTimeout(r, 30));
        now = await frontInfo();
      }
    }
    // Still Stand: hiding it hands macOS's focus back to the app that was in front before.
    const hid = now?.pid === process.pid;
    if (hid) {
      app.hide();
      await new Promise((r) => setTimeout(r, 150));
    }
    trace("giveback", { why, needed: true, to: them.name, front: now?.name, hid, ms: Date.now() - t0 });
  } finally {
    barHold = held;
    if (!held) updateBar();
  }
}

// ---- start ----------------------------------------------------------------------

app.on("web-contents-created", (_e, wc) => {
  if (wc.session === session.fromPartition(PARTITION)) keepOnStand(wc);
  else wc.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(async () => {
  if (replacing) primary = await replacing;
  if (!primary) return app.quit();
  allowMediaAndSharing(session.fromPartition(PARTITION));
  // A built Stand.app has its icon in the bundle. Run from source (npm start, npm run
  // try:mac) the Dock would show Electron's, so give it Stand's.
  if (mac && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, "build", "icon.png"));
  showWindow();
  // The Snap button on Stand's meeting page.
  ipcMain.handle("app:snap", (e) => (isStand(e.senderFrame?.url) ? snap("page") : null));
  // The meeting page, and the floating bar's buttons.
  ipcMain.on("app:meeting", (e, m) => e.sender === win?.webContents && isStand(e.senderFrame?.url) && setMeeting(m));
  // How loud your mic is, for the bar's ring. Only a number, and only while the bar is up.
  ipcMain.on("app:level", (e, v) => {
    if (e.sender !== win?.webContents || !bar?.isVisible() || typeof v !== "number") return;
    bar.webContents.send("bar:level", Math.max(0, Math.min(1, v)));
  });
  ipcMain.on("bar:press", (e, button) => e.sender === bar?.webContents && void pressOnBar(button));
  ipcMain.on("bar:painted", (e) => e.sender === bar?.webContents && revealBar());
  ipcMain.handle(
    "bar:size",
    (e, extra, ask) => e.sender === bar?.webContents && sizeBar(Math.max(0, Math.min(600, Math.round(Number(extra) || 0))), Boolean(ask)),
  );
  ipcMain.handle("bar:copy", (e, id, plain) => e.sender === bar?.webContents && copyTodo(String(id), Boolean(plain)));
  // The note card's mic: the Mac's dictation, started into its text field.
  ipcMain.handle("note:dictate", (e) => e.sender === noteWin?.webContents && Boolean(native()?.startDictation?.()));
  // The page's way to the right page of System Settings (a blocked mic, say).
  ipcMain.on("app:settings", (e, which) => isStand(e.senderFrame?.url) && openSettings(which));
  buildMenus();
  // The bar comes up as soon as Stand says who you are, and keeps the space current. Signing
  // in or out (the session cookie changing) brings it up or takes it down.
  void refreshRest("start");
  let signedInOrOut;
  session.fromPartition(PARTITION).cookies.on("changed", (_e, cookie) => {
    if (cookie.name !== SESSION_COOKIE) return;
    clearTimeout(signedInOrOut);
    signedInOrOut = setTimeout(() => void refreshRest("session"), 300);
  });
  // Often enough to notice a call joined in a browser.
  setInterval(() => !meeting && void refreshRest("tick"), 15_000);
  nativeTheme.on("updated", () => win?.setBackgroundColor(backdrop()));
  // Focus moving between apps: a blur comes just before the next focus, so look once both have landed.
  for (const change of ["browser-window-focus", "browser-window-blur"]) app.on(change, () => setTimeout(updateBar, 50));
  if (!globalShortcut.register(SNAP_SHORTCUT, () => void snap("shortcut").then(tell)))
    notify("Snap shortcut is taken", `Another app already uses ${SNAP_SHORTCUT}, so Snap from anywhere is off.`);
  // Again while the card has the keyboard: it's put away, what's written kept.
  const noteKey = () => (noteWin && !noteWin.isDestroyed() && noteWin.isFocused() ? noteWin.webContents.send("note:escape") : void openNote());
  if (!globalShortcut.register(NOTE_SHORTCUT, noteKey))
    notify("Note shortcut is taken", `Another app already uses ${NOTE_SHORTCUT}; the bar's note field still works.`);
  app.on("activate", () => showWindow());
  // ⌘Tab back to Stand while the window is put away in a call: bring it back, as the Dock does.
  // Not for a click on the bar or a snap, which can make Stand active for a moment.
  app.on("did-become-active", () => {
    if (meeting && win && !win.isVisible() && !barPointer && !barHold && !picking) showWindow();
  });
});
// Quitting in a meeting leaves the call, so it asks first.
app.on("before-quit", (e) => {
  if (quitting || !meeting) return void (quitting = true);
  const choice = dialog.showMessageBoxSync(win?.isVisible() ? win : undefined, {
    type: "question",
    message: "Leave the meeting and quit Stand?",
    detail: `You're in a meeting in ${meeting.space}.`,
    buttons: ["Quit", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 1) return e.preventDefault();
  quitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (!mac) app.quit();
});
