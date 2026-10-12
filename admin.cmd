@echo off
setlocal
rem ASCII only: cmd.exe parses batch files in the OEM code page.
rem admin.cmd = open the admin portal in the browser; admin.cmd status|stop|help = same as dev.cmd
chcp 65001 >nul
if "%~1"=="" (
    node "%~dp0scripts\dev.mjs" admin
) else (
    node "%~dp0scripts\dev.mjs" %*
)
set "CODE=%errorlevel%"
if not "%CODE%"=="0" (echo %cmdcmdline% | find /i "%~0" >nul && pause)
exit /b %CODE%
