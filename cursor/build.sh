#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/cursor_helper"

swiftc -O "$DIR/cursor_helper.swift" -o "$OUT" -framework CoreGraphics -framework ApplicationServices -framework AppKit

echo "Helper compilato: $OUT"
