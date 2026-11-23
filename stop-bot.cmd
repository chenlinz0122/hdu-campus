@echo off
chcp 65001 >nul
setlocal
call "%~dp0setenv.cmd"
if not exist "%HDU_BOT_STATE_DIR%" mkdir "%HDU_BOT_STATE_DIR%" >nul 2>&1
echo stop > "%HDU_BOT_STATE_DIR%\stop.flag"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*hdu-bot.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul
del "%HDU_BOT_STATE_DIR%\stop.flag" >nul 2>&1
echo 已停止 HDU Campus Bot。
