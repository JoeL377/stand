// Stand for Mac. One window on the live Stand app, sign-in through the browser
// (Google won't sign people in inside an app's own window), and Snap from
// anywhere: a global shortcut opens a capture toolbar like macOS's ⌘⇧5, and the
// snap lands in the meeting you're in, pinned to whatever is in focus, and on the clipboard.
// In a meeting, a small floating bar keeps Snap and the mic one click away from any app.

const {
  app,
  BrowserWindow,
  ClipboardItem,
  Notification,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
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
const PARTITION = "persist:stand";
const mac = process.platform === "darwin";
/** No title bar and no window buttons on the Mac: Stand runs edge to edge, the logo
 *  sits in the corner, and ⌘W, ⌘M and ⌃⌘F close, minimize and go full screen. */
/** @type {Electron.BrowserWindowConstructorOptions} */
const chrome = mac ? { titleBarStyle: "hidden" } : {};

let win = null;
/** The browser sign-in in flight, if any. */
let signingIn = null;

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

function showWindow(path) {
  if (!win) {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "Stand",
      backgroundColor: "#191919",
      ...chrome,
      webPreferences: { partition: PARTITION, preload: `${__dirname}/preload.js`, contextIsolation: true, sandbox: true },
    });
    win.on("closed", () => {
      win = null;
      meeting = null;
      // The bar is a window too: gone with the main one, so closing it still quits off the Mac.
      bar?.destroy();
    });
    // A reload or a crash leaves the meeting page; it says so again when it's back.
    win.webContents.on("did-navigate", () => setMeeting(null));
    win.webContents.on("render-process-gone", () => setMeeting(null));
    if (!path) void win.loadURL(STAND_URL);
  }
  if (path) void win.loadURL(`${STAND_URL}${path}`);
  // The floating bar makes the window unfocusable while the pointer is on it.
  if (mac) win.setFocusable(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
    if (new URL(url).origin === STAND_ORIGIN)
      return { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800, ...chrome } };
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
  ses.setDisplayMediaRequestHandler(
    async (_req, done) => {
      const [first] = await desktopCapturer.getSources({ types: ["screen"] });
      done(first ? { video: first } : {});
    },
    { useSystemPicker: true },
  );
}

// ---- Snap from anywhere ---------------------------------------------------------
// ⌃⇧S puts a capture toolbar like macOS's ⌘⇧5 over the display under the pointer:
// the entire screen, one window, or a box you move and resize (it's where you left
// it last time). The snap goes to the meeting you're in, on whatever is in focus,
// and to the clipboard; Options turns either off and sets a 5 or 10 second timer.

/** What the toolbar remembers between snaps. */
const SNAP_DEFAULTS = { mode: "portion", toMeeting: true, toClipboard: true, timer: 0, box: null };
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
  };
}

/** The space the main window is in, if any. */
function spaceId() {
  if (!win) return null;
  const m = /^\/s\/([A-Za-z0-9_-]+)/.exec(new URL(win.webContents.getURL()).pathname);
  return m ? m[1] : null;
}

/** The toolbar or the timer, while either is up: the shortcut again closes it. */
let picking = null;

/** Snaps, and resolves to what to tell the person ({ title, body }), or nothing when they
 *  cancelled. The shortcut shows it as a notification; the page's Snap button shows it in
 *  the page, where it can't be missed. */
async function snap(from) {
  // Pressed again while the screen is still being read (macOS asking for permission, say):
  // give up on this one and free the shortcut, so it can never get stuck.
  if (picking) {
    trace("cancel");
    return picking.cancel();
  }
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
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // What doesn't need the bar out of the way starts now, so the toolbar can show as soon as
  // the screen is read: the toolbar's window (hidden until then), the window list, the app in front.
  const windows = within(windowsOn(display), 8000).then((w) => {
    trace("windows", { count: w?.length ?? null, ms: Date.now() - t0 });
    return w ?? [];
  });
  const asked = frontInfo();
  const overlay = makeToolbar(display);
  // The bar is up when Stand is in the background, which is when people snap: keep it out of
  // the picture. macOS takes it off the screen within a frame or two.
  barAway = true;
  if (bar?.isVisible()) {
    closeBarList();
    bar.hide();
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
    void asked.then((front) => {
      // Snapped from another app: that's the app to hand the screen back to afterwards.
      if (!wasInStand && front?.pid && front.pid !== process.pid) theirApp = front;
      trace("front", { front: front?.name });
    });
    const choice = await openToolbar(me, overlay, display, still, windows, { prefs: snapPrefs(), inMeeting: Boolean(roomId), t0 });
    trace("toolbar", { choice: choice && (choice.failed ?? (choice.cancel ? "cancel" : choice.mode)) });
    if (choice?.failed) return { title: "Snap's toolbar didn't open", body: choice.failed };
    if (choice?.prefs) fs.promises.writeFile(prefsFile(), JSON.stringify(cleanPrefs(choice.prefs))).catch(() => {});
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
    return await deliver(image, shotAt, prefs, roomId);
  } catch (err) {
    trace("error", { error: String(err?.stack ?? err), permission: screenStatus() });
    // Without the permission, reading the screen can fail outright instead of coming back blank.
    if (mac && screenStatus() !== "granted") return cantSee();
    return { title: "Snap didn't work", body: String(err?.message ?? err) };
  } finally {
    if (!overlay.isDestroyed()) overlay.close();
    if (picking === me) picking = null;
    barAway = false;
    updateBar();
  }
}

/** Shows what snap() came back with: on the floating bar when it's up, else as a notification. */
function tell(report) {
  if (!report) return;
  if (bar?.isVisible()) bar.webContents.send("bar:report", report);
  else notify(report.title, report.body);
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

/** Opens the right page of System Settings, and says what's missing. Run from source,
 *  macOS asks on behalf of the terminal app it was started from, not Stand. */
function cantSee() {
  if (mac) void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  return {
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
function openToolbar(me, overlay, display, still, windows, { prefs, inMeeting, t0 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      clearTimeout(slow);
      ipcMain.removeListener("snap:done", onDone);
      ipcMain.removeListener("snap:ready", onReady);
      globalShortcut.unregister("Escape");
      if (!overlay.isDestroyed()) overlay.close();
      resolve(choice);
    };
    const onDone = (e, choice) => e.sender === overlay.webContents && finish(choice);
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
    // Esc works even if the toolbar didn't get keyboard focus.
    globalShortcut.register("Escape", () => finish(null));
    overlay.on("closed", () => finish(null));
    const b = display.bounds;
    const t1 = Date.now();
    const image = `data:image/jpeg;base64,${still.toJPEG(90).toString("base64")}`;
    const jpegMs = Date.now() - t1;
    const open = () => !done && !overlay.isDestroyed();
    void overlay.loaded.then((failed) => {
      if (failed) return finish({ failed });
      if (!open()) return;
      overlay.webContents.send("snap:open", { image, windows: [], prefs, inMeeting });
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
      `data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1f1f21;color:#fff;font:14px -apple-system,system-ui;user-select:none">Snapping in ${n}…</body>`)}`;
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
      if (!tick.isDestroyed()) void tick.loadURL(page(left));
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

/** To the clipboard and the meeting, as the options say. Out of a meeting it's copied. */
async function deliver(image, at, prefs, roomId) {
  const toMeeting = Boolean(roomId) && prefs.toMeeting;
  const copy = prefs.toClipboard || !toMeeting;
  if (copy) await clipboard.write([new ClipboardItem({ "image/png": new Blob([image.toPNG()], { type: "image/png" }) })]);
  if (!toMeeting) return { title: "Snapped", body: "It's on your clipboard." };
  const { width: w, height: h } = image.getSize();
  const res = await session
    .fromPartition(PARTITION)
    .fetch(`${STAND_URL}/api/rooms/${roomId}/snaps?at=${at}&w=${w}&h=${h}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: image.toJPEG(90),
      credentials: "include",
    })
    .catch(() => null);
  if (!res?.ok) {
    const why = (await res?.json().catch(() => null))?.error ?? (res ? `Stand said ${res.status}.` : "Stand didn't answer.");
    return { title: copy ? "Copied, but not added to the meeting" : "Snap didn't save", body: why };
  }
  return {
    title: "Snapped",
    body: copy ? "It's on your clipboard and in the meeting, on the item in focus." : "It's in the meeting, on the item in focus. Crop or delete it in Stand.",
    snapId: (await res.json().catch(() => null))?.id,
  };
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// ---- the floating bar -------------------------------------------------------------
//
// In a meeting, when no Stand window is in front (you're presenting a web page, say),
// a small bar floats over every app and Space: what's in focus, your mic, and Snap. It
// never takes focus from the app you're in, stays out of snaps (and, where macOS allows,
// out of screen sharing), and goes wherever you drag it, which it remembers.

/** The meeting the main window is in, as its page last described it, or null. */
let meeting = null;
let bar = null;
let barLoaded = false;
/** True while a snap reads the screen. */
let barAway = false;
const BAR = { width: 380, height: 48 };
const barFile = () => path.join(app.getPath("userData"), "bar.json");
const short = (v) => (typeof v === "string" ? v.slice(0, 200) : "");

function setMeeting(m) {
  meeting =
    m && typeof m === "object"
      ? { space: short(m.space), itemKey: short(m.itemKey) || null, item: short(m.item) || null, micOn: m.micOn !== false, todos: todosOf(m.todos) }
      : null;
  if (meeting && barLoaded) bar.webContents.send("bar:state", meeting);
  updateBar();
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
let barResizing = false;
function sizeBar(extra, ask) {
  if (!bar) return false;
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
  const todo = meeting?.todos.find((t) => t.id === id);
  if (!todo) return false;
  let text = todo.text;
  if (!plain && win) {
    // Fetched by the page, signed in as you, the way its own Copy for agent button does.
    const prompt = await win.webContents
      .executeJavaScript(`fetch("/api/refs/action/${id}/prompt").then((r) => (r.ok ? r.json() : null)).then((j) => j && j.text, () => null)`)
      .catch(() => null);
    if (typeof prompt === "string" && prompt) text = prompt;
  }
  await clipboard.writeText(text);
  trace("copied", { plain: Boolean(plain), agent: text !== todo.text });
  return true;
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
    // Dragging the bar is a click on it too. On the Mac this fires all through the drag.
    clearTimeout(dragged);
    dragged = setTimeout(() => void giveBack("drag"), 300);
  });
  bar.on("closed", () => {
    bar = null;
    barLoaded = false;
    barList = null;
  });
  bar.webContents.once("did-finish-load", () => {
    barLoaded = true;
    setMeeting(meeting);
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

/** Up for the whole meeting, Stand in front or not (joe's call); down while a snap reads the screen. */
function updateBar() {
  if (barHold) return;
  const want = Boolean(meeting && win && !barAway);
  if (want && !bar) makeBar();
  if (!barLoaded) return;
  if (want && !bar.isVisible()) {
    bar.showInactive();
    // It catches the eye when a meeting starts, not when it's back after a snap.
    bar.webContents.send("bar:shown", { pulse: !barSnapped });
    barSnapped = false;
    void noteTheirApp();
  } else if (!want && bar.isVisible()) {
    closeBarList();
    bar.hide();
  }
}

async function pressOnBar(button) {
  if (button === "hover") {
    // A press on the bar can make Stand the active app, and macOS then brings up Stand's
    // window to take the keyboard. While the pointer is on the bar, that window can't.
    if (mac && !barPrevents && win && !win.isFocused()) win.setFocusable(false);
    return void noteTheirApp();
  }
  if (button === "leave") return void (mac && !barHold && win?.setFocusable(true));
  trace("bar", { button, theirApp: theirApp?.name });
  if (button === "open") return showWindow();
  if (button === "mic") win?.webContents.send("app:command", "mic");
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

if (mac) app.on("browser-window-created", (_e, w) => w.setWindowButtonVisibility(false));

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
  ipcMain.handle(
    "bar:size",
    (e, extra, ask) => e.sender === bar?.webContents && sizeBar(Math.max(0, Math.min(600, Math.round(Number(extra) || 0))), Boolean(ask)),
  );
  ipcMain.handle("bar:copy", (e, id, plain) => e.sender === bar?.webContents && copyTodo(String(id), Boolean(plain)));
  // Focus moving between apps: a blur comes just before the next focus, so look once both have landed.
  for (const change of ["browser-window-focus", "browser-window-blur"]) app.on(change, () => setTimeout(updateBar, 50));
  if (!globalShortcut.register(SNAP_SHORTCUT, () => void snap("shortcut").then(tell)))
    notify("Snap shortcut is taken", `Another app already uses ${SNAP_SHORTCUT}, so Snap from anywhere is off.`);
  app.on("activate", () => showWindow());
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (!mac) app.quit();
});
