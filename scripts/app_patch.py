#!/usr/bin/env python3
"""
app_patch.py — Patches app.py for Electron integration.

Adds:
  1. FLASK_PORT environment variable support
  2. Static file serving for the React frontend (index.html + App.jsx)
  3. Disables debug mode in production

Run once during build:  python scripts/app_patch.py
"""

import re
from pathlib import Path

SRC = Path(__file__).parent.parent / "src" / "app.py"


def patch():
    if not SRC.exists():
        print(f"  [FAIL] {SRC} not found")
        return

    code = SRC.read_text(encoding="utf-8")

    # 1. Patch the __main__ block to use FLASK_PORT env var and serve static files
    old_main = '''if __name__ == "__main__":
    print(f"\\n  Photonic Designer Backend")
    print(f"  nazca available: {NAZCA_AVAILABLE}")
    print(f"  http://localhost:5000\\n")
    app.run(debug=True, port=5000)'''

    new_main = '''# ── Static file serving for Electron (serves index.html + App.jsx) ──────────
import mimetypes
mimetypes.add_type('application/javascript', '.jsx')

@app.route('/')
def serve_index():
    return send_file(os.path.join(os.path.dirname(__file__), 'index.html'))

@app.route('/<path:filename>')
def serve_static(filename):
    filepath = os.path.join(os.path.dirname(__file__), filename)
    if os.path.isfile(filepath):
        return send_file(filepath)
    return "Not found", 404


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    is_production = os.environ.get("FLASK_ENV") == "production"
    print(f"\\n  Photonic Designer Backend")
    print(f"  nazca available: {NAZCA_AVAILABLE}")
    print(f"  http://localhost:{port}\\n")
    app.run(debug=not is_production, port=port, host="127.0.0.1")'''

    if old_main in code:
        code = code.replace(old_main, new_main)
        SRC.write_text(code, encoding="utf-8")
        print("  [OK] app.py patched for Electron integration")
    elif "FLASK_PORT" in code:
        print("  (app.py already patched)")
    else:
        # Try a more flexible match
        code = re.sub(
            r'if __name__\s*==\s*["\']__main__["\']\s*:.*$',
            new_main,
            code,
            flags=re.DOTALL
        )
        SRC.write_text(code, encoding="utf-8")
        print("  [OK] app.py patched (flexible match)")


if __name__ == "__main__":
    patch()