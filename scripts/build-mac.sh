#!/usr/bin/env bash
# Builds the AppQA macOS app (Debug, ad-hoc signed) with this checkout baked in as the engine root.
# Usage: bash scripts/build-mac.sh   → prints the .app path on the last line.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED="$ROOT/.tools/mac-build"

command -v xcodegen >/dev/null || { echo "xcodegen 가 필요합니다: brew install xcodegen" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "xcodebuild 가 필요합니다 (Xcode)" >&2; exit 1; }

(cd "$ROOT/mac" && xcodegen generate --quiet)

xcodebuild \
  -project "$ROOT/mac/AppQA.xcodeproj" \
  -scheme AppQA \
  -configuration Debug \
  -derivedDataPath "$DERIVED" \
  -destination 'generic/platform=macOS' \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM= \
  APPQA_ROOT="$ROOT" \
  build -quiet

APP="$DERIVED/Build/Products/Debug/AppQA.app"
[ -d "$APP" ] || { echo "빌드 산출물이 없습니다: $APP" >&2; exit 1; }
echo "$APP"
