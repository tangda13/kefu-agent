const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", Object.freeze({
  platform: process.platform,
  isDesktop: true,
  /** 把当前页面存成 PDF（弹出保存对话框），返回 { ok, filePath, canceled } */
  savePdf: (options) => ipcRenderer.invoke("cecs:save-pdf", options),
}));
