const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 学生/教师共用同一客户端，登录页内切换「学生登录/教师登录」页签。
// --role=student|teacher 仅用于预选登录页签，默认不传。
const allowedRoles = new Set(["student", "teacher"]);
const roleArg = process.argv.find((value) => value.startsWith("--role="));
const requestedRole = roleArg ? roleArg.split("=")[1] : "";
const role = allowedRoles.has(requestedRole) ? requestedRole : "";
const demo = process.argv.includes("--demo");

// 开发调试：--profile=<名称> 让每个窗口使用独立的数据目录（登录态互不影响），
// 这样学生、教师可以同时各开一个客户端。名称只允许字母数字和 -_，正式安装包不传该参数。
const profileArg = process.argv.find((value) => value.startsWith("--profile="));
const profile = profileArg ? profileArg.split("=")[1] : "";
if (profile && /^[\w-]{1,32}$/.test(profile)) {
  app.setPath("userData", path.join(app.getPath("appData"), "cecs-dev-profiles", profile));
}
const roleTitle = { student: "学生", teacher: "教师" };

// D10：考核报表直接存成 PDF 文件（页面里的“导出 PDF”调用），不走系统打印对话框
ipcMain.handle("cecs:save-pdf", async (event, options = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return { ok: false };
  const safeName = String(options.fileName || "报表").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: "导出 PDF",
    defaultPath: path.join(app.getPath("documents"), `${safeName}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const data = await event.sender.printToPDF({ printBackground: true, pageSize: "A4", landscape: Boolean(options.landscape), margins: { marginType: "default" } });
  fs.writeFileSync(filePath, data);
  return { ok: true, filePath };
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    title: profile ? `跨境电商客服AI实训平台 · 调试[${(roleTitle[role] ?? "") + profile.replace(/^[a-z]+/i, "") || profile}]` : "跨境电商客服AI实训平台",
    backgroundColor: "#f4f7f8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env.CECS_DEV_SERVER_URL;
  const devOrigin = devUrl ? new URL(devUrl).origin : null;
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !(devOrigin && url.startsWith(devOrigin))) event.preventDefault();
  });
  // 页面自己设置的 <title> 会覆盖窗口标题，调试时保留角色标识
  if (profile) window.on("page-title-updated", (event) => event.preventDefault());

  if (devUrl) {
    const url = new URL(devUrl);
    if (role) url.searchParams.set("role", role);
    if (demo) url.searchParams.set("demo", "1");
    window.loadURL(url.toString());
  } else {
    const query = {};
    if (role) query.role = role;
    if (demo) query.demo = "1";
    window.loadFile(path.join(__dirname, "..", "portal", "dist", "index.html"), { query });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

