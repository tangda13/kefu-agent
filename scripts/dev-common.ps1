# 跨境电商客服 AI 实训智能体 - 开发调试公共函数（被 dev.ps1 / admin.ps1 引用，不单独运行）
#
# 服务各开一个带标题的窗口，实时输出日志，同时写入 .devrun\logs\*.log（上一次的日志保留为 *.prev.log）。
# 窗口进程号记录在 .devrun\pids.json，停止时按记录关窗口；记录丢失时再按端口兜底。

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Script:Root = Split-Path -Parent $PSScriptRoot
$Script:ApiPort = 8787
$Script:WebPort = 5288   # 本项目专属端口，勿改回 5173（被智慧物流实训智能体占用）
$Script:PgPort = 5434
$Script:Container = "cecs-pg"
$Script:RunDir = Join-Path $Root ".devrun"
$Script:LogDir = Join-Path $RunDir "logs"
$Script:PidFile = Join-Path $RunDir "pids.json"
$Script:ApiUrl = "http://127.0.0.1:$ApiPort"
$Script:WebUrl = "http://127.0.0.1:$WebPort"
$Script:Electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
$Script:Shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "    $text" -ForegroundColor Red }

function Get-PortPid($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Read-Pids {
    if (Test-Path $PidFile) {
        try {
            # 不用 -AsHashtable：Windows 自带的 PowerShell 5.1 不支持
            $table = @{}
            (Get-Content $PidFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $table[$_.Name] = [int]$_.Value }
            return $table
        } catch {}
    }
    return @{}
}

function Save-Pid($name, $procId) {
    New-Item -ItemType Directory -Force $RunDir | Out-Null
    $pids = Read-Pids
    if ($procId) { $pids[$name] = $procId } else { $pids.Remove($name) }
    $pids | ConvertTo-Json | Set-Content $PidFile -Encoding utf8
}

function Test-Http($url) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Wait-Http($url, $timeoutSec = 60) {
    for ($i = 0; $i -lt $timeoutSec; $i++) {
        if (Test-Http $url) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

# ---------- 前置检查 ----------

function Assert-Prerequisites {
    Write-Step "检查前置依赖"
    foreach ($tool in @("node", "pnpm", "docker")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Write-Fail "缺少 $tool，请先安装后重试。"
            exit 1
        }
    }
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Docker Desktop 未运行：请先打开 Docker Desktop，等左下角显示 Engine running 后再试。"
        exit 1
    }
    Write-Ok "node / pnpm / docker 就绪"
}

# 服务都没在跑时同步一次依赖（已是最新则 1–2 秒结束）；有服务在跑时跳过，避免和它们抢 node_modules
function Ensure-Dependencies {
    if ((Get-PortPid $ApiPort) -or (Get-PortPid $WebPort)) { return }
    Write-Step "同步依赖（pnpm install）"
    Write-Host "    若超过 2 分钟没有进展：关掉本窗口，删除项目里所有 node_modules 目录后重试" -ForegroundColor DarkGray
    Push-Location $Root
    $env:CI = "true"
    pnpm install --reporter=append-only | Select-Object -Last 2 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Fail "依赖安装失败，见上方输出（常见原因见 kefu-weihu 踩坑表）。"; exit 1 }
    Ensure-Electron
}

function Ensure-Electron {
    if (Test-Path $Electron) { return }
    Write-Step "下载 Electron 运行时（npmmirror 镜像，约 100MB）…"
    Push-Location $Root
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    node node_modules/electron/install.js
    Pop-Location
    if (-not (Test-Path $Electron)) { Write-Fail "Electron 运行时下载失败，请检查网络后重试。"; exit 1 }
    Write-Ok "Electron 运行时已就绪"
}

# ---------- 数据库 ----------

function Ensure-Database {
    Write-Step "数据库容器 $Container（Postgres 16 @ $PgPort）"
    $exists = docker ps -a --filter "name=^$Container$" --format "{{.Names}}"
    if (-not $exists) {
        Write-Warn2 "容器不存在，正在创建…"
        docker run -d --name $Container --restart unless-stopped `
            -e POSTGRES_USER=cecs -e POSTGRES_PASSWORD=cecs_dev_2026 -e POSTGRES_DB=cecs `
            -p "${PgPort}:5432" -v cecs-pg-data:/var/lib/postgresql/data postgres:16-alpine | Out-Null
    } elseif (-not (docker ps --filter "name=^$Container$" --format "{{.Names}}")) {
        Write-Warn2 "容器已停止，正在启动…"
        docker start $Container | Out-Null
    }
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        docker exec $Container pg_isready -U cecs 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { Write-Fail "数据库 30 秒内未就绪，查看容器日志：docker logs $Container"; exit 1 }
    $hasTestDb = docker exec $Container psql -U cecs -tAc "select 1 from pg_database where datname='cecs_test'" 2>$null
    if ("$hasTestDb".Trim() -ne "1") {
        docker exec $Container psql -U cecs -c "create database cecs_test;" | Out-Null
        Write-Ok "已创建集成测试库 cecs_test"
    }
    Write-Ok "数据库就绪"
}

# ---------- API / 前端服务 ----------

# 服务窗口直接用 node 跑 tsx / vite，不经过 pnpm：pnpm 11 运行脚本前会做依赖检查，
# 发现 package.json 变了就在窗口里自动重装，而另一个服务正占着 node_modules，重装会卡死（2026-10-12 实测）。
# 依赖安装统一在启动服务之前由 Ensure-Dependencies 完成。
function Start-ServiceWindow($name, $title, $workDir, $command, $logName) {
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    $log = Join-Path $LogDir "$logName.log"
    if (Test-Path $log) { Move-Item $log (Join-Path $LogDir "$logName.prev.log") -Force }
    # 子进程输出按 UTF-8 解码，否则中文和符号在窗口和日志里都会乱码
    $inner = "`$Host.UI.RawUI.WindowTitle = '$title'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; `$OutputEncoding = [Text.Encoding]::UTF8; " +
        "Set-Location -LiteralPath '$workDir'; `$env:LOG_PRETTY = '1'; `$env:FORCE_COLOR = '0'; Remove-Item Env:TZ -ErrorAction SilentlyContinue; " +
        "Write-Host '[$title] 日志同时写入 $log' -ForegroundColor DarkGray; " +
        "$command 2>&1 | Tee-Object -FilePath '$log' -Append"
    $proc = Start-Process -FilePath $Shell -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $inner) -PassThru
    Save-Pid $name $proc.Id
}

function Start-Api {
    Write-Step "云端 API（$ApiUrl，tsx watch 改代码自动重启）"
    if (Get-PortPid $ApiPort) {
        if (Test-Http "$ApiUrl/health") { Write-Ok "已在运行"; return }
        Write-Fail "端口 $ApiPort 被占用但健康检查不通过，先执行 dev.cmd stop 再试。"
        exit 1
    }
    Start-ServiceWindow "api" "CECS-API :$ApiPort" (Join-Path $Root "apps\api") "node '$Root\node_modules\tsx\dist\cli.mjs' watch src/server.ts" "api"
    if (Wait-Http "$ApiUrl/health" 60) { Write-Ok "健康检查通过" }
    else { Write-Fail "API 60 秒内未就绪，看 CECS-API 窗口或 .devrun\logs\api.log（常见：数据库没起、.env 配置错误、端口被占）"; exit 1 }
}

function Start-Portal {
    Write-Step "前端 portal（$WebUrl，Vite 热更新）"
    if (Get-PortPid $WebPort) {
        if (Test-Http "$WebUrl/") { Write-Ok "已在运行"; return }
        Write-Fail "端口 $WebPort 被占用但页面打不开，先执行 dev.cmd stop 再试。"
        exit 1
    }
    Start-ServiceWindow "portal" "CECS-Portal :$WebPort" (Join-Path $Root "apps\portal") "node '$Root\node_modules\vite\bin\vite.js'" "portal"
    if (Wait-Http "$WebUrl/" 60) { Write-Ok "前端已就绪" }
    else { Write-Fail "前端 60 秒内未就绪，看 CECS-Portal 窗口或 .devrun\logs\portal.log"; exit 1 }
}

function Start-Services {
    Assert-Prerequisites
    Ensure-Database
    Ensure-Dependencies
    Start-Api
    Start-Portal
}

function Stop-ServiceByName($name, $port, $label) {
    $pids = Read-Pids
    $stopped = $false
    if ($pids.ContainsKey($name)) {
        $procId = $pids[$name]
        if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
            taskkill /PID $procId /T /F 2>$null | Out-Null
            $stopped = $true
        }
        Save-Pid $name $null
    }
    # 兜底：记录丢失（例如服务是手动起的）时按端口找 node 进程
    $portPid = Get-PortPid $port
    if ($portPid) {
        $procName = (Get-Process -Id $portPid -ErrorAction SilentlyContinue).ProcessName
        if ($procName -match "node") {
            taskkill /PID $portPid /T /F 2>$null | Out-Null
            $stopped = $true
        } else {
            Write-Warn2 "端口 $port 被非 node 进程 [$procName] 占用，未处理"
        }
    }
    if ($stopped) { Write-Ok "$label 已停止" } else { Write-Ok "$label 未在运行" }
}

# ---------- 客户端 ----------

function Get-ClientProcesses {
    Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$Root*" }
}

function Start-Client($role, $index = 1, [switch]$Demo) {
    Ensure-Electron
    if (-not (Test-Http "$WebUrl/")) { Write-Fail "前端未运行，先执行 dev.cmd"; exit 1 }
    $profileName = if ($index -gt 1) { "$role$index" } else { $role }
    $env:CECS_DEV_SERVER_URL = "$WebUrl/"
    $argList = @((Join-Path $Root "apps\desktop\main.cjs"), "--role=$role", "--profile=$profileName")
    if ($Demo) { $argList += "--demo" }
    Start-Process -FilePath $Electron -ArgumentList $argList -WorkingDirectory $Root | Out-Null
    $label = @{ student = "学生"; teacher = "教师" }[$role]
    Write-Ok "已打开${label}客户端（调试档案 $profileName，登录态与其他窗口互不影响）"
}

function Stop-Clients {
    $clients = Get-ClientProcesses
    if ($clients) {
        $clients | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Ok "客户端已全部关闭"
    } else {
        Write-Ok "客户端未在运行"
    }
}

# ---------- 状态 ----------

function Show-Status {
    Write-Step "开发环境状态"
    $db = docker ps --filter "name=^$Container$" --format "{{.Status}}" 2>$null
    if ($db) { Write-Ok ("数据库   运行中（{0}）" -f $db) } else { Write-Warn2 "数据库   未运行" }
    if (Test-Http "$ApiUrl/health") { Write-Ok "API      运行中  $ApiUrl" } else { Write-Warn2 "API      未运行" }
    if (Test-Http "$WebUrl/") { Write-Ok "前端     运行中  $WebUrl" } else { Write-Warn2 "前端     未运行" }
    $clients = @(Get-ClientProcesses | Where-Object { $_.MainWindowHandle -ne 0 })
    Write-Ok ("客户端   {0} 个窗口{1}" -f $clients.Count, $(if ($clients.Count) { "：" + (($clients | ForEach-Object { $_.MainWindowTitle -replace '.*调试', '' }) -join " ") } else { "" }))
    # 当前 LLM：管理端保存过以数据库为准，否则用 apps/api/.env（不显示密钥）
    $llm = $null
    if ($db) { $llm = docker exec $Container psql -U cecs -tAc "select (value->>'model') || ' @ ' || (value->>'baseUrl') from app_settings where key='llm'" 2>$null }
    if ("$llm".Trim()) {
        Write-Ok ("LLM      {0}（管理端配置）" -f "$llm".Trim())
    } else {
        $envFile = Join-Path $Root "apps\api\.env"
        if (Test-Path $envFile) {
            $vars = @{}
            Get-Content $envFile | Where-Object { $_ -match '^\s*(LLM_MODEL|LLM_BASE_URL)\s*=\s*(.*)$' } | ForEach-Object { $vars[$Matches[1]] = $Matches[2].Trim() }
            Write-Ok ("LLM      {0} @ {1}（apps/api/.env）" -f $vars["LLM_MODEL"], $vars["LLM_BASE_URL"])
        } else {
            Write-Warn2 "LLM      未配置（缺 apps/api/.env）"
        }
    }
    Write-Ok "日志     $LogDir"
}

function Show-Accounts {
    Write-Host ""
    Write-Host "  开发库账号  管理员 admin / Admin#Prod2026（新库为 Admin#2026，首登强制改密）"
    Write-Host "              教师 wang.teacher / Teach#2026    学生 s2601001 / Student#01 · s2601002 / Student#02"
    Write-Host "  忘记密码    pnpm --filter @cecs/api reset-password <账号>"
}
