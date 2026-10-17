@echo off
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 (
  echo Install Git first: https://git-scm.com/download/win
  pause
  exit /b 1
)
if not exist .git (
  git init
  git branch -M main
  git remote add origin https://github.com/kepkaa/tw-mod-hub.git
)
git add -A
git commit -m "update"
git push -u origin main
if errorlevel 1 (
  echo.
  echo PUSH FAILED - see the message above.
  pause
  exit /b 1
)
echo.
echo Done: https://github.com/kepkaa/tw-mod-hub
pause
