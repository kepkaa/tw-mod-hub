@echo off
cd /d "%~dp0"
REM Manual release from this PC (needs GH_TOKEN). Easier: use publish.bat
if "%GH_TOKEN%"=="" (
  echo Set the GitHub token first: setx GH_TOKEN your_token  ^(then open a new window^)
  pause
  exit /b 1
)
echo Bump "version" in package.json before releasing!
pause
call npm install --no-audit --no-fund
call npm run release
echo Done.
pause
