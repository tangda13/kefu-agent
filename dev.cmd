@echo off
rem dev launcher: see scripts\dev.ps1 for usage
where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
)
rem double-click: keep the window open so the summary stays visible
echo %cmdcmdline% | find /i "%~0" >nul && pause
