#!/usr/bin/env bash
set -euo pipefail

# Crea "Avvia dot.app": doppio clic -> apre il Terminale ed esegue npm start
# nella cartella del progetto (niente cd a mano).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$DIR/public/icons/icon-1024.png"
ICNS="$DIR/scripts/dot.icns"
APP="$DIR/Avvia dot.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1) icona .icns dall'icona PWA
mkdir -p "$WORK/dot.iconset"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$SRC" --out "$WORK/dot.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" "$SRC" --out "$WORK/dot.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/dot.iconset" -o "$ICNS"

# 2) applet AppleScript
cat > "$WORK/launcher.applescript" <<EOF
set projectDir to "$DIR"
set cmd to "export PATH=\\"/opt/homebrew/bin:/usr/local/bin:\$PATH\\"; cd " & quoted form of projectDir & " && clear && npm start"
tell application "Terminal"
	activate
	do script cmd
end tell
EOF

rm -rf "$APP"
osacompile -o "$APP" "$WORK/launcher.applescript"

PLIST="$APP/Contents/Info.plist"
set_p() { # set_p <comando Add|Set> <chiave> <tipo> <valore>
  /usr/libexec/PlistBuddy -c "Set :$2 $4" "$PLIST" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$2 $3 $4" "$PLIST"
}
set_p Set CFBundleName string "Avvia dot"
set_p Set CFBundleIconFile string dot.icns
set_p Set CFBundleIdentifier string com.tommaso.avvia-dot

# pulizia chiavi inutili del template applet
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PLIST" 2>/dev/null || true
for k in NSHomeKitUsageDescription NSAppleMusicUsageDescription \
         NSCalendarsUsageDescription NSSiriUsageDescription \
         NSCameraUsageDescription NSMicrophoneUsageDescription \
         NSAppleEventsUsageDescription NSRemindersUsageDescription \
         NSContactsUsageDescription NSPhotoLibraryUsageDescription \
         NSSystemAdministrationUsageDescription; do
  /usr/libexec/PlistBuddy -c "Delete :$k" "$PLIST" 2>/dev/null || true
done

cp "$ICNS" "$APP/Contents/Resources/dot.icns"
# l'asset catalog del template prevale su CFBundleIconFile: va rimosso
rm -f "$APP/Contents/Resources/Assets.car"

codesign --force --deep -s - "$APP"
touch "$APP"

echo "Creato: $APP"
