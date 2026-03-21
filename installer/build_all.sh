#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  build_all.sh — Master Build Script for Photonic Designer
#
#  Creates production installers for Windows (x64/ARM64) and macOS (Intel/M-series)
#
#  Prerequisites:
#    - Node.js 18+ (npm)
#    - Python 3.10+ (for setup script)
#    - Internet connection (downloads Python embeds, nazca, npm packages)
#
#  Usage:
#    ./installer/build_all.sh                   # Build all platforms
#    ./installer/build_all.sh --platform win     # Windows only
#    ./installer/build_all.sh --platform mac     # macOS only
#    ./installer/build_all.sh --skip-python       # Skip Python setup
#    ./installer/build_all.sh --skip-obfuscate    # Skip code obfuscation
# ═══════════════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Defaults
PLATFORM="all"
SKIP_PYTHON=false
SKIP_OBFUSCATE=false

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM="$2"; shift 2 ;;
    --skip-python) SKIP_PYTHON=true; shift ;;
    --skip-obfuscate) SKIP_OBFUSCATE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Photonic Designer — Production Build${NC}"
echo -e "${BLUE}  Platform: ${YELLOW}${PLATFORM}${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

cd "$PROJECT_ROOT"

# ─── Step 1: Copy source files ────────────────────────────────────────────────
echo -e "${GREEN}[1/7]${NC} Preparing source files..."

mkdir -p src pdk config

# Copy app.py and App.jsx to src/ if they exist at root
[ -f "app.py" ] && cp app.py src/app.py && echo "  ✓ app.py → src/"
[ -f "App.jsx" ] && cp App.jsx src/App.jsx && echo "  ✓ App.jsx → src/"

# Extract PDK if needed
if [ -f "pdk/IHP_PDK_Nazca_PreDev_V02.zip" ] && [ ! -d "pdk/IHP_PDK_Nazca_PreDev_V02" ]; then
  echo "  ⊞ Extracting IHP PDK..."
  cd pdk && unzip -qo IHP_PDK_Nazca_PreDev_V02.zip && cd ..
  echo "  ✓ PDK extracted"
fi

# ─── Step 2: Create config templates ──────────────────────────────────────────
echo -e "${GREEN}[2/7]${NC} Setting up configuration..."

if [ ! -f "config/license_config.json" ]; then
  cat > config/license_config.json << 'LICEOF'
{
  "sheetId": "YOUR_GOOGLE_SHEET_ID_HERE",
  "mode": "demo",
  "heartbeatInterval": 1800000,
  "gracePeriod": 7200000,
  "appName": "Photonic Designer",
  "version": "1.0.0"
}
LICEOF
  echo "  ✓ Created license_config.json (DEMO mode)"
  echo -e "  ${YELLOW}⚠ Update config/license_config.json with your Google Sheet ID for production${NC}"
fi

if [ ! -f "config/app_config.json" ]; then
  cat > config/app_config.json << 'APPEOF'
{
  "appName": "Photonic Designer",
  "version": "1.0.0",
  "defaultPort": 5000,
  "pdkName": "IHP SiN Photonics",
  "nazcaVersion": "0.6.1"
}
APPEOF
  echo "  ✓ Created app_config.json"
fi

# ─── Step 3: Set up embedded Python ──────────────────────────────────────────
if [ "$SKIP_PYTHON" = false ]; then
  echo -e "${GREEN}[3/7]${NC} Setting up embedded Python..."

  # Detect current platform for building
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  PYPLAT="mac-arm64" ;;
    Darwin-x86_64) PYPLAT="mac-x64" ;;
    Linux-x86_64)  PYPLAT="linux-x64" ;;
    MINGW*|MSYS*)  PYPLAT="win-x64" ;;
    *)             PYPLAT="linux-x64" ;;
  esac

  python3 scripts/setup_python.py --platform "$PYPLAT"
else
  echo -e "${YELLOW}[3/7]${NC} Skipping Python setup"
fi

# ─── Step 4: Obfuscate source code ───────────────────────────────────────────
if [ "$SKIP_OBFUSCATE" = false ]; then
  echo -e "${GREEN}[4/7]${NC} Obfuscating source code..."
  python3 scripts/obfuscate.py || {
    echo -e "  ${YELLOW}⚠ Obfuscation failed (PyArmor may need a license for cross-platform).${NC}"
    echo "  Continuing with unobfuscated source..."
  }

  # If obfuscation succeeded, use the obfuscated files
  if [ -d "dist-obfuscated" ] && [ -f "dist-obfuscated/app.py" ]; then
    cp dist-obfuscated/app.py src/app.py
    echo "  ✓ Using obfuscated app.py"
  fi
else
  echo -e "${YELLOW}[4/7]${NC} Skipping obfuscation"
fi

# ─── Step 5: Install Node.js dependencies ────────────────────────────────────
echo -e "${GREEN}[5/7]${NC} Installing Node.js dependencies..."
cd "$PROJECT_ROOT/electron"
npm install --production=false
echo "  ✓ Dependencies installed"
cd "$PROJECT_ROOT"

# ─── Step 6: Create resources (icons, license text) ──────────────────────────
echo -e "${GREEN}[6/7]${NC} Preparing build resources..."

mkdir -p electron/resources

# Create a simple license text if none exists
if [ ! -f "electron/resources/license.txt" ]; then
  cat > electron/resources/license.txt << 'EULA'
PHOTONIC DESIGNER — END USER LICENSE AGREEMENT

Copyright (c) 2026. All rights reserved.

This software is licensed, not sold. By installing or using this software,
you agree to the following terms:

1. LICENSE GRANT: You are granted a non-exclusive, non-transferable license
   to use this software on ONE machine, identified by its hardware fingerprint.

2. RESTRICTIONS: You may not:
   - Copy, modify, or distribute the software
   - Reverse engineer, decompile, or disassemble the software
   - Remove or alter any proprietary notices
   - Transfer the license to another machine without authorization
   - Use the software for any unlawful purpose

3. ACTIVATION: The software requires online activation and periodic validation.
   The license may be revoked at any time by the licensor.

4. TERMINATION: This license terminates automatically if you violate any terms.
   Upon termination, you must destroy all copies of the software.

5. NO WARRANTY: The software is provided "AS IS" without warranty of any kind.

6. LIMITATION OF LIABILITY: In no event shall the licensor be liable for any
   damages arising from the use of this software.
EULA
  echo "  ✓ Created EULA"
fi

# Create placeholder icon (in production, use a real .ico/.icns)
echo "  (Using placeholder icons — replace electron/resources/icon.* with your branding)"

# ─── Step 7: Build Electron installers ────────────────────────────────────────
echo -e "${GREEN}[7/7]${NC} Building installers..."
cd "$PROJECT_ROOT/electron"

case "$PLATFORM" in
  win)
    echo "  Building Windows x64..."
    npx electron-builder --win --x64 || echo "  ⚠ Windows x64 build needs Windows or Wine"
    echo "  Building Windows ARM64..."
    npx electron-builder --win --arm64 || echo "  ⚠ Windows ARM64 build needs Windows"
    ;;
  mac)
    echo "  Building macOS x64..."
    npx electron-builder --mac --x64
    echo "  Building macOS ARM64 (Apple Silicon)..."
    npx electron-builder --mac --arm64
    ;;
  all)
    echo "  Building all platforms..."
    npx electron-builder --win --mac --x64 --arm64 || {
      echo -e "  ${YELLOW}⚠ Some platforms may fail on cross-compilation.${NC}"
      echo "  Build natively on each platform for best results."
    }
    ;;
  *)
    echo "  Unknown platform: $PLATFORM"
    exit 1
    ;;
esac

cd "$PROJECT_ROOT"

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build complete!${NC}"
echo ""
echo "  Installers are in: ${PROJECT_ROOT}/build/"
echo ""
ls -la build/ 2>/dev/null || echo "  (build/ may be empty if cross-compilation failed)"
echo ""
echo -e "${YELLOW}  NEXT STEPS:${NC}"
echo "  1. Replace config/license_config.json with your Google Sheet ID"
echo "  2. Add config/google_credentials.json (service account key)"
echo "  3. Replace electron/resources/icon.* with your branding"
echo "  4. Generate license keys: python scripts/generate_license.py --count 10"
echo "  5. Test the installer on each target platform"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
