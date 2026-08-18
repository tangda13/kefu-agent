# 部署说明（Web 上线版）

交付形态已改为 **纯 Web 端**：学生、教师、管理三角色均通过浏览器访问，不做客户端。单台服务器 + Docker Compose 一键起。

## 架构

```
浏览器 ──> nginx (web, :80)
              ├── /           前端 SPA（React 构建产物）
              ├── /v1/*       反代 → api:8787（含 SSE 流式对话，已关缓冲）
              ├── /uploads/*  反代 → api:8787（商品图/语音/TTS 缓存）
              └── /health     反代 → api:8787
api (fastify + tsx) ──> db (postgres:16)
```

前端走**同域相对路径**，无跨域；LLM/语音密钥只存服务端 `.env`，不下发浏览器。

## 前置条件

- 一台 Linux 云服务器（建议 4C8G；成本核算见根目录 `token费用及服务器.xlsx`）。
- 已安装 Docker 与 Docker Compose v2（`docker compose version` 可查）。
- 安全组/防火墙放行 80 端口（后续上 HTTPS 放 443）。

## 一、上传代码

任选其一：

```bash
# 方式 A：git（需先配代理，见下文备注）
git clone https://github.com/tangda13/kefu-agent.git

# 方式 B：本地打包上传（免代理，推荐）
#   本机：tar --exclude=node_modules --exclude=dist --exclude=uploads -czf kefu.tar.gz .
#   上传：scp kefu.tar.gz user@服务器IP:/opt/  && 服务器解压
```

> 备注：git clone 直连 github 443 会超时，需在服务器上配 `git config --global http.proxy http://<你的代理>`；无代理环境建议用方式 B。

## 二、配置环境变量

```bash
cd kefu-agent           # 进入项目根目录
cp .env.example .env
vi .env                 # 至少改这三项：
#   JWT_SECRET            ← 必改，≥32 位随机串（泄露可伪造任意账号）
#   ADMIN_INITIAL_PASSWORD← 管理员初始密码
#   LLM_API_KEY           ← keliagent 密钥（后续可换 DeepSeek）
#   TTS_API_KEY           ← 火山引擎密钥
```

## 三、构建并启动

```bash
docker compose up -d --build
docker compose ps       # 应看到 db / api / web 三个服务 running
docker compose logs -f api | head -50   # 确认迁移+种子无报错
```

首次启动会自动执行数据库迁移、写入种子数据（场景/画像/商品/违规词/话术/管理员账号）。

## 四、首次登录与开课

| 角色 | 入口 | 账号 |
|---|---|---|
| 管理端 | `http://服务器IP/?role=admin` | `admin` / 初始密码 |
| 教师端 | `http://服务器IP/` → 登录页切「教师登录」 | 管理端创建 |
| 学生端 | `http://服务器IP/` → 登录页切「学生登录」 | 教师批量导入 |

开课链路：**管理端建教师 → 教师建班并批量导入学生 → 教师下发任务（场景/画像/评分权重）→ 学生登录实训**。管理端可维护 Provider、违规词库、话术库、备份与审计。

## 五、换正式 LLM Provider（TTFT 达标，可选）

当前默认 keliagent 网关，首字约 5.9s 偏慢。拿到 DeepSeek 官方 key 后：

1. 管理端 →「AI 与语音服务」填 `https://api.deepseek.com` + key + `deepseek-chat`（或目标模型）。
2. 保存即热切换（无需重启、无需改代码），再点「运行验收测试(100 次)」复验 TTFT ≤3s。

## 六、HTTPS（建议上线后加）

nginx 已监听 80。上 HTTPS 可用 `certbot --nginx` 或云厂商负载均衡/证书一键配置，证书终止于 nginx，后端无需改动。

## 七、备份与运维

- 管理端「数据与备份」支持手动/定时备份（pg_dump 到容器 volume）。
- 数据卷：`cecs_pg_data`（数据库）、`cecs_uploads`（上传文件），`docker compose down` 不清卷，勿 `down -v` 误删。
- 更新：`git pull`（或重新上传）→ `docker compose up -d --build`。

## 八、常见问题

- **对话不出字/攒很久才一次吐**：nginx 反代 SSE 必须 `proxy_buffering off`，本仓库 nginx.conf 已配，勿删。
- **登录 401 / 页面白屏**：先 `docker compose logs -f api` 看后端；白屏多为前端构建或 `JWT_SECRET` 改动导致旧 token 失效（重登即可）。
- **TTFT 超标**：见第五节换 Provider。
