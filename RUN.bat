@echo off
title Photonic Designer
cd /d "%~dp0"

REM Add Node.js to PATH if not found
node --version >nul 2>&1 || set "PATH=C:\nodejs;%PATH%"

REM Read saved Python path
if exist "electron\.python_path" (
    set /p PYTHON_CMD=<"electron\.python_path"
) else (
    set PYTHON_CMD=python
)

echo.
echo  Photonic Designer starting...
echo  (Keep this window open)
echo.

cd /d "%~dp0electron"
.\node_modules\.bin\electron . --no-sandbox --disable-gpu

echo  Closed.
timeout /t 2 >nul
