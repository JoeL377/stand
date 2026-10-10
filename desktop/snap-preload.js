const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("snap", {
  onOpen: (fn) => ipcRenderer.on("snap:open", (_e, o) => fn(o)),
  ready: () => ipcRenderer.send("snap:ready"),
  done: (choice) => ipcRenderer.send("snap:done", choice),
});
