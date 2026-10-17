#!/usr/bin/env bash
# Generates the RSA keypair used to pin a stable Chrome extension ID across
# every teammate's machine. Run once per team, commit nothing but the
# printed public key into wxt.config.ts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_KEY_FILE="$ROOT_DIR/extension-key.pem"

if [ -f "$PRIVATE_KEY_FILE" ]; then
  echo "A private key already exists at $PRIVATE_KEY_FILE" >&2
  echo "Delete it first if you really want to generate a new one (this changes the extension ID)." >&2
  exit 1
fi

openssl genrsa -out "$PRIVATE_KEY_FILE" 2048 2>/dev/null
chmod 600 "$PRIVATE_KEY_FILE"

PUBLIC_KEY_B64="$(openssl rsa -in "$PRIVATE_KEY_FILE" -pubout -outform DER 2>/dev/null | openssl base64 -A)"

echo "Private key written to: $PRIVATE_KEY_FILE (gitignored, do not share)"
echo
echo "Paste this into wxt.config.ts manifest.key:"
echo
echo "$PUBLIC_KEY_B64"
