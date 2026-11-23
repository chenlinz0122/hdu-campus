@echo off
setlocal
call "%~dp0setenv.cmd"

echo ==== hdu-bot check ====
node "%ROOT%\app\bot\hdu-bot.js" --check
if errorlevel 1 goto :fail

echo.
echo ==== bot unit tests ====
for %%f in ("%ROOT%\app\bot\tests\*.test.js") do (
  node --test "%%f"
  if errorlevel 1 goto :fail
)

echo.
echo ==== kb tests ====
"%HDU_PYTHON%" -m unittest discover -s "%ROOT%\app\kb\tests" -v
if errorlevel 1 goto :fail

echo.
echo ==== kb stats ====
"%HDU_PYTHON%" "%HDU_KB_PY%" stats --json

echo.
echo ✓ selftest 完成
pause
exit /b 0

:fail
echo.
echo × selftest 有失败项
pause
exit /b 1
