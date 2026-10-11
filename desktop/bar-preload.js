const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bar", {
  onState: (fn) => ipcRenderer.on("bar:state", (_e, s) => fn(s)),
  onReport: (fn) => ipcRenderer.on("bar:report", (_e, r) => fn(r)),
  onShown: (fn) => ipcRenderer.on("bar:shown", (_e, o) => fn(o)),
  // How loud your mic is, 0 to 1, while you talk.
  onLevel: (fn) => ipcRenderer.on("bar:level", (_e, v) => fn(v)),
  press: (button) => ipcRenderer.send("bar:press", button),
  // The first frame of the bar arriving is on screen: it can be made visible.
  painted: () => ipcRenderer.send("bar:painted"),
  onVisible: (fn) => ipcRenderer.on("bar:visible", () => fn()),
  // The to-do list: how much taller the bar needs to be for it (0 to fold it away), which
  // resolves to whether it opens upward; and copying one, as its agent prompt or just its text.
  size: (extra, ask) => ipcRenderer.invoke("bar:size", extra, ask),
  copy: (id, plain) => ipcRenderer.invoke("bar:copy", id, plain),
  onCloseList: (fn) => ipcRenderer.on("bar:close-list", () => fn()),
});
