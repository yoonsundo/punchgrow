#!/bin/zsh
set -euo pipefail

ROOT_DIR=${0:A:h:h}
cd "$ROOT_DIR"

if [[ -n ${PUNCHGROW_SDKROOT:-} ]]; then
  export SDKROOT="$PUNCHGROW_SDKROOT"
fi
export CLANG_MODULE_CACHE_PATH=${PUNCHGROW_CLANG_CACHE:-/tmp/punchgrow-clang-cache}
export SWIFTPM_MODULECACHE_OVERRIDE=${PUNCHGROW_SWIFTPM_CACHE:-/tmp/punchgrow-swiftpm-cache}

OUTPUT_PATH=${1:-$ROOT_DIR/.build/menu-popover-snapshot.png}
SNAPSHOT_KIND=${2:-menu}
mkdir -p "${OUTPUT_PATH:h}"

BUILD_PRODUCTS_DIR=$(swift build -c debug --disable-sandbox --show-bin-path)
swift build -c debug --disable-sandbox
case "$SNAPSHOT_KIND" in
  menu)
    SNAPSHOT_FLAG=--snapshot-menu-popover
    EXPECTED_WIDTH=398
    EXPECTED_HEIGHT=670
    ;;
  menu-fresh)
    SNAPSHOT_FLAG=--snapshot-menu-popover-fresh
    EXPECTED_WIDTH=398
    EXPECTED_HEIGHT=670
    ;;
  evolution)
    SNAPSHOT_FLAG=--snapshot-evolution-dex
    EXPECTED_WIDTH=372
    EXPECTED_HEIGHT=620
    ;;
  evolution-mutant)
    SNAPSHOT_FLAG=--snapshot-evolution-mutant
    EXPECTED_WIDTH=372
    EXPECTED_HEIGHT=620
    ;;
  evolution-choice)
    SNAPSHOT_FLAG=--snapshot-evolution-choice
    EXPECTED_WIDTH=372
    EXPECTED_HEIGHT=520
    ;;
  mutation-offer)
    SNAPSHOT_FLAG=--snapshot-mutation-offer
    EXPECTED_WIDTH=372
    EXPECTED_HEIGHT=420
    ;;
  rarity)
    SNAPSHOT_FLAG=--snapshot-rarity-guide
    EXPECTED_WIDTH=360
    EXPECTED_HEIGHT=490
    ;;
  menu-bar-hud)
    SNAPSHOT_FLAG=--snapshot-menu-bar-hud
    EXPECTED_WIDTH=852
    EXPECTED_HEIGHT=352
    ;;
  grant-toast)
    SNAPSHOT_FLAG=--snapshot-grant-toast
    EXPECTED_WIDTH=380
    EXPECTED_HEIGHT=260
    ;;
  action-notice)
    SNAPSHOT_FLAG=--snapshot-action-notice
    EXPECTED_WIDTH=380
    EXPECTED_HEIGHT=220
    ;;
  level-max)
    SNAPSHOT_FLAG=--snapshot-level-max
    EXPECTED_WIDTH=398
    EXPECTED_HEIGHT=670
    ;;
  menu-group)
    SNAPSHOT_FLAG=--snapshot-menu-group
    EXPECTED_WIDTH=398
    EXPECTED_HEIGHT=670
    ;;
  *)
    echo "Unknown snapshot kind: $SNAPSHOT_KIND" >&2
    exit 2
    ;;
esac

"$BUILD_PRODUCTS_DIR/PunchGrowMenuBar" "$SNAPSHOT_FLAG" "$OUTPUT_PATH"

[[ -f "$OUTPUT_PATH" ]]
PIXEL_WIDTH=$(sips -g pixelWidth "$OUTPUT_PATH" | awk '/pixelWidth/ { print $2 }')
PIXEL_HEIGHT=$(sips -g pixelHeight "$OUTPUT_PATH" | awk '/pixelHeight/ { print $2 }')
[[ "$PIXEL_WIDTH" == "$EXPECTED_WIDTH" && "$PIXEL_HEIGHT" == "$EXPECTED_HEIGHT" ]] || {
  echo "Unexpected snapshot dimensions: ${PIXEL_WIDTH}x${PIXEL_HEIGHT}" >&2
  exit 1
}
if [[ "$SNAPSHOT_KIND" == evolution ]]; then
  node "$ROOT_DIR/scripts/verify-evolution-dex-snapshot.mjs" "$OUTPUT_PATH"
fi
if [[ "$SNAPSHOT_KIND" == menu || "$SNAPSHOT_KIND" == menu-fresh ]]; then
  node "$ROOT_DIR/scripts/verify-menu-popover-snapshot.mjs" "$OUTPUT_PATH"
fi
echo "Rendered $OUTPUT_PATH (${PIXEL_WIDTH}x${PIXEL_HEIGHT})"
