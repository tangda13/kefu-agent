@echo off
setlocal
rem ASCII only: cmd.exe parses batch files in the OEM code page. Usage: dev.cmd help
chcp 65001 >nul
node "%~dp0scripts\dev.mjs" %*
set "CODE=%errorlevel%"
rem double-click: keep the window open only when something failed
if not "%CODE%"=="0" (echo %cmdcmdline% | find /i "%~0" >nul && pause)
exit /b %CODE%
