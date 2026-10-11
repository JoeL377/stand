const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("save", {
  // {thumb, spaces: [{id, name}], space, items: [{id, title}] | null}
  onOpen: (fn) => ipcRenderer.on("save:open", (_e, o) => fn(o)),
  // A space's items, for the item pill: the first space's when they come, another's on asking.
  onItems: (fn) => ipcRenderer.on("save:first-items", (_e, o) => fn(o)),
  items: (spaceId) => ipcRenderer.invoke("save:items", spaceId),
  ready: () => ipcRenderer.send("save:ready"),
  go: (choice) => ipcRenderer.send("save:go", choice),
  cancel: () => ipcRenderer.send("save:cancel"),
  // How saving went: {ok: true, space, item} or {ok: false, why}.
  onResult: (fn) => ipcRenderer.on("save:result", (_e, r) => fn(r)),
  onEscape: (fn) => ipcRenderer.on("save:escape", () => fn()),
});
