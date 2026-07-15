# 跨境电商客服 AI 实训智能体 - 桌面客户端启动（Electron）
# 学生/教师共用同一客户端，登录页内切换「学生登录/教师登录」页签。
# 用法：
#   .\scripts\start-client.ps1                启动客户端（登录页默认学生页签）
#   .\scripts\start-client.ps1 -Role teacher  预选教师登录页签
#   追加 -Demo 进入界面演示模式
param(
    [ValidateSet("", "student", "teacher")]
    [string]$Role = "",
    [switch]$Demo
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$WebPort = 5288

$Electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $Electron)) {
    Write-Host "未找到 Electron 运行时（node_modules\electron\dist\electron.exe），请先在项目根目录执行 pnpm install。" -ForegroundColor Red
    exit 1
}

$web = Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue
if (-not $web) {
    Write-Host "前端服务（端口 $WebPort）未运行，请先执行 启动开发环境.cmd。" -ForegroundColor Red
    exit 1
}

$env:CECS_DEV_SERVER_URL = "http://127.0.0.1:$WebPort/"
$argList = @((Join-Path $Root "apps\desktop\main.cjs"))
if ($Role) { $argList += "--role=$Role" }
if ($Demo) { $argList += "--demo" }
Start-Process -FilePath $Electron -ArgumentList $argList -WorkingDirectory $Root
Write-Host "已启动桌面客户端（登录页内切换 学生登录/教师登录）" -ForegroundColor Green
