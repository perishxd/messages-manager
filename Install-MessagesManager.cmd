@echo off
if not exist "%~dp0Install-MessagesManager.ps1" (
  echo Extract ALL files from the ZIP first, then run this installer from the extracted folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-MessagesManager.ps1"
set "dmm_result=%errorlevel%"
pause
exit /b %dmm_result%
