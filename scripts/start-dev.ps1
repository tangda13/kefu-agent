# 跨境电商客服 AI 实训智能体 - 开发环境一键启动
# 用法：
#   .\scripts\start-dev.ps1            启动全部服务（数据库/API/前端），并拉起桌面客户端（学生/教师共用）
#   .\scripts\start-dev.ps1 -Stop     停止 API、前端与桌面客户端（数据库容器保留）
#   .\scripts\start-dev.ps1 -NoClient  启动服务但不拉起桌面客户端（-NoBrowser 为兼容别名）
param(
    [switch]$Stop,
    [switch]$NoBrowser,
    [switch]$NoClient
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$ApiPort = 8787
$WebPort = 5288   # 本项目专属端口，勿改回 5173（被智慧物流实训智能体占用）
$PgPort = 5434
$Container = "cecs-pg"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Get-PortPid($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

if ($Stop) {
    Write-Step "停止开发服务（保留数据库容器 $Container）"
    $clients = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$Root*" }
    if ($clients) {
        $clients | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Ok "桌面客户端已关闭"
    } else {
        Write-Ok "桌面客户端未在运行"
    }
    foreach ($item in @(@{Name = "API"; Port = $ApiPort }, @{Name = "前端"; Port = $WebPort })) {
        $procId = Get-PortPid $item.Port
        if ($procId) {
            $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
            if ($name -match "node") {
                taskkill /PID $procId /T /F | Out-Null
                Write-Ok "$($item.Name)（端口 $($item.Port)，PID $procId）已停止"
            } else {
                Write-Warn2 "端口 $($item.Port) 被非 node 进程 [$name] 占用，未处理"
            }
        } else {
            Write-Ok "$($item.Name)（端口 $($item.Port)）未在运行"
        }
    }
    exit 0
}

# ---------- 1. 前置检查 ----------
Write-Step "检查前置依赖"
foreach ($tool in @("node", "pnpm", "docker")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "缺少 $tool，请先安装后重试。" -ForegroundColor Red
        exit 1
    }
}
try { docker info 2>$null | Out-Null } catch {}
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop 未运行，请先启动 Docker Desktop。" -ForegroundColor Red
    exit 1
}
Write-Ok "node / pnpm / docker 就绪"

# ---------- 2. 数据库容器 ----------
Write-Step "检查数据库容器 $Container（Postgres 16 @ $PgPort）"
$exists = docker ps -a --filter "name=^$Container$" --format "{{.Names}}"
if (-not $exists) {
    Write-Warn2 "容器不存在，正在创建…"
    docker run -d --name $Container --restart unless-stopped `
        -e POSTGRES_USER=cecs -e POSTGRES_PASSWORD=cecs_dev_2026 -e POSTGRES_DB=cecs `
        -p "${PgPort}:5432" -v cecs-pg-data:/var/lib/postgresql/data postgres:16-alpine | Out-Null
} else {
    $running = docker ps --filter "name=^$Container$" --format "{{.Names}}"
    if (-not $running) {
        Write-Warn2 "容器已停止，正在启动…"
        docker start $Container | Out-Null
    }
}
# 等待数据库就绪
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    docker exec $Container pg_isready -U cecs 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Write-Host "数据库 30 秒内未就绪，请检查容器日志：docker logs $Container" -ForegroundColor Red; exit 1 }
# 确保测试库存在
$hasTestDb = docker exec $Container psql -U cecs -tAc "select 1 from pg_database where datname='cecs_test'" 2>$null
if ("$hasTestDb".Trim() -ne "1") {
    docker exec $Container psql -U cecs -c "create database cecs_test;" | Out-Null
    Write-Ok "已创建集成测试库 cecs_test"
}
Write-Ok "数据库就绪"

# ---------- 3. 依赖安装 ----------
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Step "首次运行，安装依赖（pnpm install）…"
    Push-Location $Root
    pnpm install
    Pop-Location
}

# ---------- 4. 启动服务 ----------
function Start-DevWindow($title, $command) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$Root`" && title $title && $command" -WindowStyle Normal
}

function Wait-Http($url, $name, $timeoutSec = 60) {
    for ($i = 0; $i -lt $timeoutSec; $i++) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -eq 200) { return $true }
        } catch { Start-Sleep -Seconds 1 }
    }
    Write-Warn2 "$name 在 $timeoutSec 秒内未响应（$url），请查看对应窗口日志"
    return $false
}

Write-Step "启动云端 API（端口 $ApiPort）"
if (Get-PortPid $ApiPort) {
    Write-Ok "端口 $ApiPort 已有服务，跳过启动"
} else {
    Start-DevWindow "CECS-API" "pnpm dev:api"
    if (Wait-Http "http://127.0.0.1:$ApiPort/health" "API") { Write-Ok "API 健康检查通过" }
}

Write-Step "启动前端 portal（端口 $WebPort）"
if (Get-PortPid $WebPort) {
    Write-Ok "端口 $WebPort 已有服务，跳过启动"
} else {
    Start-DevWindow "CECS-Portal" "pnpm dev"
    if (Wait-Http "http://127.0.0.1:$WebPort/" "前端") { Write-Ok "前端已就绪" }
}

# ---------- 5. 桌面客户端 ----------
if (-not ($NoClient -or $NoBrowser)) {
    Write-Step "启动桌面客户端（学生/教师共用，登录页内切换身份）"
    & (Join-Path $PSScriptRoot "start-client.ps1")
}

# ---------- 6. 汇总 ----------
Write-Host ""
Write-Host "================= 开发环境已就绪 =================" -ForegroundColor Green
Write-Host "  学生/教师客户端:   客户端.cmd（登录页内切换 学生登录/教师登录）"
Write-Host "  管理端(浏览器):    http://127.0.0.1:$WebPort/?role=admin"
Write-Host "  界面演示模式:      客户端脚本追加 -Demo；浏览器地址追加 &demo=1"
Write-Host "  API 健康检查:      http://127.0.0.1:$ApiPort/health"
Write-Host ""
Write-Host "  初始管理员: admin / Admin#2026（首登强制改密，若已改密以新密码为准）"
Write-Host "  停止服务:   .\scripts\start-dev.ps1 -Stop"
Write-Host "===================================================" -ForegroundColor Green
