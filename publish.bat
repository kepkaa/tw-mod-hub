@echo off
cd /d "%~dp0"
REM Release without a token: push code + tag, GitHub Actions builds the installer.
where git >nul 2>nul
if errorlevel 1 (
  echo Install Git first: https://git-scm.com/download/win
  pause
  exit /b 1
)
for /f %%v in ('node -p "require('./package.json').version"') do set VER=%%v
echo === Releasing v%VER% ===
echo If this version was already released, bump "version" in package.json and run again.
pause
if not exist .git (
  git init
  git branch -M main
  git remote add origin https://github.com/kepkaa/tw-mod-hub.git
)
git add -A
git commit -m "release v%VER%"
git push -u origin main
if errorlevel 1 (
  echo PUSH FAILED - see the message above.
  pause
  exit /b 1
)
git tag v%VER%
if errorlevel 1 (
  echo Tag v%VER% already exists - bump "version" in package.json.
  pause
  exit /b 1
)
git push origin v%VER%
if errorlevel 1 (
  echo TAG PUSH FAILED.
  pause
  exit /b 1
)
echo.
echo Done. Build progress: https://github.com/kepkaa/tw-mod-hub/actions
echo Installer will appear in: https://github.com/kepkaa/tw-mod-hub/releases
pause
