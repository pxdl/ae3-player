AE3 MPEG-2 and IPU decoder
=========================

This directory reproduces the separately loaded libav.js decoder used for local
FMV playback and 256x256 stage-preview stills. It contains no game data. Normal
Vite builds consume the checked-in public/libav artifacts and do not require
Emscripten.

Pinned inputs
-------------

- libav.js v6.9.8.1, commit 65ce461de1add4c96bc74fac52bd239f900ec11f
- FFmpeg 8.1 release source
- emfiberthreads v1.3
- Emscripten 4.0.23 (7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed)
- Node 22.16.0 supplied by that emsdk release

SHA256SUMS records the exact source archives, generated runtime artifacts, and
corresponding-source bundle. The custom fragment list is
config/ae3-mpeg2.json. It deliberately links avformat, avcodec, and avfilter;
selects the raw MPEG video and IPU demuxers and parsers; enables the MPEG-2
video and IPU decoders; and retains the playback buffer, format, and YADIF
filter support. The smaller initial hypothesis omitted those library fragments
and exposed no demux/decode/filter API; omitting filter-format also made
libav.js's ff_init_filter_graph unusable.

Build
-----

Activate emsdk 4.0.23 so emcc 4.0.23 and Node 22.16.0 are first on PATH, then run:

    ./vendor/libav/build.sh

The script downloads and verifies every source archive, generates the custom
configuration, builds only the non-threaded ES-module loader and WASM target,
installs the three public runtime artifacts, creates their corresponding-source
bundle, and refreshes SHA256SUMS. ES modules are required because the decoder
runs in Vite module workers; the classic loader's importScripts path cannot
coexist with Vite's development worker preamble.

Measured runtime artifacts (2026-08-09, Apple M4 Pro)
-----------------------------------------------------

                                                     raw bytes   gzip -9 bytes
libav-6.9.8.1-ae3-mpeg2.mjs                             27,671          6,727
libav-6.9.8.1-ae3-mpeg2.wasm.mjs                       275,524         57,062
libav-6.9.8.1-ae3-mpeg2.wasm.wasm                      821,748        323,837
                                                     ---------        -------
total                                                 1,124,943        387,626

Chrome decoded one 256x256 retail stage still from both the US retail disc and
Japanese in-store demo with this build. The dedicated still-image worker
retains only one decoded RGBA frame and shares no playback scheduling or audio
path.

License/build audit
-------------------

The generated FFmpeg configuration has CONFIG_GPL=0, CONFIG_NONFREE=0,
CONFIG_VERSION3=0, and CONFIG_ENCODERS=0. MPEG-2 video and IPU are the only
enabled decoders. The selected demuxers are mpegvideo and ipu, with their
corresponding parsers. Playback retains buffer source/sink support plus the
format and yadif filters. FFmpeg programs are disabled and no CLI fragment is
linked. Generated artifacts retain the upstream LGPL header.

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

Stage-preview still proof findings
----------------------------------

- ae3-sdk commit 3586deb170ac53dd2a5dd91423534e3fbc591e96 owns the IPC
  validation and IPC-to-IPUM bridge. Both tested discs contain 28 slots,
  224 IPC stills, and 28 TIM2 title images; every observed IPC control word is
  0x0062, and the bridge inserts its low byte before the macroblock stream.
- FFmpeg's IPU decoder writes raster-order YUV420P. For a retail seaside frame,
  that output was byte-identical to the external GPL IPUenc oracle's mode 1.
  Repositioning 16x16 luma and 8x8 chroma macroblocks into IPUenc's column-major
  mode-2 destination was then byte-identical to the oracle's mode 2.
- The shipped worker performs only that post-decode macroblock placement and
  YUV-to-RGBA conversion. No IPUenc source or GPL implementation is included.
