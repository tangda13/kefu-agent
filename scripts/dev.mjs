#!/usr/bin/env node
/**
 * 跨境电商客服 AI 实训智能体 - 本地开发调试入口（dev.cmd / admin.cmd 都调用本脚本）
 *
 * 设计（见 keli-jingyan 技能 references/dev-launcher.md）：
 * - 第一个启动服务的窗口就是“托管窗口”：API 和前端是它的子进程，日志合并输出（[api] / [web] 前缀），
 *   同时写入 .devrun/logs/*.log。Ctrl+C 或关闭这个窗口，服务和客户端一起停。
 * - 入口幂等：服务已在运行时，dev.cmd / admin.cmd / client 只打开客户端或浏览器，然后立即退出。
 *   “谁先占到控制端口 127.0.0.1:18787 谁当托管窗口”：端口天然互斥，进程一退出系统就释放，
 *   不会留下失效的锁；同时双击两个入口，后一个会等前一个起完再复用。
 * - 数据库在 Docker 里后台常驻；业务代码在本机热更新（tsx watch / Vite）。
 * - 其他终端的 stop / restart / status 通过同一个控制端口通知托管窗口（本机 HTTP，只监听 127.0.0.1）。
 *
 * 用法：
 *   dev.cmd                       起服务（本窗口成为托管窗口）+ 打开学生、教师两个客户端
 *   dev.cmd start student         只开学生客户端（teacher / both / none 同理）；加 --demo 演示模式
 *   dev.cmd client teacher 2      再开一个教师客户端（第 2 个调试档案，可登录另一个账号）
 *   admin.cmd                     在浏览器打开管理端（服务没起时本窗口成为托管窗口）
 *   dev.cmd status                服务、托管窗口、客户端、当前模型
 *   dev.cmd restart [api|portal]  通知托管窗口重启服务（不带参数重启全部）
 *   dev.cmd stop                  停止服务和客户端（数据库容器保留）
 *   dev.cmd logs [api|portal]     新窗口实时查看单个服务的日志文件
 *   dev.cmd test                  构建 + 全部测试
 *   dev.cmd eval [full]           Agent 评测集（真实调用当前模型，有少量费用）
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_DIR = path.join(ROOT, ".devrun");
const LOG_DIR = path.join(RUN_DIR, "logs");
const CONTROL_PORT = 18787;
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const API_PORT = 8787;
const WEB_PORT = 5288; // 本项目专属端口，勿改回 5173（被智慧物流实训智能体占用）
const PG_PORT = 5434;
const CONTAINER = "cecs-pg";
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const IS_WIN = process.platform === "win32";

/** 业务服务。直接用 node 跑 tsx / vite，不经过 pnpm（pnpm 11 运行前的依赖检查会在服务运行时重装依赖并卡死） */
const SERVICES = {
  api: {
    label: "API", tag: "api", color: 36, port: API_PORT, health: `${API_URL}/health`,
    cwd: path.join(ROOT, "apps", "api"),
    args: [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "watch", "src/server.ts"],
  },
  portal: {
    label: "前端", tag: "web", color: 35, port: WEB_PORT, health: `${WEB_URL}/`,
    cwd: path.join(ROOT, "apps", "portal"),
    args: [path.join(ROOT, "node_modules", "vite", "bin", "vite.js")],
  },
};

// ---------- 输出 ----------
const paint = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const step = (text) => console.log(paint(36, `==> ${text}`));
const ok = (text) => console.log(paint(32, `    ${text}`));
const warn = (text) => console.log(paint(33, `    ${text}`));
const fail = (text) => console.log(paint(31, `    ${text}`));
const dim = (text) => console.log(paint(90, text));

class ExitError extends Error {}
const die = (message) => {
  fail(message);
  throw new ExitError(message);
};

// ---------- 工具 ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

const servicesUp = async () => (await httpOk(SERVICES.api.health)) && (await httpOk(SERVICES.portal.health));

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** 托管窗口的状态（控制端口无人监听时返回 null） */
async function hostState() {
  try {
    const response = await fetch(`${CONTROL_URL}/state`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function hostCommand(command, timeoutMs = 90_000) {
  try {
    const response = await fetch(`${CONTROL_URL}/${command}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** 监听某端口的进程号（Windows 用 netstat，无需管理员） */
function portPid(port) {
  try {
    const out = IS_WIN
      ? execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" })
      : execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    if (!IS_WIN) return Number(out.trim().split("\n")[0]) || null;
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[3] === "LISTENING" && cols[1].endsWith(`:${port}`)) return Number(cols[4]);
    }
  } catch {
    /* 没有监听 */
  }
  return null;
}

function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
}

/** pnpm 等在 Windows 上是 .cmd，经 cmd /c 调用（不用 shell:true 拼参数） */
function run(command, args, options = {}) {
  return IS_WIN
    ? spawnSync("cmd", ["/d", "/s", "/c", command, ...args], { encoding: "utf8", ...options })
    : spawnSync(command, args, { encoding: "utf8", ...options });
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "").trim() };
}

/** 子进程环境：清掉从 AI 命令行工具继承的变量和 TZ（否则日志时间错乱） */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE|OPENAI_|CCSWITCH)/i.test(key) || key === "TZ" || key === "API_KEY" || key === "API_BASE_URL") delete env[key];
  }
  return env;
}

// ---------- 前置检查 ----------
function assertPrerequisites() {
  step("检查前置依赖");
  for (const tool of ["pnpm", "docker"]) {
    if (spawnSync(IS_WIN ? "where" : "which", [tool]).status !== 0) die(`缺少 ${tool}，请先安装后重试。`);
  }
  if (docker(["info"]).code !== 0) die("Docker Desktop 未运行：请先打开 Docker Desktop，等左下角显示 Engine running 后再试。");
  if (!fs.existsSync(path.join(ROOT, "apps", "api", ".env"))) warn("缺少 apps/api/.env：可以启动，但语音等服务没有密钥（模型在管理端配置）");
  ok("node / pnpm / docker 就绪");
}

async function ensureDatabase() {
  step(`数据库容器 ${CONTAINER}（Postgres 16 @ ${PG_PORT}）`);
  const exists = docker(["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Names}}"]).out;
  if (!exists) {
    warn("容器不存在，正在创建…");
    docker(["run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "-e", "POSTGRES_USER=cecs", "-e", "POSTGRES_PASSWORD=cecs_dev_2026", "-e", "POSTGRES_DB=cecs",
      "-p", `${PG_PORT}:5432`, "-v", "cecs-pg-data:/var/lib/postgresql/data", "postgres:16-alpine"]);
  } else if (!docker(["ps", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Names}}"]).out) {
    warn("容器已停止，正在启动…");
    docker(["start", CONTAINER]);
  }
  let ready = false;
  for (let i = 0; i < 30 && !ready; i += 1) {
    ready = docker(["exec", CONTAINER, "pg_isready", "-U", "cecs"]).code === 0;
    if (!ready) await sleep(1000);
  }
  if (!ready) die(`数据库 30 秒内未就绪，查看容器日志：docker logs ${CONTAINER}`);
  const hasTestDb = docker(["exec", CONTAINER, "psql", "-U", "cecs", "-tAc", "select 1 from pg_database where datname='cecs_test'"]).out;
  if (hasTestDb !== "1") {
    docker(["exec", CONTAINER, "psql", "-U", "cecs", "-c", "create database cecs_test;"]);
    ok("已创建集成测试库 cecs_test");
  }
  ok("数据库就绪");
}

/** 服务都没在跑时同步一次依赖（已是最新则 1–2 秒结束）；有服务在跑时跳过，避免抢 node_modules */
function ensureDependencies() {
  if (portPid(API_PORT) || portPid(WEB_PORT)) return;
  step("同步依赖（pnpm install）");
  dim("    若超过 2 分钟没有进展：关掉本窗口，删除项目里所有 node_modules 目录后重试");
  const result = run("pnpm", ["install", "--reporter=append-only"], { cwd: ROOT, env: { ...process.env, CI: "true" } });
  for (const line of `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(-2)) dim(`    ${line}`);
  if (result.status !== 0) die("依赖安装失败，见上方输出（常见原因见 kefu-weihu 踩坑表）。");
  ensureElectron();
}

function ensureElectron() {
  if (fs.existsSync(ELECTRON)) return;
  step("下载 Electron 运行时（npmmirror 镜像，约 100MB）…");
  spawnSync(process.execPath, ["node_modules/electron/install.js"], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/" },
  });
  if (!fs.existsSync(ELECTRON)) die("Electron 运行时下载失败，请检查网络后重试。");
  ok("Electron 运行时已就绪");
}

// ---------- 控制端口（互斥 + 控制通道） ----------
/**
 * 抢控制端口。抢到返回 server（本进程将成为托管窗口）；端口被占说明已有托管窗口（启动中或运行中），
 * 等它就绪后返回 null；占用者中途退出则重新抢。
 */
async function claimControlPort() {
  const deadline = Date.now() + 180_000;
  let announced = false;
  while (Date.now() < deadline) {
    const server = http.createServer();
    const claimed = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(CONTROL_PORT, "127.0.0.1", () => resolve(true));
    });
    if (claimed) return server;
    const state = await hostState();
    if (state?.state === "ready") return null;
    if (state && !announced) {
      warn("另一个 dev.cmd / admin.cmd 正在启动服务，等它完成…");
      announced = true;
    }
    if (!state) {
      // 端口被占却不回应：要么占用者刚好退出（下一轮重抢），要么是别的程序占了这个端口
      const pid = portPid(CONTROL_PORT);
      if (pid && pidAlive(pid)) die(`控制端口 ${CONTROL_PORT} 被其他程序占用（进程 ${pid}），请释放后重试。`);
      continue;
    }
    await sleep(500);
  }
  die("等待其他托管窗口启动超时（3 分钟），可执行 dev.cmd stop 后重试。");
}

// ---------- 托管窗口 ----------
class ServiceHost {
  constructor() {
    this.children = {};
    this.stopping = false;
  }

  start(name, rotate) {
    const def = SERVICES[name];
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `${name}.log`);
    if (rotate && fs.existsSync(logFile)) fs.renameSync(logFile, path.join(LOG_DIR, `${name}.prev.log`));
    const log = fs.createWriteStream(logFile, { flags: "a" });
    // stdin 也走管道：否则 Vite 检测到终端会进入快捷键模式抢键盘
    const child = spawn(process.execPath, def.args, {
      cwd: def.cwd,
      env: childEnv({ LOG_PRETTY: "1", FORCE_COLOR: "0" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const prefix = paint(def.color, `[${def.tag}]`);
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on("line", (line) => {
        console.log(`${prefix} ${line}`);
        log.write(`${stripAnsi(line)}\n`);
      });
    }
    child.on("exit", (code) => {
      log.end();
      if (!this.stopping && this.children[name]?.child === child) {
        fail(`[${def.tag}] 进程已退出（退出码 ${code}）。按 R 重启，Ctrl+C 停止全部。`);
      }
    });
    this.children[name] = { child, def };
    return child;
  }

  async waitHealthy(name, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await httpOk(SERVICES[name].health)) return true;
      if (this.children[name]?.child.exitCode !== null) return false;
      await sleep(500);
    }
    return false;
  }

  async restart(names) {
    for (const name of names) {
      const def = SERVICES[name];
      console.log("");
      step(`重启 ${def.label}`);
      const current = this.children[name];
      if (current) {
        this.children[name] = undefined;
        killTree(current.child.pid);
      }
      for (let i = 0; i < 20 && portPid(def.port); i += 1) await sleep(250);
      this.start(name, false);
      if (await this.waitHealthy(name)) ok(`${def.label} 已就绪`);
      else fail(`${def.label} 60 秒内未就绪，看上方日志`);
    }
  }

  stopAll() {
    this.stopping = true;
    for (const entry of Object.values(this.children)) if (entry) killTree(entry.child.pid);
  }
}

/**
 * 启动并托管服务。服务已在运行时返回 false（调用方只做增量动作）；
 * 否则本窗口成为托管窗口，服务就绪后执行 onReady，然后一直输出日志直到停止，返回 true。
 */
async function hostServices(onReady) {
  const server = await claimControlPort();
  if (!server) return false;
  const host = new ServiceHost();
  let phase = "starting";
  let finish = () => {};
  server.on("request", async (request, response) => {
    const reply = (code, body) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const route = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && route === "/state") return reply(200, { state: phase, pid: process.pid });
    if (request.method !== "POST") return reply(404, {});
    if (route === "/stop") {
      reply(200, { ok: true });
      return finish();
    }
    const match = /^\/restart(?:\/(api|portal))?$/.exec(route);
    if (match && phase === "ready") {
      await host.restart(match[1] ? [match[1]] : Object.keys(SERVICES));
      return reply(200, { ok: true });
    }
    return reply(match ? 409 : 404, {});
  });
  try {
    if (await servicesUp()) return false; // 服务是在托管窗口之外起的（例如手动），直接复用
    assertPrerequisites();
    await ensureDatabase();
    for (const def of Object.values(SERVICES)) {
      if (portPid(def.port)) die(`端口 ${def.port}（${def.label}）被占用但服务不通：先执行 dev.cmd stop 再试。`);
    }
    ensureDependencies();
    if (IS_WIN) process.title = `CECS 开发服务（API :${API_PORT} · 前端 :${WEB_PORT}）· Ctrl+C 停止`;

    for (const name of Object.keys(SERVICES)) {
      step(`启动 ${SERVICES[name].label}`);
      host.start(name, true);
      if (!(await host.waitHealthy(name))) {
        host.stopAll();
        die(`${SERVICES[name].label} 60 秒内未就绪，看上方日志（常见：数据库没起、.env 配置错误）`);
      }
      ok(`${SERVICES[name].label} 已就绪`);
    }
    phase = "ready";
    await onReady();
    console.log("");
    dim("  以下是服务日志（[api] 后端 · [web] 前端）。Ctrl+C 或关闭本窗口即停止全部服务；按 R 重启已退出的服务。");
    console.log("");

    await new Promise((resolve) => {
      let finished = false;
      finish = () => {
        if (finished) return;
        finished = true;
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      };
      // 原始模式读键：Ctrl+C 作为输入交给本进程统一收尾，不直接打断子进程
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", (data) => {
          const key = data.toString();
          if (key === "\u0003") finish();
          else if (key.toLowerCase() === "r") {
            const exited = Object.keys(SERVICES).filter((name) => !host.children[name] || host.children[name].child.exitCode !== null);
            if (exited.length) void host.restart(exited);
          }
        });
      }
      process.on("SIGINT", finish);
      process.on("SIGHUP", finish); // 关闭窗口
    });
    return true;
  } finally {
    server.close();
    if (Object.keys(host.children).length) {
      console.log("");
      step("停止开发服务");
      host.stopAll();
      stopClients();
      ok("API、前端和客户端已停止（数据库容器保留）");
    }
  }
}

// ---------- 客户端 ----------
function listClients() {
  if (!IS_WIN) return [];
  const shell = spawnSync("where", ["pwsh"]).status === 0 ? "pwsh" : "powershell";
  const script = `Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${ROOT.replace(/'/g, "''")}*' } | ForEach-Object { '{0}|{1}' -f $_.Id, $_.MainWindowTitle }`;
  const result = spawnSync(shell, ["-NoProfile", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: "utf8" });
  return (result.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, ...title] = line.split("|");
    return { pid: Number(pid), title: title.join("|") };
  });
}

/** 关闭全部客户端，返回关闭的窗口数（Electron 一个窗口对应多个进程，只数有标题的主进程） */
function stopClients() {
  const clients = listClients();
  for (const client of clients) killTree(client.pid);
  return clients.filter((client) => client.title).length;
}

async function openClient(role, index = 1, demo = false) {
  ensureElectron();
  if (!(await httpOk(SERVICES.portal.health))) die("前端未运行，先执行 dev.cmd");
  const profile = index > 1 ? `${role}${index}` : role;
  const args = [path.join(ROOT, "apps", "desktop", "main.cjs"), `--role=${role}`, `--profile=${profile}`];
  if (demo) args.push("--demo");
  const child = spawn(ELECTRON, args, {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: childEnv({ CECS_DEV_SERVER_URL: `${WEB_URL}/` }),
  });
  child.unref();
  ok(`已打开${role === "student" ? "学生" : "教师"}客户端（调试档案 ${profile}，登录态与其他窗口互不影响）`);
}

function openBrowser(url) {
  if (IS_WIN) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

// ---------- 状态 ----------
async function showStatus() {
  step("开发环境状态");
  const db = docker(["ps", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Status}}"]).out;
  db ? ok(`数据库   运行中（${db}）`) : warn("数据库   未运行");
  (await httpOk(SERVICES.api.health)) ? ok(`API      运行中  ${API_URL}`) : warn("API      未运行");
  (await httpOk(SERVICES.portal.health)) ? ok(`前端     运行中  ${WEB_URL}`) : warn("前端     未运行");
  const state = await hostState();
  if (state) ok(`托管窗口 PID ${state.pid}（${state.state === "ready" ? "运行中" : "启动中"}，日志在那个窗口里滚动，Ctrl+C 停止全部服务）`);
  const clients = listClients().filter((client) => client.title);
  ok(`客户端   ${clients.length} 个窗口${clients.length ? "：" + clients.map((client) => client.title.replace(/.*调试/, "")).join(" ") : ""}`);
  const llm = db ? docker(["exec", CONTAINER, "psql", "-U", "cecs", "-tAc", "select name || ' · ' || model || ' @ ' || base_url from llm_profiles where is_default"]).out : "";
  llm ? ok(`LLM      ${llm}（默认档案，按用途分配见管理端）`)
    : warn("LLM      没有默认档案：到管理端「AI 与语音服务」新增档案、测试并设为默认（首次启动会自动导入 apps/api/.env 的 LLM_*）");
  ok(`日志     ${LOG_DIR}`);
}

function accounts() {
  console.log("");
  console.log("  开发库账号  管理员 admin / Admin#Prod2026（新库为 Admin#2026，首登强制改密）");
  console.log("              教师 wang.teacher / Teach#2026    学生 s2601001 / Student#01 · s2601002 / Student#02");
  console.log("  忘记密码    pnpm --filter @cecs/api reset-password <账号>");
}

function devSummary() {
  console.log("");
  console.log(paint(32, "================= 开发环境已就绪 ================="));
  console.log(`  API      ${API_URL}  （改后端代码自动重启）`);
  console.log(`  前端     ${WEB_URL}  （改前端代码热更新，客户端里 Ctrl+R 强制刷新，Ctrl+Shift+I 开发者工具）`);
  console.log("  管理端   admin.cmd");
  console.log("  常用     dev.cmd client teacher 2 | status | restart api | stop | test   （在另一个终端执行）");
  accounts();
  console.log(paint(32, "==================================================="));
}

// ---------- 命令 ----------
async function openRoles(which, demo) {
  const map = { "": ["student", "teacher"], both: ["student", "teacher"], student: ["student"], teacher: ["teacher"], none: [] };
  const roles = map[which];
  if (!roles) die(`未知客户端类型：${which}（可选 student / teacher / both / none）`);
  if (roles.length) step("打开客户端");
  for (const role of roles) await openClient(role, 1, demo);
}

async function main() {
  const raw = process.argv.slice(2);
  const demo = raw.some((arg) => /^-{1,2}demo$/i.test(arg));
  const [action = "start", target = "", index = "1"] = raw.filter((arg) => !/^-{1,2}demo$/i.test(arg));

  switch (action) {
    case "start": {
      const hosted = await hostServices(async () => {
        await openRoles(target, demo);
        devSummary();
      });
      if (!hosted) {
        ok("服务已在运行（日志在托管窗口里）");
        await openRoles(target, demo);
      }
      return;
    }
    case "admin": {
      const url = `${WEB_URL}/?role=admin`;
      const hosted = await hostServices(async () => {
        step(`打开管理端 ${url}`);
        openBrowser(url);
        accounts();
      });
      if (!hosted) {
        ok("服务已在运行（日志在托管窗口里）");
        step(`打开管理端 ${url}`);
        openBrowser(url);
      }
      return;
    }
    case "client": {
      if (!["student", "teacher"].includes(target)) die("用法：dev.cmd client student|teacher [序号]");
      await openClient(target, Number(index) || 1, demo);
      return;
    }
    case "stop": {
      step(`停止开发服务（保留数据库容器 ${CONTAINER}）`);
      if (await hostState()) {
        await hostCommand("stop", 5000);
        for (let i = 0; i < 75 && (await hostState()); i += 1) await sleep(200);
        ok("已通知托管窗口停止服务");
      }
      // 兜底：托管窗口不在（或没响应）时按端口结束
      for (const def of Object.values(SERVICES)) {
        const pid = portPid(def.port);
        if (pid && pidAlive(pid)) {
          killTree(pid);
          ok(`${def.label} 已停止`);
        }
      }
      const closed = stopClients();
      if (closed) ok(`已关闭 ${closed} 个客户端`);
      return;
    }
    case "restart": {
      if (target && !SERVICES[target]) die("用法：dev.cmd restart [api|portal]");
      if ((await hostState())?.state !== "ready") die("没有运行中的托管窗口：直接执行 dev.cmd 启动即可。");
      step(`通知托管窗口重启${target ? ` ${SERVICES[target].label}` : "全部服务"}`);
      await hostCommand(target ? `restart/${target}` : "restart");
      const names = target ? [target] : Object.keys(SERVICES);
      for (const name of names) {
        (await httpOk(SERVICES[name].health)) ? ok(`${SERVICES[name].label} 已就绪`) : fail(`${SERVICES[name].label} 未就绪，看托管窗口的日志`);
      }
      return;
    }
    case "status":
      await showStatus();
      return;
    case "logs": {
      const name = target || "api";
      if (!SERVICES[name]) die("用法：dev.cmd logs [api|portal]");
      const file = path.join(LOG_DIR, `${name}.log`);
      if (!fs.existsSync(file)) die(`还没有日志：${file}`);
      const inner = `$Host.UI.RawUI.WindowTitle = 'CECS 日志 · ${name}'; Get-Content -LiteralPath '${file}' -Tail 200 -Wait -Encoding utf8`;
      spawn("cmd", ["/c", "start", "", "powershell", "-NoExit", "-NoProfile", "-Command", inner], { detached: true, stdio: "ignore" }).unref();
      ok(`已在新窗口打开 ${file}`);
      return;
    }
    case "test": {
      step("构建 + 全部测试（集成测试使用 cecs_test 库，不动开发库）");
      await ensureDatabase();
      const env = { ...process.env, CI: "true" };
      let result = run("pnpm", ["build"], { cwd: ROOT, stdio: "inherit", env });
      if (result.status === 0) result = run("pnpm", ["test"], { cwd: ROOT, stdio: "inherit", env });
      if (result.status === 0) ok("构建与测试全部通过");
      else die("失败，见上方输出");
      return;
    }
    case "eval": {
      step(`Agent 评测集（${target === "full" ? "完整：8 个用例，含 20 轮长对话" : "快速：4 个用例 × 8 轮"}）`);
      await ensureDatabase();
      const args = [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/scripts/agent-eval.ts"];
      if (target === "full") args.push("--full");
      const result = spawnSync(process.execPath, args, { cwd: path.join(ROOT, "apps", "api"), stdio: "inherit", env: childEnv() });
      if (result.status !== 0) throw new ExitError("eval failed");
      return;
    }
    case "help":
    case "-h":
    case "--help": {
      const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
      const usage = text.slice(text.indexOf(" * 用法："), text.indexOf(" */"));
      console.log(usage.replace(/^ \* ?/gm, ""));
      return;
    }
    default:
      die(`未知命令：${action}（dev.cmd help 查看用法）`);
  }
}

// 不立即 process.exit：Node 24 在 Windows 上若 fetch 的连接还在关闭会打印 libuv 断言（async.c），
// 先让事件循环自然结束，1.5 秒后仍有残留句柄再强制退出
const exitSoon = (code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
};
main().then(
  () => exitSoon(0),
  (error) => {
    if (!(error instanceof ExitError)) console.error(error);
    // 双击运行的窗口出错后可能一闪而过，错误同时记到文件里
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, "launcher.log"), `[${new Date().toISOString()}] ${process.argv.slice(2).join(" ")}: ${error?.stack ?? error}
`);
    } catch {
      /* 忽略 */
    }
    exitSoon(1);
  },
);
