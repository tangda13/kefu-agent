# 部署说明

单台国内云服务器 + Docker Compose 起 db、api、web 三个容器，宿主机 nginx 负责 HTTPS。

- **管理端**：浏览器打开 `https://kefu.keliagent.cn/`。
- **学生端、教师端**：只用 Windows 客户端（参数 4.2）。客户端是外壳，页面从这台服务器加载（D-83）。浏览器打开同一地址只有管理端登录，服务端也会拒绝浏览器登录学生、教师账号。
- **客户端自动更新**：从 `https://kefu.keliagent.cn/updates/` 下载。

## 架构

```
客户端（学生 / 教师） ─┐
浏览器（管理端）     ─┴─ https://kefu.keliagent.cn
                          │
              宿主机 nginx :443（证书、HTTPS，转发到本机 8081）
                          │
              web 容器 nginx :80（宿主机只开 127.0.0.1:8081）
                ├── /            前端页面（客户端和管理端共用；入口页不缓存、带哈希的资源长期缓存）
                ├── /v1/*        → api:8787（含 SSE 流式对话，已关缓冲）
                ├── /uploads/*   → api:8787（商品图 / 语音 / TTS 缓存）
                ├── /library/*   → api:8787（内置商品库图片）
                ├── /health      → api:8787
                └── /updates/*   客户端更新源（宿主机 ./updates 目录）
              api 容器（fastify）──> db 容器（postgres:16）
```

页面和接口同源，不需要跨域。模型、语音的密钥只存服务端，不下发给客户端。

## 一、买服务器和准备

| 项 | 要求 |
|---|---|
| 服务器 | 阿里云 ECS，2 核 4G 起（不要突发性能实例 t5/t6；4G 内存要加交换文件，见第二节）；Ubuntu 24.04 或 26.04 64 位；ESSD 100G 左右；按使用流量计费、峰值 100M；打开自动快照 |
| 登录 | 密钥对，用户名 `ecs-user`；私钥放 `C:\Users\22639\Desktop\私密\` |
| 安全组 | 只开 22、80、443 |
| 域名 | 阿里云云解析给 `kefu.keliagent.cn` 加 A 记录指向服务器公网 IP（D-82）；keliagent.cn 已在阿里云备案，同账号新服务器不用重新备案 |

## 二、装 Docker 和镜像加速器

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
# 4G 内存的服务器加 4G 交换文件，构建镜像时用得上
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "live-restore": true,
  "registry-mirrors": ["https://docker.m.daocloud.io", "https://dockerproxy.net", "https://mirror.ccs.tencentyun.com"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
sudo docker pull node:24-alpine   # 能拉下来再继续
```

阿里云服务器也可以在「容器镜像服务」控制台开官方加速器，地址更稳。

## 三、上传代码

```bash
# 本机（项目根目录）：从 git 打包已提交的代码（不含依赖、构建产物、运行时数据和密钥）
git -c core.autocrlf=false archive --format=tar.gz -o kefu.tar.gz HEAD -- . ':(exclude)docs' ':(exclude)*.docx' ':(exclude)*.xlsx' ':(exclude)*.pdf'
scp -i <私钥> kefu.tar.gz ecs-user@<服务器IP>:/tmp/
# 服务器
mkdir -p ~/cecs/updates && cd ~/cecs && tar xzf /tmp/kefu.tar.gz
```

服务器直连 GitHub 很慢，不建议在服务器上 `git clone`。**不要直接 tar Windows 上的工作区**：文件是 CRLF 换行，`.env` 的值末尾会多一个回车符，开关和镜像源地址都会失效；`core.autocrlf=false` 让打出来的包保持仓库里的 LF。

## 四、配置环境变量

```bash
cd ~/cecs && cp .env.example .env && vi .env
```

| 变量 | 说明 |
|---|---|
| `JWT_SECRET` | **必改**，≥32 位随机串（`openssl rand -hex 32`）。泄露可伪造任意账号 |
| `SETTINGS_ENCRYPTION_KEY` | **建议设**，≥32 位随机串。加密存库的模型、语音密钥；不设则由 `JWT_SECRET` 派生，以后换 `JWT_SECRET` 所有密钥都要重填 |
| `POSTGRES_PASSWORD` | 改成随机串 |
| `ADMIN_INITIAL_PASSWORD` | 管理员初始密码，首次登录强制改 |
| `CORS_ORIGINS` | 留空（生产不放行任何跨域） |
| `DESKTOP_ONLY` | 留空（生产默认只让客户端登录学生、教师）。临时要在浏览器里验收学生端、教师端时设 `false`，验收完删掉 |
| `NPM_REGISTRY`、`ALPINE_MIRROR` | 保留默认的国内源，构建快很多 |
| `LLM_*`、`TTS_*` | 可留空，模型和语音都在管理端「AI 与语音服务」里配 |

**`.env` 整份另存一份到本机安全位置**：`JWT_SECRET`、`SETTINGS_ENCRYPTION_KEY`、`POSTGRES_PASSWORD` 丢了，迁移或重建时会登录全部失效、库里的密钥解不开。

## 五、构建并启动

```bash
cd ~/cecs
echo '{ "minVersion": "1.0.0" }' > updates/policy.json
sudo docker compose up -d --build
sudo docker compose ps                       # db / api / web 都在运行
sudo docker compose logs api | tail -50      # 确认迁移和种子数据没有报错
curl -s http://127.0.0.1:8081/health         # 返回 {"status":"ok",...}
```

首次启动会自动建表、写种子数据（场景、画像、商品、违规词、话术、管理员账号）。

## 六、HTTPS（宿主机 nginx + Let's Encrypt）

客户端默认连 `https://kefu.keliagent.cn/`，必须先配好证书。

```bash
sudo tee /etc/nginx/sites-available/kefu >/dev/null <<'EOF'
server {
    listen 80;
    server_name kefu.keliagent.cn;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # web 容器从这里取真实来源 IP（登录按 IP 限流靠它），必须覆盖，不能追加
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        # SSE 流式对话：关缓冲，否则 AI 回复会攒满才一次吐出来
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/kefu /etc/nginx/sites-enabled/kefu
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kefu.keliagent.cn --redirect   # 申请证书、加 443、80 跳转 443，自动续期
curl -s https://kefu.keliagent.cn/health
```

certbot 会把 `location /` 原样复制到 443 的 server 块里。申请完用 `sudo nginx -T | grep -A3 proxy_buffering` 确认 443 块里也有 `proxy_buffering off`。

## 七、首次登录与开课

1. 浏览器打开 `https://kefu.keliagent.cn/`，用 `admin` 和初始密码登录，按提示改密码。
2. 管理端「AI 与语音服务」：填模型档案（Flow 生产令牌、DeepSeek 官方）、语音（阿里云百炼、豆包）的密钥，逐个「保存并测试」。
3. 管理端建教师账号 → 教师在客户端建班、导入学生、下发任务 → 学生在客户端实训。

## 八、客户端安装包和自动更新

- 安装包和自动更新文件由我方发版时提供（打包命令：项目根目录 `node scripts/pack-client.mjs`，产物在 `apps/desktop/dist/`）。放到服务器上的要点如下。
- **上传顺序**：先把 `cecs-client-setup-<版本>.exe`、`.exe.blockmap` 传到 `~/cecs/updates/`，**最后**传 `latest.yml`。旧版本的 `.blockmap` 留着：客户端靠新旧两个 blockmap 只下载变了的部分（实测 0.1.0→0.1.1 只下了约 0.7MB）。
- **强制更新**：`updates/policy.json` 里的 `minVersion` 高于客户端版本时，客户端必须更新才能用；平时保持当前最低可用版本。
- **只改了页面**：重新构建 web 容器即可（第十节），不用发客户端。
- **服务器换了地址**：改 `apps/desktop/config.json` 的 `serverUrl`，发一个新版本客户端，放到旧服务器的 `updates/`，客户端自动升级后就连新服务器。个别机器临时改：在 `%APPDATA%\cecs-client\config.json` 写 `{ "serverUrl": "https://新地址/" }`，升级不会覆盖它。

## 九、配置模型并跑性能验收（在这台服务器上测，D-79）

1. 管理端「AI 与语音服务」：新增 DeepSeek 官方档案并设为默认（正式验收用官方直连，D-24）。
2. 系统总览：点「运行 100 次验收」，看首字 3 秒内 ≥99%、10 秒内 100%，再「导出明细」留证。
3. 200 账号压测：用脚本直接调接口。学生账号登录请求的 User-Agent 要带 `CecsDesktop/0.1.0`（或临时设 `DESKTOP_ONLY=false`），否则会被当成浏览器拒绝。

## 十、备份与运维

- 管理端「数据与备份」支持手动和定时备份：api 镜像里装了 pg_dump（PostgreSQL 16），备份写到 `cecs_backups` 卷；“每天几点”按北京时间（容器 `TZ=Asia/Shanghai`），选夜里没人上课的时段。
- 数据卷：`cecs_pg_data`（数据库）、`cecs_uploads`（上传文件）、`cecs_backups`（备份）。`docker compose down` 不会清卷，**不要用 `down -v`**。
- 备份文件位置：`sudo docker volume inspect cecs_cecs_backups` 看 Mountpoint，也可以在管理端直接下载。
- 恢复（先停 api，恢复进一个空库）：
  ```bash
  sudo docker compose stop api
  sudo docker compose exec -T db psql -U cecs -d postgres -c "drop database cecs" -c "create database cecs owner cecs"
  sudo docker compose exec -T db psql -U cecs -d cecs < backup-xxxx.sql
  sudo docker compose start api
  ```
- 更新服务端：先在管理端「数据与备份」手动备份一次 → 重新上传代码（第三节，`.env` 和 `updates/` 不会被覆盖）→ `sudo docker compose up -d --build`。数据库迁移在 api 启动时自动执行，出问题用刚才的备份按上面的步骤恢复。

## 十一、常见问题

- **对话不出字或攒很久才一次吐**：宿主机 nginx 和 web 容器 nginx 都要 `proxy_buffering off`。
- **客户端显示“连接不上服务器”**：先在服务器上 `curl -s http://127.0.0.1:8081/health`。通了就查宿主机 nginx、证书和安全组；不通就查 `docker compose ps`。
- **学生在浏览器里登录提示“学生账号请在客户端登录”**：这是生产环境的正常行为。
- **整个机房都提示“登录失败次数过多”**：同一个 IP 15 分钟内失败 100 次会锁 15 分钟。确认宿主机 nginx 写了 `X-Real-IP $remote_addr`，否则所有人都算成同一个 IP。
- **登录 401、页面白屏**：`sudo docker compose logs -f api` 看后端。改过 `JWT_SECRET` 会让旧登录失效，重新登录即可。
- **首字超标**：见第九节，换档案或换厂商。
