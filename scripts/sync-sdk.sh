#!/bin/sh
# Vendor the SDK artifacts this app consumes (no npm packages yet -- WEB_PORT_PLAN
# §9.4: the player vendors built artifacts; publish to npm only if demand appears).
#
#   @ae3/extract  -> src/vendor/extract/   (TS source, bundled into the app)
#   @ae3/synth    -> public/synth/         (binding .mjs + .wasm, served verbatim:
#                    the AudioWorklet loads them unbundled -- see public/synth/README)
#
# Source checkout: $AE3_SDK, or the private repo's submodule next to this clone.
set -eu
SDK="${AE3_SDK:-$(dirname "$0")/../../ape-escape-3-recreation/ae3-sdk}"
DST="$(dirname "$0")/.."
[ -f "$SDK/wasm/dist/ae3synth.wasm" ] || {
    echo "no SDK at $SDK (set AE3_SDK, and 'make' in wasm/ if dist is missing)" >&2
    exit 1
}
mkdir -p "$DST/src/vendor/extract" "$DST/public/synth"
cp "$SDK"/extract-web/src/*.ts "$DST/src/vendor/extract/"
cp "$SDK/wasm/js/ae3synth.mjs" "$SDK/wasm/js/wav.mjs" \
   "$SDK/wasm/dist/ae3synth.wasm" "$DST/public/synth/"
GIT_SHA=$(git -C "$SDK" rev-parse HEAD 2>/dev/null || echo unknown)
printf 'ae3-sdk %s\nsynced  %s\n' "$GIT_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$DST/src/vendor/SDK_COMMIT"
echo "vendored ae3-sdk @ $GIT_SHA"
