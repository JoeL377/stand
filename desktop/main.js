// Stand for Mac. One window on the live Stand app, sign-in through the browser
// (Google won't sign people in inside an app's own window), and Snap from
// anywhere: a global shortcut opens a capture toolbar like macOS's ⌘⇧5, and the
// snap lands in the meeting you're in, pinned to whatever is in focus, and on the clipboard.

const { app, BrowserWindow, ClipboardItem, Notification, clipboard, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = require("electron");
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

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => showWindow());

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
      webPreferences: { partition: PARTITION, preload: mac ? `${__dirname}/preload.js` : undefined, contextIsolation: true, sandbox: true },
    });
    win.on("closed", () => (win = null));
    if (!path) void win.loadURL(STAND_URL);
  }
  if (path) void win.loadURL(`${STAND_URL}${path}`);
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

function allowMediaAndSharing(ses) {
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-sanitized-write", "fullscreen"]);
  const fromStand = (url) => {
    try {
      return new URL(url).origin === STAND_ORIGIN;
    } catch {
      return false;
    }
  };
  ses.setPermissionRequestHandler((wc, permission, done, details) =>
    done(allowed.has(permission) && fromStand(details.requestingUrl || wc.getURL())),
  );
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && fromStand(origin));
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

async function snap() {
  if (picking) return picking.cancel();
  const me = { cancelled: false, cancel: () => (me.cancelled = true) };
  picking = me;
  const wasInStand = BrowserWindow.getFocusedWindow() != null;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const [still, windows] = await Promise.all([grabDisplay(display), windowsOn(display)]);
    if (me.cancelled) return;
    if (!still) return cantSee();
    const at = Date.now();
    const roomId = spaceId();
    const choice = await openToolbar(me, display, still, windows, { prefs: snapPrefs(), inMeeting: Boolean(roomId) });
    if (choice?.prefs) fs.promises.writeFile(prefsFile(), JSON.stringify(cleanPrefs(choice.prefs))).catch(() => {});
    // Hand the screen back to whatever the person was in.
    if (mac && !wasInStand) app.hide();
    if (!choice || choice.cancel) return;
    const prefs = cleanPrefs(choice.prefs);
    let shot = still;
    let shotAt = at;
    if (prefs.timer) {
      // The timer is for setting the screen up (opening a menu, say), so it snaps the screen as it is then.
      if (!(await countdown(me, display, prefs.timer))) return;
      shot = await grabDisplay(display);
      shotAt = Date.now();
      if (!shot) return cantSee();
    }
    const image = await cut(choice, display, shot, windows);
    await deliver(image, shotAt, prefs, roomId);
  } catch (err) {
    notify("Snap didn't work", String(err?.message ?? err));
  } finally {
    if (picking === me) picking = null;
  }
}

const cantSee = () =>
  notify("Stand can't see your screen", "Allow Stand in System Settings › Privacy & Security › Screen Recording, then reopen it.");

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

/** On the Mac, from CoreGraphics through osascript: no extra permission, and the
 *  window ids match desktopCapturer's. Elsewhere (trying the app on Linux), xdotool if it's there. */
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
  if (mac) return JSON.parse(await run("osascript", ["-l", "JavaScript", "-e", WINDOWS_JXA]));
  if (process.platform !== "linux") return [];
  // xdotool lists top-level windows bottom to top.
  const ids = (await run("xdotool", ["search", "--onlyvisible", "--name", "."])).split("\n").filter(Boolean).reverse();
  const geo = await Promise.all(ids.map((id) => run("xdotool", ["getwindowgeometry", "--shell", id]).catch(() => "")));
  return geo
    .map((g, i) => {
      const v = Object.fromEntries(g.split("\n").map((l) => l.split("=")));
      return { id: Number(ids[i]), app: "", x: Number(v.X), y: Number(v.Y), w: Number(v.WIDTH), h: Number(v.HEIGHT) };
    })
    .filter((w) => Number.isFinite(w.w));
}

/** The toolbar over a still of one display. Resolves to what to snap, or a cancel
 *  (with the settings to keep), or null if it closed some other way. */
function openToolbar(me, display, still, windows, { prefs, inMeeting }) {
  return new Promise((resolve) => {
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
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.setBounds(display.bounds);

    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      ipcMain.removeListener("snap:done", onDone);
      ipcMain.removeListener("snap:ready", onReady);
      globalShortcut.unregister("Escape");
      if (!overlay.isDestroyed()) overlay.close();
      resolve(choice);
    };
    const onDone = (e, choice) => e.sender === overlay.webContents && finish(choice);
    const onReady = (e) => {
      if (e.sender !== overlay.webContents || overlay.isDestroyed()) return;
      if (mac) app.focus({ steal: true });
      overlay.show();
      overlay.focus();
    };
    me.cancel = () => finish(null);
    ipcMain.on("snap:done", onDone);
    ipcMain.on("snap:ready", onReady);
    // Esc works even if the toolbar didn't get keyboard focus.
    globalShortcut.register("Escape", () => finish(null));
    overlay.on("closed", () => finish(null));
    const b = display.bounds;
    overlay.webContents.once("did-finish-load", () =>
      overlay.webContents.send("snap:open", {
        image: `data:image/jpeg;base64,${still.toJPEG(90).toString("base64")}`,
        windows: windows.map((w) => ({ id: w.id, x: w.x - b.x, y: w.y - b.y, w: w.w, h: w.h })),
        prefs,
        inMeeting,
      }),
    );
    void overlay.loadFile(`${__dirname}/snap.html`);
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
    tick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  if (!toMeeting) return notify("Snapped", "It's on your clipboard.");
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
    return notify(copy ? "Copied, but not added to the meeting" : "Snap didn't save", why);
  }
  notify("Snapped", copy ? "It's on your clipboard and in the meeting, on the item in focus." : "It's in the meeting, on the item in focus. Crop or delete it in Stand.");
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// ---- start ----------------------------------------------------------------------

if (mac) app.on("browser-window-created", (_e, w) => w.setWindowButtonVisibility(false));

app.on("web-contents-created", (_e, wc) => {
  if (wc.session === session.fromPartition(PARTITION)) keepOnStand(wc);
  else wc.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(() => {
  if (!primary) return;
  allowMediaAndSharing(session.fromPartition(PARTITION));
  showWindow();
  if (!globalShortcut.register(SNAP_SHORTCUT, () => void snap()))
    notify("Snap shortcut is taken", `Another app already uses ${SNAP_SHORTCUT}, so Snap from anywhere is off.`);
  app.on("activate", () => showWindow());
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (!mac) app.quit();
});
