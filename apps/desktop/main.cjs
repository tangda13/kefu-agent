const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { startAutoUpdate } = require("./updater.cjs");

// D-83：客户端只是外壳，页面从服务器加载（前端一发布所有机器立即生效，机房还原卡也不影响）。
// 服务器地址：开发脚本给的 CECS_DEV_SERVER_URL → 用户数据目录 config.json（手工改的，升级不会被覆盖）
// → 安装目录 resources/config.json（随安装包发，升级会覆盖）→ 内置默认。
// 正式换服务器：改 apps/desktop/config.json 发一个新版本，旧服务器上的客户端自动升级后就连到新服务器。
const DEFAULT_SERVER_URL = "https://kefu.keliagent.cn/";
function readJson(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}
function readConfig() {
  const shipped = readJson(app.isPackaged ? path.join(process.resourcesPath, "config.json") : path.join(__dirname, "config.json"));
  return { ...shipped, ...readJson(path.join(app.getPath("userData"), "config.json")) };
}
function resolveServerUrl() {
  for (const candidate of [process.env.CECS_DEV_SERVER_URL, readConfig().serverUrl, DEFAULT_SERVER_URL]) {
    try {
      const url = new URL(String(candidate || ""));
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // 写错了就用下一个
    }
  }
  return new URL(DEFAULT_SERVER_URL);
}
const serverUrl = resolveServerUrl();
const serverOrigin = serverUrl.origin;
const STATUS_PAGE = path.join(__dirname, "status.html");
const STATUS_URL = pathToFileURL(STATUS_PAGE).toString();

function isServerUrl(url) {
  try {
    return new URL(url).origin === serverOrigin;
  } catch {
    return false;
  }
}
/** 只有我们自己服务器的页面能用客户端的本机能力（存 PDF、链接采集、记住密码） */
const isTrustedSender = (event) => isServerUrl(event.senderFrame?.url ?? "");
const FORBIDDEN = { ok: false, reason: "forbidden" };

// 服务端靠 User-Agent 里的 CecsDesktop/<版本> 认客户端：生产环境学生、教师只能用客户端登录（A3）。
// 必须在建窗口之前设置；商品采集窗口会把它去掉（见下面 userAgent 的处理）
// 直接用 electron 跑源码时 app.getVersion() 是 Electron 自己的版本，改读本目录 package.json
const clientVersion = app.isPackaged ? app.getVersion() : require("./package.json").version;
app.userAgentFallback = `${app.userAgentFallback} CecsDesktop/${clientVersion}`;

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
  if (!isTrustedSender(event)) return FORBIDDEN;
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

// D-32 商品链接采集：在独立窗口里打开商品页（相当于老师本人在浏览，能过验证、带登录态），
// 读到商品信息后自动关闭并把页面内容交回页面，由服务端 AI 整理成商品字段。窗口不加载任何预加载脚本。
/* 在商品页里执行（不能引用外部变量）：读正文、结构化数据和商品图地址。
 * 图片按可靠程度依次找：og:image → ld+json → 页面脚本里的商品图列表（1688 的 mainImage / offerImgList、
 * 速卖通的 imagePathList、亚马逊的 hiRes；1688 没有 og:image，图只在这里）→ 页面上显示得够大的图片。
 * 缩略图地址换成原图（阿里系去掉 _220x220.jpg、.summ.jpg、_.webp 这类后缀，亚马逊去掉 ._AC_US40_ 这类尺寸段） */
function readProductPage() {
  const text = ((document.body && document.body.innerText) || "").replace(/\n{3,}/g, "\n\n");
  const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((el) => el.textContent || "").join("\n").slice(0, 8000);
  const meta = Array.from(document.querySelectorAll('meta[property^="og:"], meta[property^="product:"], meta[name="description"]'))
    .map((el) => `${el.getAttribute("property") || el.getAttribute("name")}: ${el.getAttribute("content")}`).join("\n").slice(0, 3000);
  const images = [];
  const upgrade = (src) => {
    let url = String(src || "").trim().split("\\/").join("/");
    if (url.startsWith("//")) url = `https:${url}`;
    if (/alicdn\.com|aliexpress-media\.com/.test(url)) {
      url = url.replace(/\.(?:\d+x\d+|search|summ)(\.(?:jpe?g|png|webp))$/i, "$1").replace(/(\.(?:jpe?g|png|webp))_[^/?#]*$/i, "$1");
    }
    if (/media-amazon\.com|images-amazon\.com/.test(url)) url = url.replace(/\._[^/]*_(\.(?:jpe?g|png))$/i, "$1");
    return url;
  };
  const push = (src) => {
    const url = upgrade(src);
    if (/^https?:\/\//.test(url) && !/\.(svg|gif)(\?|$)/i.test(url) && !images.includes(url)) images.push(url);
  };
  const og = document.querySelector('meta[property="og:image"]');
  if (og) push(og.getAttribute("content"));
  const ldImg = ld.match(/"image"\s*:\s*(\[[^\]]*\]|"[^"]+")/);
  if (ldImg) { try { [].concat(JSON.parse(ldImg[1])).forEach((item) => push(typeof item === "string" ? item : item && item.url)); } catch (e) { /* 忽略 */ } }
  Array.from(document.scripts).filter((el) => !el.src).forEach((el) => {
    if (images.length >= 10) return;
    const body = el.textContent || "";
    (body.match(/"(?:mainImage|offerImgList|imagePathList|imageList|galleryImages)"\s*:\s*\[[^\]]{0,6000}\]/g) || [])
      .forEach((list) => (list.match(/https?:(?:\\?\/){2}[^"\s]+?\.(?:jpe?g|png|webp)/gi) || []).forEach(push));
    (body.match(/"hiRes"\s*:\s*"https?:[^"]+"/g) || []).forEach((item) => push(item.replace(/^"hiRes"\s*:\s*"/, "").replace(/"$/, "")));
  });
  Array.from(document.images)
    .map((img) => ({ img, rect: img.getBoundingClientRect() }))
    .filter(({ img, rect }) => (img.naturalWidth >= 400 && img.naturalHeight >= 400) || (rect.width >= 240 && rect.height >= 240))
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
    .slice(0, 12)
    .forEach(({ img }) => push(img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src")));
  const blocked = /captcha|unusual traffic|are you a robot|滑动验证|安全验证|验证码|请拖动/i.test(text.slice(0, 3000)) && text.length < 4000;
  const product = /"@type"\s*:\s*"Product"/.test(ld) || /og:type: (product|og:product)/i.test(meta);
  // 往下滚一点，触发懒加载的详情描述
  window.scrollTo(0, Math.min(document.body ? document.body.scrollHeight / 2 : 0, 6000));
  return { title: document.title, text: text.slice(0, 20000), structured: [ld, meta].filter(Boolean).join("\n\n"), images: images.slice(0, 10), blocked, product, length: text.length };
}
const CAPTURE_SCRIPT = `(${readProductPage.toString()})()`;

/** 下载商品图，最多 5 张（主图 5 张）；不要 avif（服务端只收 png / jpg / webp）。
 * 来源页只能用 referrer 选项带：在 headers 里手写 Referer 会被 Electron 直接拦掉（net::ERR_BLOCKED_BY_CLIENT） */
async function downloadImages(captureSession, urls, referer) {
  const result = [];
  for (const url of urls) {
    if (result.length >= 5) break;
    try {
      const response = await captureSession.fetch(url, { referrer: referer, headers: { Accept: "image/webp,image/jpeg,image/png,*/*;q=0.5" } });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !/^image\/(png|jpe?g|webp)/.test(type)) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 8000 || buffer.length > 5 * 1024 * 1024) continue;
      result.push({ dataUrl: `data:${type.split(";")[0]};base64,${buffer.toString("base64")}` });
    } catch (error) {
      // 单张失败跳过，留一行日志方便排查
      console.warn("[capture] image download failed", url, String(error));
    }
  }
  return result;
}

ipcMain.handle("cecs:capture-page", async (event, options = {}) => {
  if (!isTrustedSender(event)) return FORBIDDEN;
  let target;
  try {
    target = new URL(String(options.url || ""));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return { ok: false, reason: "invalid" };
  const parent = BrowserWindow.fromWebContents(event.sender) || undefined;
  const captureSession = session.fromPartition("persist:product-capture");
  const win = new BrowserWindow({
    parent,
    width: 1180,
    height: 820,
    title: "正在读取商品页面（遇到验证请手动完成，读完会自动关闭）",
    autoHideMenuBar: true,
    webPreferences: { session: captureSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const startedAt = Date.now();
  let loadedAt = 0;
  win.webContents.on("did-finish-load", () => { loadedAt = Date.now(); });
  return new Promise((resolve) => {
    let finished = false;
    let busy = false;
    // 正文够了但一张图都没找到时，再等最多 8 秒让主图加载出来
    let imageWaitFrom = 0;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearTimeout(deadline);
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };
    win.on("closed", () => finish({ ok: false, reason: "closed" }));
    const deadline = setTimeout(() => finish({ ok: false, reason: "timeout" }), 120_000);
    const timer = setInterval(async () => {
      if (busy || finished || !loadedAt || Date.now() - loadedAt < 2500 || win.isDestroyed()) return;
      busy = true;
      try {
        const data = await win.webContents.executeJavaScript(CAPTURE_SCRIPT, true);
        const waitedLongEnough = Date.now() - startedAt > 20_000 && data.length > 1500;
        if (!data.blocked && (data.product || data.length > 3000 || waitedLongEnough)) {
          if (!data.images.length) {
            imageWaitFrom = imageWaitFrom || Date.now();
            if (Date.now() - imageWaitFrom < 8000) return;
          }
          const pageUrl = win.webContents.getURL();
          const images = await downloadImages(captureSession, data.images, pageUrl);
          finish({ ok: true, url: pageUrl, title: data.title, text: data.text, structured: data.structured, images });
        }
      } catch {
        // 页面还在跳转，下一轮再试
      } finally {
        busy = false;
      }
    }, 1500);
    // 去掉 UA 里的 Electron 标识，避免被当成爬虫
    const userAgent = win.webContents.getUserAgent().replace(/\s?Electron\/\S+/, "").replace(/\s?@?cecs\S*/i, "");
    win.loadURL(target.toString(), { userAgent }).catch(() => undefined);
  });
});

// 登录页“记住密码”：只存本机，用系统凭据加密（Windows 为 DPAPI），不写明文。
// 浏览器端没有系统凭据能力，由浏览器自带的密码管理器负责，不在这里处理。
const REMEMBERED_LOGIN_ROLES = new Set(["student", "teacher", "admin"]);

function rememberedLoginPath() {
  return path.join(app.getPath("userData"), "remembered-login.json");
}

function readRememberedLogins() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const envelope = JSON.parse(fs.readFileSync(rememberedLoginPath(), "utf8"));
    if (typeof envelope?.data !== "string") return {};
    const plain = safeStorage.decryptString(Buffer.from(envelope.data, "base64"));
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 文件不存在、系统凭据变了、内容损坏：按没记住处理
    return {};
  }
}

function writeRememberedLogins(credentials) {
  try {
    const data = safeStorage.encryptString(JSON.stringify(credentials)).toString("base64");
    fs.writeFileSync(rememberedLoginPath(), JSON.stringify({ v: 1, data }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle("cecs:remembered-login-load", (event) => {
  if (!isTrustedSender(event)) return FORBIDDEN;
  const available = safeStorage.isEncryptionAvailable();
  return { ok: true, available, credentials: available ? readRememberedLogins() : {} };
});

ipcMain.handle("cecs:remembered-login-save", (event, payload = {}) => {
  if (!isTrustedSender(event)) return FORBIDDEN;
  const role = payload.role;
  const username = typeof payload.username === "string" ? payload.username.trim().slice(0, 64) : "";
  const password = typeof payload.password === "string" ? payload.password.slice(0, 128) : "";
  if (!REMEMBERED_LOGIN_ROLES.has(role) || !username || !password) return { ok: false };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, available: false };
  const credentials = readRememberedLogins();
  credentials[role] = { username, password };
  return { ok: writeRememberedLogins(credentials), available: true };
});

ipcMain.handle("cecs:remembered-login-remove", (event, payload = {}) => {
  if (!isTrustedSender(event)) return FORBIDDEN;
  const role = payload.role;
  if (!REMEMBERED_LOGIN_ROLES.has(role)) return { ok: false };
  const credentials = readRememberedLogins();
  delete credentials[role];
  return { ok: writeRememberedLogins(credentials) };
});

/** 页面要用的权限只给我们自己的服务器：麦克风（语音消息）、剪贴板、全屏、通知；其他一律拒绝 */
const ALLOWED_PERMISSIONS = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications"]);
function lockDownPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isServerUrl(webContents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    ALLOWED_PERMISSIONS.has(permission) && requestingOrigin === serverOrigin);
}

function serverEntryUrl() {
  const url = new URL(serverUrl);
  if (role) url.searchParams.set("role", role);
  if (demo) url.searchParams.set("demo", "1");
  return url.toString();
}

/** 本地状态页：连不上服务器（offline）或正在强制更新（updating） */
function showStatus(window, mode, reason = "") {
  if (!window || window.isDestroyed()) return;
  window.loadFile(STATUS_PAGE, { query: { mode, server: serverEntryUrl(), reason } }).catch(() => undefined);
}

let mainWindow = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    title: profile ? `跨境电商客服AI实训平台 · 调试[${(roleTitle[role] ?? "") + profile.replace(/^[a-z]+/i, "") || profile}]` : "跨境电商客服AI实训平台",
    backgroundColor: "#f4f6f9",
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
  // 只能在我们的服务器和本地状态页之间跳转
  window.webContents.on("will-navigate", (event, url) => {
    if (!isServerUrl(url) && !url.startsWith(STATUS_URL)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isServerUrl(url)) event.preventDefault();
  });
  // 连不上服务器（断网、证书错误、服务器没开）：显示本地状态页，它会自动重试
  window.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    // -3 是被新的跳转打断，不算失败
    if (!isMainFrame || code === -3 || !isServerUrl(validatedUrl)) return;
    showStatus(window, "offline", `${description}（${code}）`);
  });
  // 页面自己设置的 <title> 会覆盖窗口标题，调试时保留角色标识
  if (profile) window.on("page-title-updated", (event) => event.preventDefault());

  window.loadURL(serverEntryUrl()).catch(() => undefined);
  return window;
}

// 安装版只开一个窗口：再双击图标时把已经打开的窗口提到前面（开发脚本每个调试档案各用一个数据目录，不受影响）
const singleInstance = !app.isPackaged || app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    lockDownPermissions();
    mainWindow = createWindow();
    let forced = false;
    const run = (script) => {
      if (forced && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.executeJavaScript(script).catch(() => undefined);
    };
    startAutoUpdate({
      serverOrigin,
      getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      onMandatory: () => {
        forced = true;
        showStatus(mainWindow, "updating");
      },
      onProgress: (percent) => {
        if (forced && mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(percent / 100);
        run(`window.setUpdateProgress && window.setUpdateProgress(${Number(percent) || 0})`);
      },
      onMandatoryError: (text) => run(`window.setUpdateText && window.setUpdateText(${JSON.stringify(text)})`),
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });
}

app.on("window-all-closed", () => app.quit());
