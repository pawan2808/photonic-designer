#!/usr/bin/env python3
"""
generate_license.py — Generate license keys and optionally push to Google Sheet.

Usage:
  python scripts/generate_license.py --count 10
  python scripts/generate_license.py --count 5 --expiry 2027-01-01
  python scripts/generate_license.py --count 1 --push  # Push to Google Sheet
"""

import argparse
import secrets
import string
import json
from datetime import datetime
from pathlib import Path


def generate_key(segments=4, length=4):
    """Generate a license key like XXXX-XXXX-XXXX-XXXX."""
    charset = string.ascii_uppercase + string.digits
    # Remove ambiguous characters
    charset = charset.replace('O', '').replace('0', '').replace('I', '').replace('1', '').replace('L', '')
    parts = []
    for _ in range(segments):
        parts.append(''.join(secrets.choice(charset) for _ in range(length)))
    return '-'.join(parts)


def main():
    parser = argparse.ArgumentParser(description="Generate Photonic Designer license keys")
    parser.add_argument("--count", type=int, default=1, help="Number of keys to generate")
    parser.add_argument("--expiry", type=str, default="", help="Expiry date (YYYY-MM-DD), empty=perpetual")
    parser.add_argument("--push", action="store_true", help="Push keys to Google Sheet")
    parser.add_argument("--output", type=str, default="", help="Save keys to file")
    args = parser.parse_args()

    keys = []
    for i in range(args.count):
        key = generate_key()
        keys.append({
            "key": key,
            "fingerprint": "",
            "status": "UNUSED",
            "expiry": args.expiry,
            "last_seen": "",
            "version": "",
            "email": "",
            "notes": f"Generated {datetime.now().isoformat()}"
        })

    # Print keys
    print(f"\n{'='*50}")
    print(f"  Generated {args.count} license key(s)")
    print(f"{'='*50}")
    for k in keys:
        exp = k["expiry"] or "perpetual"
        print(f"  {k['key']}  (expires: {exp})")
    print(f"{'='*50}\n")

    # Save to file
    if args.output:
        out = Path(args.output)
        with open(out, 'w') as f:
            json.dump(keys, f, indent=2)
        print(f"  Saved to {out}")

    # Push to Google Sheet
    if args.push:
        try:
            from google.oauth2.service_account import Credentials
            from googleapiclient.discovery import build

            config_path = Path(__file__).parent.parent / "config" / "license_config.json"
            creds_path = Path(__file__).parent.parent / "config" / "google_credentials.json"

            if not config_path.exists() or not creds_path.exists():
                print("  ✗ Missing config/license_config.json or config/google_credentials.json")
                return

            config = json.loads(config_path.read_text())
            creds = Credentials.from_service_account_file(
                str(creds_path),
                scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
            service = build('sheets', 'v4', credentials=creds)

            rows = [[k["key"], "", "UNUSED", k["expiry"], "", "", "", k["notes"]] for k in keys]
            service.spreadsheets().values().append(
                spreadsheetId=config["sheetId"],
                range="Sheet1!A:H",
                valueInputOption="USER_ENTERED",
                body={"values": rows}
            ).execute()

            print(f"  ✓ Pushed {len(keys)} key(s) to Google Sheet")
        except ImportError:
            print("  ✗ Install googleapis: pip install google-auth google-api-python-client")
        except Exception as e:
            print(f"  ✗ Push failed: {e}")


if __name__ == "__main__":
    main()
