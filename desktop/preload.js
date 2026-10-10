// The main window's bridge to the app: the page's Snap button opens the snap
// toolbar, and the meeting page tells the app what the floating bar should show and
// hears that bar's mic button. On the Mac, Stand also runs edge to edge with no title bar or window
// buttons: the page is marked html.mac-app for Stand's CSS, and a strip along the
// top drags the window. The strip goes first in the page so buttons and links in
// it stay clickable.
const { contextBridge, ipcRenderer } = require("electron");

// snap() resolves to what to tell the person: { title, body, snapId? }, or nothing if they cancelled.
contextBridge.exposeInMainWorld("standApp", {
  snap: () => ipcRenderer.invoke("app:snap"),
  // { space, itemKey, item, micOn } while in a meeting, null after.
  meeting: (m) => ipcRenderer.send("app:meeting", m),
  onCommand: (fn) => {
    const on = (_e, command) => fn(command);
    ipcRenderer.on("app:command", on);
    return () => ipcRenderer.removeListener("app:command", on);
  },
});

if (process.platform === "darwin")
  window.addEventListener("DOMContentLoaded", () => {
    document.documentElement.classList.add("mac-app");
    const strip = document.createElement("div");
    strip.style.cssText = "position:fixed;top:0;left:0;right:0;height:40px;-webkit-app-region:drag;pointer-events:none;z-index:2147483647";
    document.body.prepend(strip);
  });
