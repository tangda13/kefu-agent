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

根目录两个入口，双击即可：

| 入口 | 用途 |
|---|---|
| `dev.cmd` | 学生端 / 教师端调试：起数据库、API、前端，并同时打开学生、教师两个客户端（各自独立登录） |
| `admin.cmd` | 管理端调试：在浏览器打开管理端（服务没起时先起服务） |

第一个启动服务的窗口就是**托管窗口**：API 和前端的日志合并显示在这里（每行带 `[api]` / `[web]` 前缀），
按 Ctrl+C 或关闭这个窗口，服务和客户端一起停止。服务已在运行时再双击 `dev.cmd` / `admin.cmd`，
只会打开客户端或浏览器然后自动关闭，不会多开窗口，也不会重复起服务。

```powershell
.\dev.cmd                     # 起服务 + 打开学生、教师客户端
.\dev.cmd start student       # 只开学生客户端（teacher 同理；none = 只起服务）
.\dev.cmd client teacher 2    # 再开一个教师客户端（第 2 个调试档案，可登录另一个账号）
.\dev.cmd restart api         # 通知托管窗口只重启 API（restart portal 同理；不带参数重启全部）
.\dev.cmd status              # 各服务状态 + 当前 LLM 配置
.\dev.cmd logs api            # 新窗口单独看某个服务的日志（日志文件在 .devrun\logs）
.\dev.cmd test                # 构建 + 全部测试
.\dev.cmd eval                # Agent 评测集（脚本扮演学生跑典型场景，真实调用当前模型）；eval full 为完整集
.\dev.cmd stop                # 停止 API、前端、客户端（数据库容器保留），托管窗口自动关闭
.\admin.cmd                   # 打开管理端；admin.cmd status / stop 同 dev.cmd
```

改后端代码自动重启、改前端热更新。日志同时写入 `.devrun\logs\*.log`（上一次的保留为 `*.prev.log`），
启动器自身的错误记在 `.devrun\logs\launcher.log`。脚本实现在 `scripts/dev.mjs`（`dev.cmd help` 看全部用法）。
客户端里 `Ctrl+R` 刷新、`Ctrl+Shift+I` 打开开发者工具。
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

### 3. 模型服务

模型在管理端「AI 与语音服务」里配置：新增档案（选厂商模板，填 Key）→ 测试连通 → 设为默认，
可按用途（买家对话 / 导演评估 / 能力评分 / 话术与生成）分别指定模型和备用档案，保存即生效。
Key 加密存在数据库里，不下发客户端；加密密钥取 `SETTINGS_ENCRYPTION_KEY`，未设置时由 `JWT_SECRET` 派生。

全新数据库首次启动时，如果 `apps/api/.env`（已被 gitignore）里有下面几项，会自动导入为默认档案：

```
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=<你的密钥>
LLM_MODEL=deepseek-flash
LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}
```

没有可用档案时会话接口返回 503（生产禁止固定话术降级）。买家对话建议用关闭思考的快速模型
（DeepSeek flash 关思考首字约 0.5 秒）；keliagent 测试网关首字约 5 秒，不满足验收红线。

界面预览（不连服务端的演示模式）：

- 客户端：`.\dev.cmd start student -Demo`（teacher 同理）
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

