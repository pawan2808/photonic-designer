@echo off
REM ═══════════════════════════════════════════════════════════════════════
REM  build_windows.bat — Build Windows Installer for Photonic Designer
REM
REM  Run from project root:  installer\build_windows.bat
REM  Requires: Node.js 18+, Python 3.10+
REM ═══════════════════════════════════════════════════════════════════════

echo.
echo ═══════════════════════════════════════════════════════
echo   Photonic Designer — Windows Build
echo ═══════════════════════════════════════════════════════
echo.

cd /d "%~dp0\.."
set PROJECT_ROOT=%CD%

REM ─── Copy source files ─────────────────────────────────────────────
echo [1/5] Preparing source files...
if not exist src mkdir src
if not exist pdk mkdir pdk
if not exist config mkdir config

if exist app.py copy /y app.py src\app.py >nul
if exist App.jsx copy /y App.jsx src\App.jsx >nul

REM Extract PDK
if exist "pdk\IHP_PDK_Nazca_PreDev_V02.zip" (
  if not exist "pdk\IHP_PDK_Nazca_PreDev_V02" (
    echo   Extracting IHP PDK...
    powershell -Command "Expand-Archive -Path 'pdk\IHP_PDK_Nazca_PreDev_V02.zip' -DestinationPath 'pdk' -Force"
  )
)

REM ─── Set up Python ──────────────────────────────────────────────────
echo [2/5] Setting up embedded Python...
python scripts\setup_python.py --platform win-x64
if %ERRORLEVEL% neq 0 (
  echo   WARNING: Python setup had issues. Continuing...
)

REM ─── Install Node dependencies ──────────────────────────────────────
echo [3/5] Installing Node.js dependencies...
cd electron
call npm install --production=false
cd ..

REM ─── Obfuscate ─────────────────────────────────────────────────────
echo [4/5] Obfuscating source...
python scripts\obfuscate.py 2>nul
if exist "dist-obfuscated\app.py" (
  copy /y dist-obfuscated\app.py src\app.py >nul
  echo   Using obfuscated source
) else (
  echo   Skipping obfuscation (PyArmor not available or failed)
)

REM ─── Build Installers ──────────────────────────────────────────────
echo [5/5] Building Windows installers...
cd electron

echo   Building x64...
call npx electron-builder --win --x64

echo   Building ARM64...
call npx electron-builder --win --arm64

cd ..

echo.
echo ═══════════════════════════════════════════════════════
echo   Build complete! Check build\ for installers.
echo ═══════════════════════════════════════════════════════
echo.

dir build\*.exe 2>nul
pause
