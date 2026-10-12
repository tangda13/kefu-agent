# 跨境电商客服 AI 实训智能体 - 开发调试入口（学生端 / 教师端客户端）
#
# 用法（在项目根目录，或直接双击 dev.cmd）：
#   dev.cmd                      启动数据库、API、前端，并打开学生、教师两个客户端（登录态互不影响）
#   dev.cmd start student        只打开学生客户端（teacher 同理；none 表示只起服务不开客户端）
#   dev.cmd client teacher 2     再开一个教师客户端（第 2 个调试档案，可同时登录另一个教师账号）
#   dev.cmd restart [api|portal] 重启全部服务，或只重启 API / 前端
#   dev.cmd stop                 停止 API、前端和所有客户端（数据库容器保留）
#   dev.cmd status               查看各服务状态、当前 LLM 配置
#   dev.cmd logs [api|portal]    新窗口实时查看日志（默认 api）
#   dev.cmd test                 构建 + 全部测试
#   追加 -Demo                   客户端进入界面演示模式（不连后端数据）
#
# 管理端请用 admin.cmd。
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "restart", "status", "logs", "client", "test", "help")]
    [string]$Action = "start",
    [Parameter(Position = 1)]
    [string]$Target = "",
    [Parameter(Position = 2)]
    [int]$Index = 1,
    [switch]$Demo
)

. (Join-Path $PSScriptRoot "dev-common.ps1")

function Open-Clients($which) {
    $roles = switch ($which) {
        "" { @("student", "teacher") }
        "both" { @("student", "teacher") }
        "student" { @("student") }
        "teacher" { @("teacher") }
        "none" { @() }
        default { Write-Fail "未知客户端类型：$which（可选 student / teacher / both / none）"; exit 1 }
    }
    if ($roles.Count -eq 0) { return }
    Write-Step "打开客户端"
    foreach ($role in $roles) { Start-Client $role 1 -Demo:$Demo }
}

function Show-Summary {
    Write-Host ""
    Write-Host "================= 开发环境已就绪 =================" -ForegroundColor Green
    Write-Host "  API      $ApiUrl  （改后端代码自动重启，日志见 CECS-API 窗口）"
    Write-Host "  前端     $WebUrl  （改前端代码热更新，客户端里 Ctrl+R 强制刷新，Ctrl+Shift+I 开发者工具）"
    Write-Host "  管理端   admin.cmd"
    Write-Host "  常用     dev.cmd status | restart api | logs | client teacher 2 | stop"
    Show-Accounts
    Write-Host "===================================================" -ForegroundColor Green
}

switch ($Action) {
    "start" {
        Start-Services
        Open-Clients $Target
        Show-Summary
    }
    "client" {
        if ($Target -notin @("student", "teacher")) { Write-Fail "用法：dev.cmd client student|teacher [序号]"; exit 1 }
        Start-Client $Target $Index -Demo:$Demo
    }
    "stop" {
        Write-Step "停止开发服务（保留数据库容器 $Container）"
        Stop-Clients
        Stop-ServiceByName "api" $ApiPort "API"
        Stop-ServiceByName "portal" $WebPort "前端"
    }
    "restart" {
        switch ($Target) {
            "api" { Stop-ServiceByName "api" $ApiPort "API"; Start-Api }
            "portal" { Stop-ServiceByName "portal" $WebPort "前端"; Start-Portal }
            "" {
                Stop-ServiceByName "api" $ApiPort "API"
                Stop-ServiceByName "portal" $WebPort "前端"
                Start-Services
            }
            default { Write-Fail "用法：dev.cmd restart [api|portal]"; exit 1 }
        }
    }
    "status" { Show-Status }
    "logs" {
        $name = if ($Target) { $Target } else { "api" }
        if ($name -notin @("api", "portal")) { Write-Fail "用法：dev.cmd logs [api|portal]"; exit 1 }
        $log = Join-Path $LogDir "$name.log"
        if (-not (Test-Path $log)) { Write-Fail "还没有日志：$log（服务需由 dev.cmd / admin.cmd 启动）"; exit 1 }
        $inner = "`$Host.UI.RawUI.WindowTitle = 'CECS 日志 · $name'; Get-Content -LiteralPath '$log' -Tail 200 -Wait -Encoding utf8"
        Start-Process -FilePath $Shell -ArgumentList @("-NoExit", "-NoProfile", "-Command", $inner) | Out-Null
        Write-Ok "已在新窗口打开 $log"
    }
    "test" {
        Write-Step "构建 + 全部测试（集成测试使用 cecs_test 库，不动开发库）"
        Ensure-Database
        Push-Location $Root
        $env:CI = "true"
        pnpm build
        if ($LASTEXITCODE -eq 0) { pnpm test }
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -eq 0) { Write-Ok "构建与测试全部通过" } else { Write-Fail "失败，见上方输出" }
        exit $code
    }
    "help" { Get-Content $PSCommandPath -TotalCount 15 | ForEach-Object { $_ -replace '^# ?', '' } }
}
