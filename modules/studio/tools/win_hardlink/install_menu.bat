@echo off
rem Zhule Hardlink Context Menu :: INSTALL (HKCU only, no admin required)
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0menu_install.ps1" -Action install
echo.
pause
