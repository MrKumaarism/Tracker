@echo off
REM ponytail: auto-sync to GitHub. Commit fails harmlessly when nothing changed.
cd /d "%~dp0.."
git add -A
git commit -q -m "auto: sync" >nul 2>&1
git push -q origin HEAD
exit /b 0
