@echo off
rem admin launcher: see scripts\admin.ps1 for usage
where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\admin.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\admin.ps1" %*
)
rem double-click: keep the window open so the summary stays visible
echo %cmdcmdline% | find /i "%~0" >nul && pause
