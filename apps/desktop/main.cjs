const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

// 学生/教师共用同一客户端，登录页内切换「学生登录/教师登录」页签。
// --role=student|teacher 仅用于预选登录页签，默认不传。
const allowedRoles = new Set(["student", "teacher"]);
const roleArg = process.argv.find((value) => value.startsWith("--role="));
const requestedRole = roleArg ? roleArg.split("=")[1] : "";
const role = allowedRoles.has(requestedRole) ? requestedRole : "";
const demo = process.argv.includes("--demo");

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    title: "跨境电商客服 AI 实训平台",
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
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("http://127.0.0.1:5288")) event.preventDefault();
  });

  const devUrl = process.env.CECS_DEV_SERVER_URL;
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

