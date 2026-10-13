const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", Object.freeze({
  platform: process.platform,
  isDesktop: true,
  /** 把当前页面存成 PDF（弹出保存对话框），返回 { ok, filePath, canceled } */
  savePdf: (options) => ipcRenderer.invoke("cecs:save-pdf", options),
  /** 在独立窗口里打开商品页并读取内容（D-32），返回 { ok, url, title, text, structured, images:[{dataUrl}] } 或 { ok:false, reason } */
  capturePage: (url) => ipcRenderer.invoke("cecs:capture-page", { url }),
}));
