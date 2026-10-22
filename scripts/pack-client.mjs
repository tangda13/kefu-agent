// 打 Windows 客户端安装包（D-83）。用法：node scripts/pack-client.mjs [dir]
//   默认出 NSIS 安装包 + latest.yml + blockmap 到 apps/desktop/dist/；带 dir 只出免安装目录（本机试跑用）。
// 打包在系统临时目录（纯英文路径）里单独进行：只在那里用 npm 装自动更新库、用 npx 跑 electron-builder，不碰工作区 node_modules。
// 原因（2026-10-22）：往工作区装 electron-builder（约 170 个包）在本机反复卡在 pnpm 重命名目录；项目路径带中文，打包工具链也容易出问题。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const ELECTRON_DIST = path.join(ROOT, "node_modules", "electron", "dist");
const STAGE = path.join(os.tmpdir(), "cecs-client-build");
const OUT = path.join(DESKTOP, "dist");
const target = process.argv[2] === "dir" ? "dir" : "nsis";
const REGISTRY = process.env.NPM_REGISTRY || "https://registry.npmmirror.com";
/** 打包工具和外壳运行时依赖的版本只在这里锁定（不进工作区） */
const BUILDER = "electron-builder@26.15.3";
const RUNTIME_DEPS = { "electron-updater": "6.8.9" };
/** 打进安装包的外壳文件；config.json 作为 extraResources 放到 resources/ 下 */
const FILES = ["main.cjs", "preload.cjs", "updater.cjs", "status.html", "config.json", "build"];

function die(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/**
 * 逐个文件复制目录。不用 fs.cpSync：Node 24.12 在 Windows 上递归复制源路径带中文的目录会直接崩掉
 * （退出码 127、没有任何报错），覆盖已有文件也会报 ESRCH（2026-10-22 实测）
 */
function copyTree(src, dst) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
  } else {
    fs.copyFileSync(src, dst);
  }
}

function run(command, args, cwd, env = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (result.status !== 0) die(`命令失败：${command} ${args.join(" ")}`);
}

if (!fs.existsSync(path.join(ELECTRON_DIST, "electron.exe"))) die("工作区里没有 Electron 运行时，先跑一次 dev.cmd（会自动下载）");

console.log(`==> 打包目录 ${STAGE}`);
fs.mkdirSync(STAGE, { recursive: true });
fs.rmSync(path.join(STAGE, "dist"), { recursive: true, force: true });
for (const name of FILES) {
  fs.rmSync(path.join(STAGE, name), { recursive: true, force: true });
  copyTree(path.join(DESKTOP, name), path.join(STAGE, name));
}

// Electron 本体用工作区已下载好的，复制一份到英文路径；版本没变就不重复复制
const electronCopy = path.join(STAGE, "electron-dist");
const versionOf = (dir) => (fs.existsSync(path.join(dir, "version")) ? fs.readFileSync(path.join(dir, "version"), "utf8").trim() : "");
const electronVersion = versionOf(ELECTRON_DIST);
if (versionOf(electronCopy) !== electronVersion) {
  console.log(`==> 复制 Electron ${electronVersion} 运行时`);
  fs.rmSync(electronCopy, { recursive: true, force: true });
  copyTree(ELECTRON_DIST, electronCopy);
  // Electron 自带的演示程序，装了我们的 app.asar 就用不到
  fs.rmSync(path.join(electronCopy, "resources", "default_app.asar"), { force: true });
}

const manifest = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
const staged = {
  // 安装目录（%LOCALAPPDATA%\Programs\cecs-client）和更新缓存目录按这个名字取；工作区包名 @cecs/desktop 会变成 @cecsdesktop
  name: "cecs-client",
  version: manifest.version,
  description: manifest.description,
  author: manifest.author,
  main: manifest.main,
  dependencies: RUNTIME_DEPS,
  build: { ...manifest.build, electronVersion: electronVersion || manifest.build.electronVersion, electronDist: electronCopy },
};
fs.writeFileSync(path.join(STAGE, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
console.log(`==> 客户端版本 ${staged.version}，目标 ${target}`);

const env = {
  npm_config_registry: REGISTRY,
  // NSIS 等打包工具从国内镜像下载
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/",
};
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], STAGE, env);
run("npx", ["--yes", BUILDER, "--win", target, "--x64", "--publish", "never"], STAGE, env);

if (target === "dir") {
  console.log(`\n✓ 免安装目录：${path.join(STAGE, "dist", "win-unpacked")}`);
} else {
  fs.mkdirSync(OUT, { recursive: true });
  const artifacts = fs.readdirSync(path.join(STAGE, "dist")).filter((name) => /^cecs-client-setup-.+\.exe(\.blockmap)?$|^latest\.yml$/.test(name));
  if (!artifacts.some((name) => name.endsWith(".exe"))) die("没有产出安装包");
  for (const name of artifacts) fs.copyFileSync(path.join(STAGE, "dist", name), path.join(OUT, name));
  console.log(`\n✓ 已输出到 ${OUT}：\n  ${artifacts.join("\n  ")}`);
  console.log("  上传顺序：先传 .exe 和 .blockmap，最后传 latest.yml（见 docs/DEPLOY.md 第八节）");
}
