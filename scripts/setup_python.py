#!/usr/bin/env python3
"""
setup_python.py — Embedded Python Environment Setup

Downloads a standalone Python build and installs all dependencies
(nazca, flask, numpy, IHP_PDK) so the app runs without ANY system Python.

Usage:
  python scripts/setup_python.py                  # Auto-detect platform
  python scripts/setup_python.py --platform win-x64
  python scripts/setup_python.py --platform mac-arm64
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────────────────

PYTHON_VERSION = "3.11.9"

# Standalone Python builds from python-build-standalone (by Gregory Szorc / Astral)
# https://github.com/indygreg/python-build-standalone/releases
PYTHON_BUILDS = {
    "win-x64": f"https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-{PYTHON_VERSION}+20240415-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
    "win-arm64": f"https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-{PYTHON_VERSION}+20240415-aarch64-pc-windows-msvc-install_only_stripped.tar.gz",
    "mac-x64": f"https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-{PYTHON_VERSION}+20240415-x86_64-apple-darwin-install_only_stripped.tar.gz",
    "mac-arm64": f"https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-{PYTHON_VERSION}+20240415-aarch64-apple-darwin-install_only_stripped.tar.gz",
    "linux-x64": f"https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-{PYTHON_VERSION}+20240415-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
}

# Nazca Design download
NAZCA_URL = "https://nazca-design.org/dist/nazca-0.6.1.tar.gz"

# Python packages to install
PIP_PACKAGES = [
    "flask>=3.0",
    "flask-cors",
    "numpy>=1.24",
    "pandas>=2.0",
    "matplotlib",
    "scipy",
    "pyclipper",
]

PROJECT_ROOT = Path(__file__).parent.parent
EMBED_DIR = PROJECT_ROOT / "python-embed"
DOWNLOADS_DIR = PROJECT_ROOT / ".downloads"


def detect_platform():
    """Detect current platform as one of our build keys."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        prefix = "win"
    elif system == "darwin":
        prefix = "mac"
    else:
        prefix = "linux"

    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("arm64", "aarch64"):
        arch = "arm64"
    else:
        arch = "x64"  # fallback

    return f"{prefix}-{arch}"


def download_file(url, dest, desc=""):
    """Download a file with progress."""
    print(f"  ↓ Downloading {desc or url.split('/')[-1]}...")
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        print(f"    (cached: {dest})")
        return

    def _progress(block, block_size, total):
        downloaded = block * block_size
        if total > 0:
            pct = min(100, downloaded * 100 // total)
            bar = "█" * (pct // 3) + "░" * (33 - pct // 3)
            print(f"\r    [{bar}] {pct}%", end="", flush=True)

    urllib.request.urlretrieve(url, str(dest), reporthook=_progress)
    print()


def extract_python(archive_path, target_dir):
    """Extract standalone Python build."""
    print(f"  ⊞ Extracting Python to {target_dir}...")

    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)

    with tarfile.open(str(archive_path), "r:gz") as tar:
        tar.extractall(str(target_dir))

    # The archive extracts to a 'python/' subdirectory — flatten it
    python_inner = target_dir / "python"
    if python_inner.exists():
        for item in python_inner.iterdir():
            shutil.move(str(item), str(target_dir / item.name))
        python_inner.rmdir()

    print(f"    ✓ Python {PYTHON_VERSION} extracted")


def get_pip_path(plat):
    """Get the pip executable path for the embedded Python."""
    if plat.startswith("win"):
        return str(EMBED_DIR / "python.exe"), str(EMBED_DIR / "Scripts" / "pip.exe")
    else:
        return str(EMBED_DIR / "bin" / "python3"), str(EMBED_DIR / "bin" / "pip3")


def install_packages(plat):
    """Install all required Python packages into the embedded env."""
    python_exe, pip_exe = get_pip_path(plat)

    # Ensure pip is available
    print("  ⊞ Ensuring pip is available...")
    subprocess.run([python_exe, "-m", "ensurepip", "--upgrade"], check=True, capture_output=True)
    subprocess.run([python_exe, "-m", "pip", "install", "--upgrade", "pip"], check=True, capture_output=True)
    print("    ✓ pip ready")

    # Install packages
    for pkg in PIP_PACKAGES:
        print(f"  ⊞ Installing {pkg}...")
        subprocess.run(
            [python_exe, "-m", "pip", "install", pkg, "--no-warn-script-location"],
            check=True, capture_output=True
        )
        print(f"    ✓ {pkg}")

    # Install nazca
    nazca_archive = DOWNLOADS_DIR / "nazca-0.6.1.tar.gz"
    download_file(NAZCA_URL, nazca_archive, "Nazca Design 0.6.1")
    print("  ⊞ Installing nazca...")
    subprocess.run(
        [python_exe, "-m", "pip", "install", str(nazca_archive), "--no-warn-script-location"],
        check=True, capture_output=True
    )
    print("    ✓ nazca")

    # Install IHP_PDK
    pdk_zip = PROJECT_ROOT / "pdk" / "IHP_PDK_Nazca_PreDev_V02.zip"
    pdk_dir = PROJECT_ROOT / "pdk" / "IHP_PDK_Nazca_PreDev_V02"

    if pdk_zip.exists() and not pdk_dir.exists():
        print("  ⊞ Extracting IHP PDK...")
        with zipfile.ZipFile(str(pdk_zip)) as z:
            z.extractall(str(PROJECT_ROOT / "pdk"))
        print("    ✓ IHP PDK extracted")

    if pdk_dir.exists():
        setup_py = pdk_dir / "setup.py"
        if setup_py.exists():
            print("  ⊞ Installing IHP_PDK...")
            subprocess.run(
                [python_exe, "-m", "pip", "install", "-e", str(pdk_dir), "--no-warn-script-location"],
                check=True, capture_output=True
            )
            print("    ✓ IHP_PDK")
        else:
            # Manual install — copy IHP_PDK package into site-packages
            print("  ⊞ Copying IHP_PDK to site-packages...")
            site_pkgs = subprocess.check_output(
                [python_exe, "-c", "import site; print(site.getsitepackages()[0])"],
                text=True
            ).strip()
            ihp_src = pdk_dir / "IHP_PDK"
            ihp_dest = Path(site_pkgs) / "IHP_PDK"
            if ihp_dest.exists():
                shutil.rmtree(str(ihp_dest))
            shutil.copytree(str(ihp_src), str(ihp_dest))
            print("    ✓ IHP_PDK copied")


def setup_app_source():
    """Copy app.py and App.jsx into src/ if not already there."""
    src_dir = PROJECT_ROOT / "src"
    src_dir.mkdir(exist_ok=True)

    for fname in ["app.py", "App.jsx"]:
        src = PROJECT_ROOT / fname
        dest = src_dir / fname
        if src.exists() and not dest.exists():
            shutil.copy2(str(src), str(dest))
            print(f"    ✓ Copied {fname} to src/")


def verify_installation(plat):
    """Quick sanity check."""
    python_exe = get_pip_path(plat)[0]
    print("\n  ⊞ Verifying installation...")

    checks = [
        ("flask", "import flask; print(f'Flask {flask.__version__}')"),
        ("numpy", "import numpy; print(f'NumPy {numpy.__version__}')"),
        ("nazca", "import nazca; print(f'Nazca loaded')"),
    ]

    all_ok = True
    for name, cmd in checks:
        try:
            result = subprocess.run(
                [python_exe, "-c", cmd], capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                print(f"    ✓ {name}: {result.stdout.strip()}")
            else:
                print(f"    ✗ {name}: {result.stderr.strip()[:100]}")
                all_ok = False
        except Exception as e:
            print(f"    ✗ {name}: {e}")
            all_ok = False

    return all_ok


def main():
    parser = argparse.ArgumentParser(description="Set up embedded Python for Photonic Designer")
    parser.add_argument("--platform", choices=list(PYTHON_BUILDS.keys()),
                        help="Target platform (default: auto-detect)")
    parser.add_argument("--skip-python", action="store_true",
                        help="Skip Python download (use existing)")
    args = parser.parse_args()

    plat = args.platform or detect_platform()
    print(f"\n{'='*60}")
    print(f"  Photonic Designer — Python Environment Setup")
    print(f"  Platform: {plat}")
    print(f"  Python:   {PYTHON_VERSION}")
    print(f"  Target:   {EMBED_DIR}")
    print(f"{'='*60}\n")

    if plat not in PYTHON_BUILDS:
        print(f"  ✗ No Python build available for '{plat}'")
        sys.exit(1)

    # Step 1: Download & extract Python
    if not args.skip_python:
        archive_name = PYTHON_BUILDS[plat].split("/")[-1]
        archive_path = DOWNLOADS_DIR / archive_name
        download_file(PYTHON_BUILDS[plat], archive_path, f"Python {PYTHON_VERSION} ({plat})")
        extract_python(archive_path, EMBED_DIR)
    else:
        print("  (Skipping Python download — using existing)")

    # Step 2: Install packages
    install_packages(plat)

    # Step 3: Set up app source
    setup_app_source()

    # Step 4: Verify
    ok = verify_installation(plat)

    print(f"\n{'='*60}")
    if ok:
        print("  ✓ Setup complete! Run 'npm run dev' in electron/ to start.")
    else:
        print("  ⚠ Setup finished with warnings. Some imports may fail.")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
