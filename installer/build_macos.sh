#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  build_macos.sh — Build macOS Installer (Intel + Apple Silicon)
# ═══════════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Photonic Designer — macOS Build"
echo "═══════════════════════════════════════════════════════"
echo ""

cd "$PROJECT_ROOT"

# Prepare source
mkdir -p src pdk config
[ -f "app.py" ] && cp app.py src/app.py
[ -f "App.jsx" ] && cp App.jsx src/App.jsx

# Extract PDK
if [ -f "pdk/IHP_PDK_Nazca_PreDev_V02.zip" ] && [ ! -d "pdk/IHP_PDK_Nazca_PreDev_V02" ]; then
  cd pdk && unzip -qo IHP_PDK_Nazca_PreDev_V02.zip && cd ..
fi

# Detect if Apple Silicon or Intel
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  PYPLAT="mac-arm64"
else
  PYPLAT="mac-x64"
fi

# Setup Python for current arch
echo "[1/4] Setting up Python ($PYPLAT)..."
python3 scripts/setup_python.py --platform "$PYPLAT"

# Node deps
echo "[2/4] Installing Node.js dependencies..."
cd electron && npm install --production=false && cd ..

# Obfuscate
echo "[3/4] Obfuscating source..."
python3 scripts/obfuscate.py 2>/dev/null || echo "  Skipping (PyArmor not available)"
[ -f "dist-obfuscated/app.py" ] && cp dist-obfuscated/app.py src/app.py

# Build for both architectures
echo "[4/4] Building macOS DMGs..."
cd electron

echo "  Building Intel (x64)..."
npx electron-builder --mac --x64 || echo "  ⚠ x64 build may need Rosetta on Apple Silicon"

echo "  Building Apple Silicon (arm64)..."
npx electron-builder --mac --arm64

cd ..

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Done! Check build/ for .dmg installers"
echo "═══════════════════════════════════════════════════════"
ls -la build/*.dmg 2>/dev/null
echo ""
