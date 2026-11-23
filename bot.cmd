@echo off
setlocal
call "%~dp0setenv.cmd"
node "%ROOT%\app\bot\hdu-bot.js" %*
