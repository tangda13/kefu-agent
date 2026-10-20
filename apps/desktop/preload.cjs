const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", Object.freeze({
  platform: process.platform,
  isDesktop: true,
  /** 把当前页面存成 PDF（弹出保存对话框），返回 { ok, filePath, canceled } */
  savePdf: (options) => ipcRenderer.invoke("cecs:save-pdf", options),
  /** 在独立窗口里打开商品页并读取内容（D-32），返回 { ok, url, title, text, structured, images:[{dataUrl}] } 或 { ok:false, reason } */
  capturePage: (url) => ipcRenderer.invoke("cecs:capture-page", { url }),
  /** 登录页“记住密码”（D-51）：密码由主进程用系统凭据加密后存本机 userData，渲染层只拿到明文供输入框回填 */
  rememberedLogin: Object.freeze({
    load: () => ipcRenderer.invoke("cecs:remembered-login-load"),
    save: (role, username, password) => ipcRenderer.invoke("cecs:remembered-login-save", { role, username, password }),
    remove: (role) => ipcRenderer.invoke("cecs:remembered-login-remove", { role }),
  }),
}));
