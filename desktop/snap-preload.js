const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("snap", {
  onOpen: (fn) => ipcRenderer.on("snap:open", (_e, o) => fn(o)),
  onWindows: (fn) => ipcRenderer.on("snap:windows", (_e, list) => fn(list)),
  ready: () => ipcRenderer.send("snap:ready"),
  done: (choice) => ipcRenderer.send("snap:done", choice),
  // Esc, which the app catches for the toolbar: close Options first, else the toolbar.
  onEscape: (fn) => ipcRenderer.on("snap:escape", () => fn()),
  kept: () => ipcRenderer.send("snap:kept"),
});
