#!/bin/bash
set -ex

if [ -z "$1" ]; then
  echo "Usage: $0 <path-to-app>" >&2
  exit 1
fi

APP="$1"

if [ ! -d "$APP" ]; then
  echo "Error: '$APP' not found or is not a directory" >&2
  exit 1
fi

# Strip all existing signatures
find "$APP" -type f -perm +111 -exec sh -c 'file "$1" | grep -q "Mach-O" && codesign --remove-signature "$1"' _ {} \;

# Ad-hoc sign all inner Mach-O binaries first
find "$APP/Contents/Frameworks" -type f -perm +111 -exec sh -c 'file "$1" | grep -q "Mach-O" && codesign --force --sign - "$1"' _ {} \;

# Sign all framework and app bundles inside Frameworks (after their contents are signed)
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -exec codesign --force --sign - {} \;
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -exec codesign --force --sign - {} \;

# Sign the main app
codesign --force --sign - "$APP"

# Remove quarantine
xattr -rd com.apple.quarantine "$APP" 2>/dev/null || true

echo "Done. Run: open $APP"
