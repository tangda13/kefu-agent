# 跨境电商客服 AI 实训智能体 - 管理端调试入口（浏览器）
#
# 用法（在项目根目录，或直接双击 admin.cmd）：
#   admin.cmd            确保数据库、API、前端已启动，然后在默认浏览器打开管理端
#   admin.cmd status     查看各服务状态、当前 LLM 配置
#   admin.cmd stop       停止 API 和前端（与 dev.cmd 共用服务，学生/教师客户端也会断开）
#
# 学生端 / 教师端客户端请用 dev.cmd；两者可以同时开着。
param(
    [Parameter(Position = 0)]
    [ValidateSet("open", "status", "stop", "help")]
    [string]$Action = "open"
)

. (Join-Path $PSScriptRoot "dev-common.ps1")

switch ($Action) {
    "open" {
        Start-Services
        $url = "$WebUrl/?role=admin"
        Write-Step "打开管理端 $url"
        Start-Process $url
        Write-Host ""
        Write-Host "================= 管理端已打开 =================" -ForegroundColor Green
        Write-Host "  地址     $url"
        Write-Host "  提示     管理端和浏览器里其他页面共用登录态；需要同时看学生/教师端请用 dev.cmd 开客户端"
        Write-Host "  常用     admin.cmd status | stop    后端日志：dev.cmd logs api"
        Show-Accounts
        Write-Host "=================================================" -ForegroundColor Green
    }
    "status" { Show-Status }
    "stop" {
        Write-Step "停止 API 和前端（保留数据库容器 $Container）"
        Stop-ServiceByName "api" $ApiPort "API"
        Stop-ServiceByName "portal" $WebPort "前端"
    }
    "help" { Get-Content $PSCommandPath -TotalCount 8 | ForEach-Object { $_ -replace '^# ?', '' } }
}
