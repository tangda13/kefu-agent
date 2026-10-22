const { app, dialog, net } = require("electron");

// 客户端自动更新（D-14、D-83）。页面从服务器加载，外壳本身很少更新。
// 更新源是服务器的 /updates/：electron-builder 产出的 latest.yml + 安装包 + blockmap（只下载变了的部分）。
// 启动时检查、后台下载，下载好提示重启；/updates/policy.json 里的 minVersion 高于当前版本时必须更新：
// 不进页面，下载完直接重启安装。安装包不签名（D-14），electron-updater 没有 publisherName 时不校验签名。

/** 比较 x.y.z 版本号：a 比 b 新返回 1，旧返回 -1，相同返回 0 */
function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** 读 /updates/policy.json；读不到按“不强制”处理 */
async function fetchPolicy(serverOrigin) {
  try {
    const response = await net.fetch(`${serverOrigin}/updates/policy.json`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return {};
    const json = await response.json();
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

/**
 * 只在安装版里运行（开发时 electron 直接跑源码，没有更新可言）。
 * onMandatory：要强制更新时调用（主窗口改显示“正在更新”）；onProgress：强制更新的下载进度（0–100）；
 * onMandatoryError(text)：强制更新卡住时给用户看的话。
 */
function startAutoUpdate({ serverOrigin, getWindow, onMandatory, onProgress, onMandatoryError }) {
  if (!app.isPackaged) return;
  const { autoUpdater } = require("electron-updater");
  autoUpdater.setFeedURL({ provider: "generic", url: `${serverOrigin}/updates/` });
  autoUpdater.autoDownload = true;
  // 选“稍后”的，下次关闭客户端时自动装
  autoUpdater.autoInstallOnAppQuit = true;
  let mandatory = false;

  autoUpdater.on("download-progress", (progress) => {
    if (mandatory) onProgress(progress.percent);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    // 静默安装、装完自动打开，不弹安装向导
    if (mandatory) {
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    const window = getWindow();
    const options = {
      type: "info",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
      title: "客户端更新",
      message: `新版本 ${info.version} 已下载`,
      detail: "重启客户端后生效；选“稍后”会在下次关闭客户端时自动安装。",
    };
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response === 0) autoUpdater.quitAndInstall(true, true);
  });
  autoUpdater.on("update-not-available", () => {
    // 服务器要求更新但没放新安装包：别让学生干等
    if (mandatory) onMandatoryError("服务器上还没有新版本的安装包，请联系老师或管理员。");
  });
  autoUpdater.on("error", (error) => {
    console.warn("[updater]", String(error?.message ?? error));
    if (!mandatory) return;
    onMandatoryError("下载失败，30 秒后自动重试。");
    // 强制更新时下载失败：30 秒后再试
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => undefined), 30_000);
  });

  fetchPolicy(serverOrigin).then((policy) => {
    if (typeof policy.minVersion === "string" && compareVersions(app.getVersion(), policy.minVersion) < 0) {
      mandatory = true;
      onMandatory(policy.minVersion);
    }
    autoUpdater.checkForUpdates().catch((error) => console.warn("[updater] check failed", String(error?.message ?? error)));
  });
}

module.exports = { compareVersions, startAutoUpdate };
