// Stand for Mac. One window on the live Stand app, sign-in through the browser
// (Google won't sign people in inside an app's own window), and Snap from
// anywhere: a global shortcut puts a crosshair over the screen, and the region
// lands in the meeting you're in, pinned to whatever is in focus.

const { app, BrowserWindow, Notification, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } = require("electron");
const crypto = require("node:crypto");

const STAND_URL = (process.env.STAND_URL || "https://stand-production-3d3f.up.railway.app").replace(/\/$/, "");
const STAND_ORIGIN = new URL(STAND_URL).origin;
/** ⌃⇧S: ⌘⇧S is Save As in most apps, and a global shortcut would take it from them. */
const SNAP_SHORTCUT = process.env.STAND_SNAP_SHORTCUT || "Control+Shift+S";
const PARTITION = "persist:stand";
const mac = process.platform === "darwin";

let win = null;
/** The browser sign-in in flight: the PKCE secret, and the page to land on. */
let signingIn = null;
/** The crosshair, while it's up. */
let picking = null;

// ---- one instance, and stand:// links -----------------------------------------

if (!app.requestSingleInstanceLock()) app.quit();
app.setAsDefaultProtocolClient("stand");
app.on("open-url", (e, url) => {
  e.preventDefault();
  void app.whenReady().then(() => handleLink(url));
});
app.on("second-instance", (_e, argv) => {
  const link = argv.find((a) => a.startsWith("stand://"));
  if (link) void handleLink(link);
  else showWindow();
});

async function handleLink(link) {
  const url = new URL(link);
  if (url.hostname === "signed-in") await finishSignIn(url.searchParams.get("code"));
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
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
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
    if (new URL(url).origin === STAND_ORIGIN) return { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800 } };
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

async function startSignIn(next) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  signingIn = { verifier, next: next && next.startsWith("/") && !next.startsWith("//") ? next : "/" };
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  await shell.openExternal(`${STAND_URL}/api/auth/desktop?challenge=${challenge}`);
}

async function finishSignIn(code) {
  const pending = signingIn;
  signingIn = null;
  if (!code || !pending) return showWindow();
  const res = await fetch(`${STAND_URL}/api/auth/desktop/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier: pending.verifier }),
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
  showWindow(pending.next);
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

/** The space the main window is in, if any. */
function spaceId() {
  if (!win) return null;
  const m = /^\/s\/([A-Za-z0-9_-]+)/.exec(new URL(win.webContents.getURL()).pathname);
  return m ? m[1] : null;
}

async function snap() {
  if (picking) return picking.cancel();
  const roomId = spaceId();
  if (!roomId) return notify("Join a meeting to snap", "Snaps land on whatever the meeting is discussing.");
  const at = Date.now();
  const wasInStand = BrowserWindow.getFocusedWindow() != null;
  try {
    // Freeze the display under the pointer at full resolution, then pick a region of it.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty())
      return notify(
        "Stand can't see your screen",
        "Allow Stand in System Settings › Privacy & Security › Screen Recording, then reopen it.",
      );
    const region = await pickRegion(display, source.thumbnail);
    // Hand the screen back to whatever the person was in.
    if (mac && !wasInStand) app.hide();
    if (!region) return;
    const image = region.full ? source.thumbnail : source.thumbnail.crop(region);
    const { width: w, height: h } = image.getSize();
    const res = await session.fromPartition(PARTITION).fetch(`${STAND_URL}/api/rooms/${roomId}/snaps?at=${at}&w=${w}&h=${h}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: image.toJPEG(90),
      credentials: "include",
    });
    if (!res.ok) return notify("Snap didn't save", (await res.json().catch(() => null))?.error ?? `Stand said ${res.status}.`);
    notify("Snapped", "It's on the item the meeting is discussing. Crop or delete it in Stand.");
  } catch (err) {
    notify("Snap didn't save", String(err?.message ?? err));
  }
}

/** A window over one display showing the frozen screen: drag a box, click for
 *  the whole screen, Esc (or the shortcut again) to cancel. Resolves in image pixels. */
function pickRegion(display, image) {
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

    const finish = (r) => {
      if (!picking) return;
      picking = null;
      ipcMain.removeListener("snap:region", onRegion);
      globalShortcut.unregister("Escape");
      if (!overlay.isDestroyed()) overlay.close();
      resolve(r);
    };
    const onRegion = (e, r) => {
      if (e.sender !== overlay.webContents) return;
      if (!r) return finish(null);
      if (r.full) return finish({ full: true });
      const s = image.getSize().width / display.bounds.width;
      finish({
        x: Math.round(r.x * s),
        y: Math.round(r.y * s),
        width: Math.max(1, Math.round(r.w * s)),
        height: Math.max(1, Math.round(r.h * s)),
      });
    };
    picking = { cancel: () => finish(null) };
    ipcMain.on("snap:region", onRegion);
    // Esc works even if the crosshair didn't get keyboard focus.
    globalShortcut.register("Escape", () => finish(null));
    overlay.on("closed", () => finish(null));
    overlay.webContents.once("did-finish-load", () => overlay.webContents.send("snap:image", image.toDataURL()));
    ipcMain.once("snap:ready", () => {
      if (overlay.isDestroyed()) return;
      if (mac) app.focus({ steal: true });
      overlay.show();
      overlay.focus();
    });
    void overlay.loadFile(`${__dirname}/snap.html`);
  });
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// ---- start ----------------------------------------------------------------------

app.on("web-contents-created", (_e, wc) => {
  if (wc.session === session.fromPartition(PARTITION)) keepOnStand(wc);
  else wc.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.whenReady().then(() => {
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
