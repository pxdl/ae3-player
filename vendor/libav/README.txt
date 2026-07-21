AE3 MPEG-2 playback decoder
===========================

This directory reproduces the separately loaded libav.js decoder used for local
FMV playback. It contains no game data. Normal Vite builds consume the checked-in
public/libav artifacts and do not require Emscripten.

Pinned inputs
-------------

- libav.js v6.9.8.1, commit 65ce461de1add4c96bc74fac52bd239f900ec11f
- FFmpeg 8.1 release source
- emfiberthreads v1.3
- Emscripten 4.0.23 (7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed)
- Node 22.16.0 supplied by that emsdk release

SHA256SUMS records the exact source archives and generated artifacts. The custom
fragment list is config/ae3-mpeg2.json. It deliberately links avformat, avcodec,
and avfilter in addition to selecting the MPEG video demuxer/parser/decoder and
buffer, format, and YADIF filters. The smaller initial hypothesis omitted those
library fragments and exposed no demux/decode/filter API; omitting filter-format
also made libav.js's ff_init_filter_graph unusable.

Build
-----

Activate emsdk 4.0.23 so emcc 4.0.23 and Node 22.16.0 are first on PATH, then run:

    ./vendor/libav/build.sh

The script downloads and verifies every source archive, generates the custom
configuration, builds only the non-threaded ES-module loader and WASM target,
installs the three public artifacts, and refreshes SHA256SUMS. ES modules are
required because the decoder runs in a Vite module worker; the classic loader's
`importScripts` path cannot coexist with Vite's development worker preamble.

Measured artifacts (2026-07-21, Apple M4 Pro)
---------------------------------------------

                                                     raw bytes   gzip -9 bytes
libav-6.9.8.1-ae3-mpeg2.mjs                             27,671          6,727
libav-6.9.8.1-ae3-mpeg2.wasm.mjs                       275,524         57,062
libav-6.9.8.1-ae3-mpeg2.wasm.wasm                      817,600        322,153
                                                     ---------        -------
total                                                 1,120,795        385,942

A warm local Bun 1.3.14 initialization took 6.90 ms and began with 25,165,824
bytes of WASM memory. Complete Chrome 150 decodes of one 17.65-second
progressive source and one 4.00-second bottom-field-first source retained that
fixed initial WASM allocation.

License/build audit
-------------------

The generated FFmpeg configuration has CONFIG_GPL=0, CONFIG_NONFREE=0,
CONFIG_VERSION3=0, and CONFIG_ENCODERS=0. MPEG-2 video is the only enabled
decoder. The only selected demuxer is mpegvideo; selected playback filters are
buffer, buffersink, format, and yadif. FFmpeg programs are disabled and no CLI
fragment is linked. Generated artifacts retain the upstream LGPL header.

LICENSE.libavjs.txt preserves the upstream project notice.
LICENSE.ffmpeg-lgpl-2.1.txt is FFmpeg's unmodified LGPL-2.1 text.

Playback proof findings
-----------------------

- Raw MPEG-2 opens through the mpegvideo demuxer and decodes to packed YUV420P.
- A 16 KiB packet-read budget can release 38 bobbed 512x448 frames
  (13,074,432 bytes) from one packet. The worker retains that bounded result and
  sub-batches main-thread transfers to the requested frame and byte budgets.
- FFmpeg's raw mpegvideo demuxer returned -1 for timestamp and byte av_seek_frame
  attempts. Reopening a readahead Blob sliced at an indexed sequence/GOP/I-picture
  anchor worked and produced the expected keyframe without copying the source.
- ae3-sdk commit 37889fd3580ac2b1a8294eab4de340adb4ca75f6 owns
  indexMpeg2SeekPoints(). A private 2026-07-21 gate over the supported US disc's
  22 streams found one sequence header and one temporal-reference-zero I-picture
  at every GOP anchor; no game bytes or private paths are retained here.
