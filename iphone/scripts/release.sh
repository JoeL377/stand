#!/bin/bash
# Builds Stand for iPhone and uploads it to TestFlight. Run on a Mac with Xcode, signed in to the
# team's Apple account in Xcode (Settings > Accounts). From the repo root: npm --prefix iphone run release
#
#   --no-upload   build and sign the .ipa, but leave it on this Mac (iphone/build/export/App.ipa)
#   VERSION=1.1   the version people see (default: what the project says). The build number is the
#                 time (YYYYMMDDHHMM), so each upload is newer than the last without keeping count.
#
# Xcode's own Product > Archive wants a development profile, which Apple only makes for a team with
# a registered iPhone. So this archives unsigned, marks the app with the entitlements it needs, and
# lets the export step sign it for the App Store (that profile needs no device).
set -euo pipefail

UPLOAD=1
[ "${1:-}" = "--no-upload" ] && UPLOAD=0

cd "$(dirname "$0")/.."
ROOT="$PWD"
TEAM="${TEAM:-DV9FSZ65K2}"
BUNDLE_ID="studio.conxt.stand"
BUILD="${BUILD:-$(date +%Y%m%d%H%M)}"
OUT="$ROOT/build"
ARCHIVE="$OUT/Stand.xcarchive"
EXPORT="$OUT/export"

command -v xcodebuild >/dev/null || { echo "Xcode isn't installed (xcodebuild not found)." >&2; exit 1; }

echo "==> Stand for iPhone, build $BUILD${VERSION:+, version $VERSION}"
npm install --no-audit --no-fund >/dev/null
npx cap sync ios >/dev/null

rm -rf "$ARCHIVE" "$EXPORT"
mkdir -p "$OUT"

echo "==> Archiving"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="$BUILD" ${VERSION:+MARKETING_VERSION="$VERSION"} \
  CODE_SIGNING_ALLOWED=NO archive | grep -E "(^|[^-])error:|warning: .*(AppDelegate|SceneDelegate)|ARCHIVE (SUCCEEDED|FAILED)" || true
[ -d "$ARCHIVE/Products/Applications/App.app" ] || { echo "The archive failed. Run the xcodebuild line above without the grep to see why." >&2; exit 1; }

# What the App Store build is entitled to: Apple push on the real servers.
ENT="$OUT/release.entitlements"
cat > "$ENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>$TEAM.$BUNDLE_ID</string>
	<key>com.apple.developer.team-identifier</key>
	<string>$TEAM</string>
	<key>aps-environment</key>
	<string>production</string>
</dict>
</plist>
PLIST
codesign --force --sign - --entitlements "$ENT" "$ARCHIVE/Products/Applications/App.app"

OPTS="$OUT/ExportOptions.plist"
cat > "$OPTS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>$([ "$UPLOAD" = 1 ] && echo upload || echo export)</string>
	<key>teamID</key>
	<string>$TEAM</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
PLIST

echo "==> $([ "$UPLOAD" = 1 ] && echo "Signing and uploading to App Store Connect" || echo "Signing (no upload)")"
LOG="$OUT/export.log"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$OPTS" -allowProvisioningUpdates > "$LOG" 2>&1 || true
grep -E "(^|[^-])error:|EXPORT (SUCCEEDED|FAILED)|Upload|upload" "$LOG" || true
grep -q "EXPORT SUCCEEDED" "$LOG" || { echo "Signing$([ "$UPLOAD" = 1 ] && echo " or uploading") failed; the full log is $LOG." >&2; exit 1; }

if [ "$UPLOAD" = 1 ]; then
  echo "==> Sent build $BUILD. Apple processes it for 10 to 20 minutes, then TestFlight offers it to testers."
else
  [ -f "$EXPORT/App.ipa" ] || { echo "The export failed." >&2; exit 1; }
  # Proof the signed app can take push notifications.
  rm -rf "$OUT/check" && mkdir -p "$OUT/check" && unzip -q "$EXPORT/App.ipa" -d "$OUT/check"
  APP="$OUT/check/Payload/App.app"
  APS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -extract aps-environment raw -o - - 2>/dev/null || true)"
  [ "$APS" = production ] || { echo "The signed app's push entitlement is '${APS:-missing}', not production." >&2; exit 1; }
  echo "    aps-environment $APS"
  echo "    $(codesign -dv --verbose=2 "$APP" 2>&1 | grep -m1 '^Authority=' | cut -d= -f2)"
  echo "    version $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist"), build $(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP/Info.plist")"
  echo "==> Built $EXPORT/App.ipa (build $BUILD), not uploaded."
fi
