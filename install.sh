#!/usr/bin/env bash
# Builds and installs the extension for the current user.
set -euo pipefail
cd "$(dirname "$0")"

UUID="clipboard-history-popup@bncgabriel.github.io"
bash pack.sh
gnome-extensions install --force "dist/$UUID.shell-extension.zip"

echo
echo "Installed. On Wayland, log out and back in, then run:"
echo "  gnome-extensions enable $UUID"
echo "and pick a shortcut in: gnome-extensions prefs $UUID"
