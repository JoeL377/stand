const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("snap", {
  onImage: (fn) => ipcRenderer.on("snap:image", (_e, dataUrl) => fn(dataUrl)),
  ready: () => ipcRenderer.send("snap:ready"),
  done: (region) => ipcRenderer.send("snap:region", region),
});
