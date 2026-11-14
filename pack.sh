#!/usr/bin/env bash
# Builds the ZIP that is uploaded to extensions.gnome.org (output: dist/).
set -euo pipefail
cd "$(dirname "$0")"

UUID="clipboard-history-popup@bncgabriel.github.io"
mkdir -p dist
gnome-extensions pack "$UUID" \
  --extra-source=store.js \
  --extra-source=popup.js \
  --extra-source=icons \
  --podir=../po \
  --out-dir=dist \
  --force

echo "Created dist/$UUID.shell-extension.zip"
