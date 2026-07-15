# 跨境电商客服 AI 实训智能体

本仓库严格以两份源需求文档为产品基线。任何功能实现前请先阅读：

- `docs/PRODUCT_BASELINE.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`

## 当前里程碑

- 三角色 React 界面骨架。
- 学生端 5 个规定模块的可交互原型。
- 学生版、教师版 Windows Electron 外壳。
- 8 个场景、20 个画像及其他最低数量要求的领域种子。
- 云端 API 健康检查和性能验收常量。

## 本地运行

使用 Node.js 22.12+ 与 pnpm 11。

### 快速启动（推荐）

双击根目录的 `启动开发环境.cmd`，或在 PowerShell 中执行：

```powershell
.\scripts\start-dev.ps1            # 启动数据库 + API + 前端，并拉起桌面客户端
.\scripts\start-dev.ps1 -NoClient  # 启动服务但不拉起桌面客户端
.\scripts\start-dev.ps1 -Stop      # 停止 API、前端与桌面客户端（数据库容器保留）
```

脚本会自动：检查 node/pnpm/docker → 创建或启动数据库容器（含测试库）→
首次运行时安装依赖 → 在独立窗口启动 API（8787）与前端（5288）→ 健康检查
→ 拉起桌面客户端（Electron）。

学生与教师共用同一个桌面客户端，在登录页内切换「学生登录 / 教师登录」页签。
单独启动客户端：双击根目录 `客户端.cmd`，或执行 `.\scripts\start-client.ps1`
（`-Role teacher` 预选教师页签，`-Demo` 进入界面演示模式）。
管理端仍通过浏览器访问 `http://127.0.0.1:5288/?role=admin`。
以下为手动分步方式。

### 1. 数据库（Docker）

开发环境使用独立容器 `cecs-pg`（Postgres 16，宿主端口 5434）：

```bash
docker run -d --name cecs-pg --restart unless-stopped \
  -e POSTGRES_USER=cecs -e POSTGRES_PASSWORD=cecs_dev_2026 -e POSTGRES_DB=cecs \
  -p 5434:5432 -v cecs-pg-data:/var/lib/postgresql/data postgres:16-alpine
docker exec cecs-pg psql -U cecs -c "create database cecs_test;"   # 集成测试库
```

### 2. 启动服务

```bash
pnpm install
pnpm dev:api   # 云端 API，默认 http://127.0.0.1:8787（自动迁移+种子数据）
pnpm dev       # 前端 portal，默认 http://127.0.0.1:5288
```

首次启动自动创建管理员账号 `admin`（初始密码取环境变量
`ADMIN_INITIAL_PASSWORD`，缺省 `Admin#2026`），首次登录强制改密。
账号链路：管理员创建教师 → 教师建班并批量导入学生 → 教师下发任务 → 学生登录实训。

### 3. LLM 对话服务（测试环境）

在 `apps/api/.env`（已被 gitignore）配置 OpenAI 兼容服务：

```
LLM_BASE_URL=https://api.keliagent.cn
LLM_API_KEY=<你的密钥>
LLM_MODEL=deepseek-v4-pro
```

未配置时会话接口返回 503（生产禁止固定话术降级）。密钥只存服务端，不下发客户端。
注意：keliagent 测试网关冷启动首字延迟可达 10-14 秒，不满足验收红线
（99% 请求 ≤3 秒），正式交付前须更换或调优 Provider。

界面预览（不连服务端的演示模式）：

- 客户端：`.\scripts\start-client.ps1 -Demo`（`-Role teacher` 预选教师页签）
- 管理端（浏览器）：`http://127.0.0.1:5288/?role=admin&demo=1`

去掉 `-Demo` / `demo=1` 即为真实登录（走 `/v1/auth/*`，角色由服务端返回，
登录页签与账号角色不符时会提示切换）。

开发模式下客户端加载 `http://127.0.0.1:5288`（需前端已启动）；
构建前端后也可离线加载构建产物启动：

```bash
pnpm build
pnpm desktop
```

`demo=1` 仅跳过本地界面预览的登录步骤，不提供固定话术或关键词对话降级。生产 AI 会话必须连接服务端 LLM Provider。

