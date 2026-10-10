const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bar", {
  onState: (fn) => ipcRenderer.on("bar:state", (_e, s) => fn(s)),
  onReport: (fn) => ipcRenderer.on("bar:report", (_e, r) => fn(r)),
  press: (button) => ipcRenderer.send("bar:press", button),
});
