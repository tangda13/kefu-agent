# 部署说明（服务端）

本文件讲服务端部署：单台服务器 + Docker Compose 起 db、api、web 三个容器。学生端、教师端最终以 Windows 客户端交付（D-11），客户端打包和“学生 / 教师只能用客户端访问”放在 R 发版阶段；在那之前浏览器也能打开三端，方便部署后做验收和压测。

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

## 一·五、配置 Docker 镜像加速器（国内服务器必须）

直连 `docker.io` 会超时拉不动镜像，先配加速器（任选其一，配完 `sudo systemctl restart docker`）：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.net",
    "https://mirror.ccs.tencentyun.com"
  ]
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
docker pull node:22-alpine   # 验证能拉，再继续
```

> 阿里云/腾讯云服务器可在各自控制台「容器镜像服务」一键开启官方加速器，地址更稳。

构建镜像时还要下载 npm 包和 Alpine 软件包，国内直连官方源很慢。`.env.example` 里已经默认填了 `NPM_REGISTRY=https://registry.npmmirror.com`、`ALPINE_MIRROR=https://mirrors.aliyun.com`，复制成 `.env` 后保留即可；海外服务器把这两行删掉。

## 二、配置环境变量

```bash
cd kefu-agent           # 进入项目根目录
cp .env.example .env
vi .env                 # 至少改这三项：
#   JWT_SECRET            ← 必改，≥32 位随机串（泄露可伪造任意账号）
#   ADMIN_INITIAL_PASSWORD← 管理员初始密码
#   LLM_*、TTS_*          ← 可留空：模型和语音都在管理端「AI 与语音服务」里配置
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

## 五、配置模型并跑性能验收

1. 管理端 →「AI 与语音服务」→ 新增模型，选 DeepSeek 官方模板填 key，测试通过后设为默认（正式验收用官方直连，D-24）。
2. 系统总览 →「运行 100 次验收」，看首字 3 秒内 ≥99%、10 秒内 100%；「导出明细」留证。首字和压测都以这台服务器上的结果为准（D-79）。

## 六、HTTPS（建议上线后加）

nginx 已监听 80。上 HTTPS 可用 `certbot --nginx` 或云厂商负载均衡/证书一键配置，证书终止于 nginx，后端无需改动。

## 七、备份与运维

- 管理端「数据与备份」支持手动 / 定时备份：api 镜像里装了 pg_dump（PostgreSQL 16 客户端），备份文件写到 `cecs_backups` 卷。定时备份的“每天几点”按北京时间（容器 `TZ=Asia/Shanghai`），选夜里没人上课的时段。
- 数据卷：`cecs_pg_data`（数据库）、`cecs_uploads`（上传文件）、`cecs_backups`（备份文件），`docker compose down` 不清卷，**不要 `down -v`**。
- 备份文件在服务器上的位置：`docker volume inspect cecs_cecs_backups` 看 Mountpoint，也可以在管理端直接下载。
- 恢复（先停 api，恢复进一个空库）：
  ```bash
  docker compose stop api
  docker compose exec -T db psql -U cecs -d postgres -c "drop database cecs" -c "create database cecs owner cecs"
  docker compose exec -T db psql -U cecs -d cecs < backup-xxxx.sql
  docker compose start api
  ```
- 更新：`git pull`（或重新上传）→ `docker compose up -d --build`。

## 八、常见问题

- **对话不出字/攒很久才一次吐**：nginx 反代 SSE 必须 `proxy_buffering off`，本仓库 nginx.conf 已配，勿删。
- **登录 401 / 页面白屏**：先 `docker compose logs -f api` 看后端；白屏多为前端构建或 `JWT_SECRET` 改动导致旧 token 失效（重登即可）。
- **TTFT 超标**：见第五节换 Provider。
