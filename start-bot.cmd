@echo off
setlocal
call "%~dp0setenv.cmd"
if not exist "%HDU_BOT_STATE_DIR%" mkdir "%HDU_BOT_STATE_DIR%" >nul 2>&1

rem Single instance: do not start a second daemon.
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*hdu-bot.js*' }) { exit 1 }"
if errorlevel 1 (
  echo HDU Campus Bot is already running.
  exit /b 0
)

:loop
if exist "%HDU_BOT_STATE_DIR%\stop.flag" exit /b 0
node "%ROOT%\app\bot\hdu-bot.js" >> "%HDU_BOT_STATE_DIR%\console.log" 2>&1
if exist "%HDU_BOT_STATE_DIR%\stop.flag" exit /b 0
timeout /t 5 /nobreak >nul
goto loop
