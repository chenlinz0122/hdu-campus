@echo off
rem ============================================================
rem  HDU Campus Windows - environment for all wrappers
rem  Do not run this file directly; call it from bot.cmd etc.
rem ============================================================
if defined HDU_CAMPUS_ENV goto :eof
set "HDU_CAMPUS_ENV=1"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if not defined APPDATA set "APPDATA=%USERPROFILE%\AppData\Roaming"
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"

set "HDU_BOT_CONFIG_DIR=%APPDATA%\hdu-campus\config"
set "HDU_BOT_STATE_DIR=%APPDATA%\hdu-campus\state"
set "HDU_MAIL_CONFIG=%APPDATA%\hdu-campus\config\hdu-mail"
set "HDU_KB_HOME=%APPDATA%\hdu-campus\kb"
set "HDU_KB_DB=%HDU_KB_HOME%\kb.sqlite"
set "HDU_KB_PY=%ROOT%\app\kb\hdu_kb.py"
set "HDU_MAIL_PY=%ROOT%\app\mail\hdu-mail"
set "HDU_BOT_LIB=%ROOT%\app\bot\lib"
set "HDU_FEISHU_SDK=%ROOT%\app\node_modules\@larksuiteoapi\node-sdk"

rem Python path is written by setup.ps1 if "python" is not on PATH.
if exist "%HDU_BOT_CONFIG_DIR%\python_path.txt" (
  set /p HDU_PYTHON=<"%HDU_BOT_CONFIG_DIR%\python_path.txt"
)
if not defined HDU_PYTHON set "HDU_PYTHON=python"

set "PATH=%ROOT%\bin;%PATH%"
