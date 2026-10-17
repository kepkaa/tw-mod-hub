@echo off
cd /d "%~dp0"
REM Выпуск новой версии одной кнопкой: код -> GitHub, тег -> GitHub сам собирает установщик.
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
set /p V=Version number, for example 1.3.1 :
if "%V%"=="" exit /b 1
git add -A
git commit -m "release v%V%"
git push -u origin main
if errorlevel 1 (
  echo PUSH FAILED - see the message above.
  pause
  exit /b 1
)
git tag v%V%
git push origin v%V%
if errorlevel 1 (
  echo TAG FAILED - maybe v%V% already exists. Use a new number.
  pause
  exit /b 1
)
echo.
echo Done. GitHub is building the installer now (about 3-5 minutes):
echo   https://github.com/kepkaa/tw-mod-hub/actions
echo When it is green, the download link works:
echo   https://github.com/kepkaa/tw-mod-hub/releases/latest/download/Kepka-Deck-Setup.exe
pause
