#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  quickstart.sh — One-command setup for development
#
#  Usage:  ./quickstart.sh
#
#  This script:
#    1. Patches app.py for Electron
#    2. Installs Node.js dependencies
#    3. Extracts the PDK
#    4. Launches the app in dev mode
# ═══════════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "◈ Photonic Designer — Quick Start"
echo "══════════════════════════════════"
echo ""

# Ensure src/ has the files
mkdir -p src pdk config
[ -f "app.py" ] && [ ! -f "src/app.py" ] && cp app.py src/app.py
[ -f "App.jsx" ] && [ ! -f "src/App.jsx" ] && cp App.jsx src/App.jsx

# Extract PDK
if [ -f "pdk/IHP_PDK_Nazca_PreDev_V02.zip" ] && [ ! -d "pdk/IHP_PDK_Nazca_PreDev_V02" ]; then
  echo "Extracting IHP PDK..."
  cd pdk && unzip -qo IHP_PDK_Nazca_PreDev_V02.zip && cd ..
fi

# Patch app.py
echo "Patching app.py for Electron..."
python3 scripts/app_patch.py

# Create default config if needed
if [ ! -f "config/license_config.json" ]; then
  echo '{"mode": "demo"}' > config/license_config.json
fi

# Install Node deps
echo "Installing Node.js dependencies..."
cd electron
npm install 2>/dev/null || npm install --legacy-peer-deps
cd ..

echo ""
echo "══════════════════════════════════"
echo "Setup complete!"
echo ""
echo "To run in DEVELOPMENT mode:"
echo "  Terminal 1:  cd src && python3 app.py"
echo "  Terminal 2:  cd electron && npm start"
echo ""
echo "To BUILD INSTALLERS:"
echo "  ./installer/build_all.sh"
echo ""
echo "To generate license keys:"
echo "  python3 scripts/generate_license.py --count 10"
echo "══════════════════════════════════"
