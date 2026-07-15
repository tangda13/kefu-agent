@echo off
rem Desktop client launcher (Electron) - student/teacher share one client
where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-client.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-client.ps1" %*
)
if %errorlevel% neq 0 pause
