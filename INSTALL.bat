@echo off
REM ═══════════════════════════════════════════════════════════════════════
REM  INSTALL.bat — Double-click this. That's it.
REM  Photonic IC Layout Designer — IHP SiN Photonics PDK
REM ═══════════════════════════════════════════════════════════════════════

title Photonic Designer — Setup
color 0B

echo.
echo  ============================================================
echo       Photonic Designer - One-Click Installer
echo       IHP SiN Photonics PDK Layout Tool
echo  ============================================================
echo.

cd /d "%~dp0"
set "ROOT=%CD%"

REM ─── Find Python ───────────────────────────────────────────────────────
echo  [1/7] Finding Python...

set PYTHON_CMD=
python --version >nul 2>&1 && set PYTHON_CMD=python && goto :got_py
python3 --version >nul 2>&1 && set PYTHON_CMD=python3 && goto :got_py
py --version >nul 2>&1 && set PYTHON_CMD=py && goto :got_py
for %%P in (
    "C:\Python311\python.exe"
    "C:\Python312\python.exe"
    "C:\Python310\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311-arm64\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312-arm64\python.exe"
    "%USERPROFILE%\AppData\Local\Programs\Python\Python311\python.exe"
    "%USERPROFILE%\AppData\Local\Programs\Python\Python311-arm64\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
    "%USERPROFILE%\miniconda3\python.exe"
) do (
    if exist %%~P (
        set "PYTHON_CMD=%%~P"
        goto :got_py
    )
)
echo.
echo  [ERROR] Python not found!
echo  Install Python 3.10+ from https://www.python.org/downloads/
echo  CHECK "Add Python to PATH" during install!
echo.
pause
exit /b 1

:got_py
for /f "tokens=*" %%i in ('%PYTHON_CMD% --version 2^>^&1') do echo         Found: %%i
echo %PYTHON_CMD%> "%ROOT%\electron\.python_path"

REM ─── Find Node.js ─────────────────────────────────────────────────────
echo  [2/7] Finding Node.js...

node --version >nul 2>&1 && goto :got_node
if exist "C:\nodejs\node.exe" ( set "PATH=C:\nodejs;%PATH%" && goto :got_node )
if exist "C:\Program Files\nodejs\node.exe" ( set "PATH=C:\Program Files\nodejs;%PATH%" && goto :got_node )
echo.
echo  [ERROR] Node.js not found!
echo  Download from https://nodejs.org (LTS) or extract zip to C:\nodejs
echo.
pause
exit /b 1

:got_node
for /f "tokens=*" %%i in ('node --version 2^>^&1') do echo         Found: Node.js %%i

REM ─── Create npm folder (fixes ENOENT error) ───────────────────────────
if not exist "%APPDATA%\npm" (
    mkdir "%APPDATA%\npm" >nul 2>&1
    echo         Created npm folder
)

REM ─── Install Python packages ──────────────────────────────────────────
echo  [3/7] Installing Python packages...

%PYTHON_CMD% -m pip install --quiet --upgrade pip 2>nul

REM Core packages
%PYTHON_CMD% -c "import flask" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo         Installing Flask...
    %PYTHON_CMD% -m pip install --quiet flask flask-cors 2>nul
    if %ERRORLEVEL% neq 0 %PYTHON_CMD% -m pip install --quiet --user flask flask-cors 2>nul
)

%PYTHON_CMD% -c "import numpy" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo         Installing NumPy...
    %PYTHON_CMD% -m pip install --quiet numpy 2>nul
)

%PYTHON_CMD% -c "import scipy" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo         Installing SciPy...
    %PYTHON_CMD% -m pip install --quiet scipy --only-binary :all: 2>nul
)

%PYTHON_CMD% -c "import matplotlib" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo         Installing Matplotlib...
    %PYTHON_CMD% -m pip install --quiet matplotlib 2>nul
)

REM Pandas — ARM64 Windows only has wheels for 3.0+
%PYTHON_CMD% -c "import pandas" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo         Installing Pandas...
    %PYTHON_CMD% -m pip install --quiet pandas --only-binary :all: 2>nul
    if %ERRORLEVEL% neq 0 %PYTHON_CMD% -m pip install --quiet pandas 2>nul
)

REM PyYAML + Pillow
%PYTHON_CMD% -m pip install --quiet PyYAML Pillow ipython 2>nul

REM Nazca
%PYTHON_CMD% -c "import nazca" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo         Installing Nazca Design...
    %PYTHON_CMD% -m pip install --quiet --no-deps https://nazca-design.org/dist/nazca-0.6.1.tar.gz 2>nul
    if %ERRORLEVEL% neq 0 (
        %PYTHON_CMD% -m pip install --quiet --user --no-deps https://nazca-design.org/dist/nazca-0.6.1.tar.gz 2>nul
    )
)

REM pyclipper — skip if can't compile (optional)
%PYTHON_CMD% -c "import pyclipper" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    %PYTHON_CMD% -m pip install --quiet pyclipper --only-binary :all: 2>nul
)

echo         Python packages done

REM ─── Install IHP PDK ──────────────────────────────────────────────────
echo  [4/7] Setting up IHP PDK...

%PYTHON_CMD% -c "import IHP_PDK" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    if exist "%ROOT%\pdk\IHP_PDK_Nazca_PreDev_V02.zip" (
        if not exist "%ROOT%\pdk\IHP_PDK_Nazca_PreDev_V02" (
            echo         Extracting PDK...
            powershell -Command "Expand-Archive -Path '%ROOT%\pdk\IHP_PDK_Nazca_PreDev_V02.zip' -DestinationPath '%ROOT%\pdk' -Force" >nul 2>&1
        )
        REM Copy directly to site-packages (avoids build dependency issues)
        for /f "tokens=*" %%S in ('%PYTHON_CMD% -c "import site; print(site.getsitepackages()[0])"') do (
            if not exist "%%S\IHP_PDK" (
                echo         Installing IHP PDK...
                xcopy /E /I /Q "%ROOT%\pdk\IHP_PDK_Nazca_PreDev_V02\IHP_PDK" "%%S\IHP_PDK" >nul 2>&1
            )
        )
    )
)

echo         IHP PDK ready

REM ─── Install Node packages ────────────────────────────────────────────
echo  [5/7] Installing desktop app packages...

cd /d "%ROOT%\electron"
if not exist "node_modules\electron" (
    call npm install --loglevel=error 2>nul
    echo         Done
) else (
    echo         Already installed
)

REM ─── Patch app.py + install gdstk replacement ─────────────────────────
echo  [6/7] Configuring application...

cd /d "%ROOT%"

REM Create config
if not exist "config" mkdir config >nul 2>&1
if not exist "config\license_config.json" (
    echo {"mode": "demo"} > config\license_config.json
)

REM Patch app.py for Electron (FLASK_PORT support + static serving)
findstr /C:"FLASK_PORT" "%ROOT%\src\app.py" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    %PYTHON_CMD% scripts\app_patch.py >nul 2>&1
)

REM Install pure-Python gdstk replacement (no C compiler needed)
if not exist "%ROOT%\src\gdstk.py" (
    echo         ERROR: gdstk.py missing from src\ folder!
    echo         The polygon renderer won't work without it.
    pause
)

echo         App configured

REM ─── Launch ────────────────────────────────────────────────────────────
echo  [7/7] Launching...
echo.
echo  ============================================================
echo       Photonic Designer is starting!
echo       Keep this window open while the app runs.
echo       Close this window to quit the app.
echo  ============================================================
echo.

cd /d "%ROOT%\electron"
.\node_modules\.bin\electron . --no-sandbox --disable-gpu

echo.
echo  Photonic Designer closed.
timeout /t 2 >nul
