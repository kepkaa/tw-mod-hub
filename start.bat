@echo off
cd /d "%~dp0"
echo Checking dependencies...
call npm install --no-audit --no-fund
call npm start
