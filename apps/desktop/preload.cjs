const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktopRuntime", Object.freeze({
  platform: process.platform,
  isDesktop: true,
}));

