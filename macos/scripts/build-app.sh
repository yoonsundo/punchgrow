#!/bin/zsh
set -euo pipefail

ROOT_DIR=${0:A:h:h}
cd "$ROOT_DIR"

# Use the toolchain's default matching SDK. Release builders may still select a
# verified compatible SDK explicitly, but guessing an older bundled SDK can
# break as soon as Command Line Tools updates its compiler.
if [[ -n ${PUNCHGROW_SDKROOT:-} ]]; then
  export SDKROOT="$PUNCHGROW_SDKROOT"
fi

export CLANG_MODULE_CACHE_PATH=${PUNCHGROW_CLANG_CACHE:-/tmp/punchgrow-clang-cache}
export SWIFTPM_MODULECACHE_OVERRIDE=${PUNCHGROW_SWIFTPM_CACHE:-/tmp/punchgrow-swiftpm-cache}

BUILD_PRODUCTS_DIR=$(swift build -c release --disable-sandbox --show-bin-path)
swift build -c release --disable-sandbox

RELEASE_EXECUTABLE="$BUILD_PRODUCTS_DIR/PunchGrowMenuBar"
RELEASE_RESOURCE_BUNDLE="$BUILD_PRODUCTS_DIR/PunchGrowMenuBar_PunchGrowMenuBar.bundle"
FINAL_APP_DIR="$ROOT_DIR/.build/PunchGrow.app"

[[ -x "$RELEASE_EXECUTABLE" ]] || {
  echo "Release executable not found: $RELEASE_EXECUTABLE" >&2
  exit 1
}
[[ -d "$RELEASE_RESOURCE_BUNDLE" ]] || {
  echo "SwiftPM resource bundle not found: $RELEASE_RESOURCE_BUNDLE" >&2
  exit 1
}

umask 077
STAGING_ROOT=$(mktemp -d "$ROOT_DIR/.build/.PunchGrow-stage.XXXXXX")
STAGED_APP_DIR="$STAGING_ROOT/PunchGrow.app"
ATOMIC_SWAP_TOOL="$STAGING_ROOT/atomic-swap"
APP_SWAPPED=false

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if (( exit_code != 0 )) && $APP_SWAPPED && [[ -x "$ATOMIC_SWAP_TOOL" ]]; then
    "$ATOMIC_SWAP_TOOL" "$STAGED_APP_DIR" "$FINAL_APP_DIR" || true
  fi
  rm -rf "$STAGING_ROOT"
  exit $exit_code
}
trap cleanup EXIT INT TERM

CONTENTS_DIR="$STAGED_APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
install -m 755 "$RELEASE_EXECUTABLE" "$MACOS_DIR/PunchGrowMenuBar"
cp -R "$RELEASE_RESOURCE_BUNDLE" "$RESOURCES_DIR/"
install -m 644 "$ROOT_DIR/../LICENSE" "$ROOT_DIR/../ASSET-LICENSE.md" "$RESOURCES_DIR/"
cp "$ROOT_DIR/homebrew/Info.plist" "$CONTENTS_DIR/Info.plist"

plutil -lint "$CONTENTS_DIR/Info.plist" >/dev/null
[[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$CONTENTS_DIR/Info.plist") == PunchGrowMenuBar ]]
[[ -x "$MACOS_DIR/PunchGrowMenuBar" ]]
[[ -f "$RESOURCES_DIR/LICENSE" && -f "$RESOURCES_DIR/ASSET-LICENSE.md" ]]

STAGED_RESOURCE_BUNDLE="$RESOURCES_DIR/${RELEASE_RESOURCE_BUNDLE:t}"
[[ -f "$STAGED_RESOURCE_BUNDLE/creatures.json" ]]
CREATURE_PNG_COUNT=$(find "$STAGED_RESOURCE_BUNDLE" -type f -name 'PG-*.png' | wc -l | tr -d '[:space:]')
[[ "$CREATURE_PNG_COUNT" == 256 ]] || {
  echo "Expected 256 creature PNGs, found $CREATURE_PNG_COUNT" >&2
  exit 1
}
for creature_number in {001..256}; do
  [[ -f "$STAGED_RESOURCE_BUNDLE/PG-$creature_number.png" ]] || {
    echo "Missing creature resource: PG-$creature_number.png" >&2
    exit 1
  }
done

codesign --force --sign - "$STAGED_APP_DIR"
codesign --verify --deep --strict "$STAGED_APP_DIR"

# Compile a minimal helper against the active toolchain so an existing bundle
# can be exchanged with the staged bundle in one filesystem operation.
printf '%s\n' \
  '#include <fcntl.h>' \
  '#include <stdio.h>' \
  '#include <unistd.h>' \
  'int main(int argc, char **argv) {' \
  '  if (argc != 3) return 64;' \
  '  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {' \
  '    perror("renameatx_np");' \
  '    return 1;' \
  '  }' \
  '  return 0;' \
  '}' | /usr/bin/clang -x c - -o "$ATOMIC_SWAP_TOOL"

if [[ -e "$FINAL_APP_DIR" ]]; then
  "$ATOMIC_SWAP_TOOL" "$STAGED_APP_DIR" "$FINAL_APP_DIR"
  APP_SWAPPED=true
else
  mv "$STAGED_APP_DIR" "$FINAL_APP_DIR"
fi

codesign --verify --deep --strict "$FINAL_APP_DIR"
echo "$FINAL_APP_DIR"
