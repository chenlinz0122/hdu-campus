@echo off
chcp 65001 >nul
title HDU Campus Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo 安装未完成，请查看上面的错误信息。
  pause
  exit /b 1
)
echo.
pause
