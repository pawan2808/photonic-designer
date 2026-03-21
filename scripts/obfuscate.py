#!/usr/bin/env python3
"""
obfuscate.py — Obfuscate Python source code with PyArmor.

Encrypts app.py so distributed builds contain no readable source.
Users cannot extract, decompile, or read the backend logic.

Usage:
  python scripts/obfuscate.py              # Obfuscate src/app.py
  python scripts/obfuscate.py --verify     # Test obfuscated code runs
"""

import argparse
import subprocess
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
SRC_DIR = PROJECT_ROOT / "src"
DIST_DIR = PROJECT_ROOT / "dist-obfuscated"


def check_pyarmor():
    """Ensure PyArmor is installed."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pyarmor", "--version"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"  ✓ PyArmor: {result.stdout.strip()}")
            return True
    except Exception:
        pass

    print("  ⊞ Installing PyArmor...")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "pyarmor"],
        check=True, capture_output=True
    )
    print("  ✓ PyArmor installed")
    return True


def obfuscate():
    """Run PyArmor obfuscation on the source files."""
    check_pyarmor()

    if DIST_DIR.exists():
        shutil.rmtree(str(DIST_DIR))
    DIST_DIR.mkdir(parents=True)

    app_py = SRC_DIR / "app.py"
    if not app_py.exists():
        print(f"  ✗ {app_py} not found")
        sys.exit(1)

    print(f"\n  ⊞ Obfuscating {app_py}...")

    # PyArmor 8+ syntax
    subprocess.run([
        sys.executable, "-m", "pyarmor", "gen",
        "--output", str(DIST_DIR),
        "--platform", "windows.x86_64",
        "--platform", "windows.aarch64",
        "--platform", "darwin.x86_64",
        "--platform", "darwin.aarch64",
        "--platform", "linux.x86_64",
        str(app_py)
    ], check=True)

    print(f"  ✓ Obfuscated output in {DIST_DIR}/")

    # Copy non-Python files
    for f in SRC_DIR.iterdir():
        if f.suffix != ".py" and f.is_file():
            shutil.copy2(str(f), str(DIST_DIR / f.name))
            print(f"    Copied {f.name}")

    print(f"\n  ✓ Obfuscation complete!")
    print(f"    Replace src/ contents with {DIST_DIR}/ before building installers.")


def verify():
    """Test that obfuscated code can import."""
    obf_app = DIST_DIR / "app.py"
    if not obf_app.exists():
        print("  ✗ No obfuscated code found. Run without --verify first.")
        sys.exit(1)

    print("  ⊞ Testing obfuscated import...")
    result = subprocess.run(
        [sys.executable, "-c", f"import sys; sys.path.insert(0, '{DIST_DIR}'); import app; print('OK')"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(f"  ✓ Obfuscated code loads successfully")
    else:
        print(f"  ✗ Import failed: {result.stderr[:200]}")


def main():
    parser = argparse.ArgumentParser(description="Obfuscate Python source with PyArmor")
    parser.add_argument("--verify", action="store_true", help="Verify obfuscated code")
    args = parser.parse_args()

    print(f"\n{'='*50}")
    print(f"  Photonic Designer — Source Obfuscation")
    print(f"{'='*50}\n")

    if args.verify:
        verify()
    else:
        obfuscate()


if __name__ == "__main__":
    main()
