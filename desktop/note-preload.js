const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("note", {
  // {space, draft, above, fused, dictateKey, accent, onAccent}
  onOpen: (fn) => ipcRenderer.on("note:open", (_e, o) => fn(o)),
  ready: () => ipcRenderer.send("note:ready"),
  // How tall the card is, so the window fits it and clicks around it reach the app below.
  size: (h) => ipcRenderer.send("note:size", h),
  go: (text) => ipcRenderer.send("note:go", text),
  cancel: (draft) => ipcRenderer.send("note:cancel", draft),
  dictate: () => ipcRenderer.invoke("note:dictate"),
  // How saving went: {ok: true, space} or {ok: false, why}.
  onResult: (fn) => ipcRenderer.on("note:result", (_e, r) => fn(r)),
  onEscape: (fn) => ipcRenderer.on("note:escape", () => fn()),
  onFocus: (fn) => ipcRenderer.on("note:focus", () => fn()),
  // Whether it hangs from the bar ({fused}), and on which side ({above}), when that changes.
  onPlace: (fn) => ipcRenderer.on("note:place", (_e, o) => fn(o)),
  // The snaps pinned to the note, [{id, thumb}], whenever they change.
  onPins: (fn) => ipcRenderer.on("note:pins", (_e, list) => fn(list)),
  unpin: (id) => ipcRenderer.send("note:unpin", id),
});
