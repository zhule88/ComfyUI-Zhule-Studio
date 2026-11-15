@echo off
rem Zhule Hardlink Context Menu :: UNINSTALL (removes HKCU entries only)
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0menu_install.ps1" -Action uninstall
echo.
pause
