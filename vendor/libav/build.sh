#!/bin/sh
set -eu

LIBAV_VERSION=6.9.8.1
LIBAV_COMMIT=65ce461de1add4c96bc74fac52bd239f900ec11f
LIBAV_SHA256=f6173cabac0000434f5d737ce41f21d5aaa4baa04e0116d2f203b1fd9a2554b4
FFMPEG_VERSION=8.1
FFMPEG_SHA256=b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a
EMFIBERTHREADS_VERSION=1.3
EMFIBERTHREADS_SHA256=0fe933d7742de3b3213608e0fb087a1ae0d060604d5835f7c9cdfcee0fc8cbcb
EMSCRIPTEN_VERSION=4.0.23
VARIANT=ae3-mpeg2

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
WORK=${TMPDIR:-/tmp}/ae3-libav-$LIBAV_COMMIT
SRC=$WORK/libav.js
OUT=$ROOT/public/libav

case "$(emcc --version | sed -n '1p')" in
    *" $EMSCRIPTEN_VERSION "*) ;;
    *) echo "error: emcc $EMSCRIPTEN_VERSION is required" >&2; exit 1 ;;
esac
case "$(node --version)" in
    v22.16.0) ;;
    *) echo "error: Node v22.16.0 from emsdk $EMSCRIPTEN_VERSION is required" >&2; exit 1 ;;
esac

rm -rf "$WORK"
mkdir -p "$SRC" "$OUT"
LIBAV_ARCHIVE=$WORK/libav.js-$LIBAV_COMMIT.tar.gz
FFMPEG_ARCHIVE=$SRC/build/ffmpeg-$FFMPEG_VERSION.tar.xz
EMFIBERTHREADS_ARCHIVE=$SRC/build/emfiberthreads-$EMFIBERTHREADS_VERSION.tar.gz

curl -fL --retry 3 \
    "https://github.com/Yahweasel/libav.js/archive/$LIBAV_COMMIT.tar.gz" \
    -o "$LIBAV_ARCHIVE"
printf '%s  %s\n' "$LIBAV_SHA256" "$LIBAV_ARCHIVE" | shasum -a 256 -c -
tar xzf "$LIBAV_ARCHIVE" --strip-components=1 -C "$SRC"

mkdir -p "$SRC/build"
curl -fL --retry 3 "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
    -o "$FFMPEG_ARCHIVE"
printf '%s  %s\n' "$FFMPEG_SHA256" "$FFMPEG_ARCHIVE" | shasum -a 256 -c -
curl -fL --retry 3 \
    "https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v$EMFIBERTHREADS_VERSION.tar.gz" \
    -o "$EMFIBERTHREADS_ARCHIVE"
printf '%s  %s\n' "$EMFIBERTHREADS_SHA256" "$EMFIBERTHREADS_ARCHIVE" | shasum -a 256 -c -

(
    cd "$SRC/configs"
    ./mkconfig.js "$VARIANT" "$(cat "$SCRIPT_DIR/config/ae3-mpeg2.json")"
)
(
    cd "$SRC"
    make \
        "dist/libav-$LIBAV_VERSION-$VARIANT.mjs" \
        "dist/libav-$LIBAV_VERSION-$VARIANT.wasm.mjs"
)

for artifact in \
    "libav-$LIBAV_VERSION-$VARIANT.mjs" \
    "libav-$LIBAV_VERSION-$VARIANT.wasm.mjs" \
    "libav-$LIBAV_VERSION-$VARIANT.wasm.wasm"
do
    install -m 0644 "$SRC/dist/$artifact" "$OUT/$artifact"
done

{
    printf '%s  %s\n' "$LIBAV_SHA256" "libav.js-$LIBAV_COMMIT.tar.gz"
    printf '%s  %s\n' "$FFMPEG_SHA256" "ffmpeg-$FFMPEG_VERSION.tar.xz"
    printf '%s  %s\n' "$EMFIBERTHREADS_SHA256" \
        "emfiberthreads-$EMFIBERTHREADS_VERSION.tar.gz"
    cd "$ROOT"
    shasum -a 256 \
        "public/libav/libav-$LIBAV_VERSION-$VARIANT.mjs" \
        "public/libav/libav-$LIBAV_VERSION-$VARIANT.wasm.mjs" \
        "public/libav/libav-$LIBAV_VERSION-$VARIANT.wasm.wasm"
} > "$SCRIPT_DIR/SHA256SUMS"

printf 'Built libav.js %s (%s) with FFmpeg %s and emcc %s.\n' \
    "$LIBAV_VERSION" "$LIBAV_COMMIT" "$FFMPEG_VERSION" "$EMSCRIPTEN_VERSION"
