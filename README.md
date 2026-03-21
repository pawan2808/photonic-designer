# Photonic IC Layout Designer — Professional Desktop Application

## Architecture Overview

```
PhotonicDesigner/
├── installer/                  # Platform-specific installer scripts
│   ├── build_all.sh            # Master build script (run this)
│   ├── build_windows.bat       # Windows-specific build
│   └── build_macos.sh          # macOS-specific build
├── electron/                   # Electron desktop shell
│   ├── main.js                 # Main process (window, licensing, tray)
│   ├── preload.js              # Secure bridge to renderer
│   ├── license.js              # License validation + Google Drive sync
│   ├── fingerprint.js          # Machine fingerprint generation
│   ├── updater.js              # Auto-update support
│   └── package.json            # Electron dependencies
├── src/                        # Application source
│   ├── app.py                  # Flask backend (your code)
│   ├── App.jsx                 # React frontend (your code)
│   └── index.html              # Electron entry point
├── pdk/                        # IHP_PDK (bundled)
│   └── IHP_PDK_Nazca_PreDev_V02/
├── scripts/
│   ├── setup_python.py         # Downloads & configures embedded Python
│   ├── obfuscate.py            # PyArmor obfuscation for app.py
│   └── package_nazca.py        # Downloads & bundles nazca
├── config/
│   ├── license_config.json     # Google Drive sheet ID, encryption keys
│   └── app_config.json         # App settings
└── build/                      # Build output (installers go here)
```

## How It Works

### 1. Native Desktop App (Electron)
- Runs as a **real native window** (like KLayout) — no browser chrome
- System tray icon, native menus, file dialogs
- Single executable, no terminal visible

### 2. Embedded Python Runtime
- The installer downloads Python 3.11 **embedded** (no system Python needed)
- Installs nazca, flask, numpy, IHP_PDK into a local venv
- User never sees pip, conda, or any terminal

### 3. License System (Google Drive-backed)
- Each install generates a **machine fingerprint** (CPU ID + MAC + disk serial + hostname hash)
- On first launch, user enters a license key
- App validates against a **Google Sheet** you control:
  - Column A: License Key
  - Column B: Machine Fingerprint (locked on activation)
  - Column C: Status (ACTIVE / REVOKED / EXPIRED)
  - Column D: Expiry Date
  - Column E: Last Seen (heartbeat timestamp)
  - Column F: App Version
- **Real-time deactivation**: App checks license every 30 minutes
- **You can revoke** any license instantly by changing status in the Google Sheet
- **Anti-piracy**: Fingerprint prevents key sharing between machines

### 4. Source Code Protection
- Python backend: **PyArmor** obfuscation (bytecode encryption)
- Frontend JS: Packed into **asar** archive (Electron standard)
- No readable source code in the distributed app
- API endpoints only accessible from localhost (Electron process)

### 5. Cross-Platform Installers
- **Windows**: NSIS installer (.exe) — x64 and ARM64
- **macOS**: DMG with drag-to-Applications — Intel and Apple Silicon
- Both auto-download Python runtime on first launch if needed

## Quick Start (Development)

```bash
# 1. Install Node.js dependencies
cd electron && npm install

# 2. Set up Python environment
python scripts/setup_python.py

# 3. Run in development mode
npm run dev
```

## Building Installers

```bash
# Build all platforms
./installer/build_all.sh

# Or specific platform
./installer/build_windows.bat    # Windows
./installer/build_macos.sh       # macOS
```

## License Management

1. Create a Google Sheet with columns: Key, Fingerprint, Status, Expiry, LastSeen, Version
2. Share it with the service account email
3. Put the service account JSON key in `config/google_credentials.json`
4. Generate license keys with: `python scripts/generate_license.py --count 10`

## Output
After building, find installers in `build/`:
- `PhotonicDesigner-Setup-1.0.0-win-x64.exe`
- `PhotonicDesigner-Setup-1.0.0-win-arm64.exe`
- `PhotonicDesigner-1.0.0-mac-x64.dmg`
- `PhotonicDesigner-1.0.0-mac-arm64.dmg`
