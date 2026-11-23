@echo off
setlocal
call "%~dp0..\setenv.cmd"
"%HDU_PYTHON%" "%HDU_MAIL_PY%" %*
