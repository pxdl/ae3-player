# AE3 Asset Lab

[![CI](https://github.com/pxdl/ae3-player/actions/workflows/ci.yml/badge.svg)](https://github.com/pxdl/ae3-player/actions/workflows/ci.yml)

Explore audio, FMV, images, stage previews, models, animation, and collision
from an *Ape Escape 3* disc image.

[Open AE3 Asset Lab](https://pxdl.github.io/ae3-player/)

The app reads a user-supplied disc image in the browser. It uploads nothing,
keeps extracted assets in private browser storage, and includes no game data.

## Features

| Area | Capabilities |
| --- | --- |
| Audio | Sequenced music, streamed audio, and embedded sound effects; WebAssembly synthesis; live visualizers; WAV, MIDI, decoded sample, and source exports |
| FMV | Original MPEG-2 playback, captions, seeking, source and master archives, lossless MKV, and fast MP4 export |
| Images | TIM2 textures and sprite sheets from direct files and PCK packages; PNG and byte-exact source export |
| Stage previews | IPC stills with TIM2 title art; separate, composite, and source exports |
| 3D | I3D models, TIM2 materials, skeletal animation, and collision; interactive preview and GLB or source export |
| Disc report | Reproducible local compatibility scan for images, effect banks, and FMV metadata; complete JSON and Markdown table output |

## Use the app

1. Open the [hosted app](https://pxdl.github.io/ae3-player/).
2. Drop or select your own `.iso` file.
3. Choose a library from the sidebar. Asset Lab extracts each larger collection
   only when you first open it.

The disc reader accepts plain ISO9660 images with 2048-byte sectors. CHD, CSO,
raw BIN/CUE, and 2352-byte-sector dumps are not supported.

Completed extraction phases are cached in the browser's origin-private file
system (OPFS). Later visits can use those cached assets without the ISO. If a
library has not been cached yet, the app asks for the same ISO again. Use
`clear data` to remove the local session and its cache.

AE3 Asset Lab is an installable PWA. The application shell and any resources
already fetched by the browser remain available offline.

## Browser support

Chrome and Chromium are the reference browsers. Core playback and the ZIP and
MKV export paths do not require WebCodecs. Fast MP4 export requires H.264 and
AAC encoding through WebCodecs in a worker.

If OPFS is unavailable or the browser declines a write, the app reads from the
attached ISO for that session instead of persisting the extracted data.

### Disc build support

This matrix records client-side browsing through the real application flow.
Generate the automated portion from the app's **Report** tab or the equivalent
[`ae3-report` command in `ae3-sdk`](https://github.com/pxdl/ae3-sdk/tree/main/extract-web).
The measurements below used
[`ae3-sdk` revision `5b2207e3580ae4cc1d588641f4fe3f898350e501`](https://github.com/pxdl/ae3-sdk/commit/5b2207e3580ae4cc1d588641f4fe3f898350e501).
Named playback and rendering observations remain manual. `Untested` means no
claim is made for that build or asset family.

For each regional serial below, measurements cover one observed asset family
only. A serial does not establish whole-disc support; unmeasured families remain
`Untested`.
The UI keeps a conservative partial/untested warning for every non-US or
unknown serial, including builds with one measured family in this table.
The PAL beta reports the same `SCES_536.42` serial as retail; the measured PAL
row applies only to the retail build, and the beta remains untested.

| Build | Images | Effects | FMV |
| --- | --- | --- | --- |
| US retail (`SCUS_975.01`) | Tested: 11,931 textures / 11,950 pictures | Tested: 101 banks | Tested: 22/22 inspected |
| Japanese demo (`PCPX_966.57`) | Tested: 3,518 textures / 3,527 pictures; 22 declared entries without TIM2 signatures listed | Untested | Untested |
| Korean retail (`SCKA_200.62`) | Untested | Tested: 101 banks; `boss_specter` inspected | Untested |
| PAL retail (`SCES_536.42`) | Untested | Untested | Tested: 22/22 inspected; `new_play01` played |
| PAL beta (`SCES_536.42`; serial shared with retail) | Untested | Untested | Untested |
| All other builds and regions | Untested | Untested | Untested |

The Images tab reports package members that are declared as TIM2 but do not
contain a TIM2 signature. They stay out of the usable image catalog and appear
in an expandable list with their package, member index, size, and reason.

## Development

Use Node.js 20.19 or newer and npm. CI runs on Node.js 24.

```sh
npm ci
npm run dev
```

Run the project checks with:

```sh
npm run typecheck
npm test
npm run build
```

`npm run build` creates `dist/` and generates the PWA service worker at
`dist/sw.js`. Use `npm run preview` to serve that production build locally.

## Architecture

The data path is:

```text
ISO -> ISO9660 -> DATA.BIN -> VFI/PCK -> format decoders -> OPFS
```

The UI is written in TypeScript without a UI framework. Three.js renders 3D
assets. Movie and stage-preview decoding use a custom libav.js/FFmpeg
WebAssembly build, while Mediabunny provides the media container export path.

| Path | Role |
| --- | --- |
| `src/` | Application state, UI, workers, media pipelines, renderers, and cache stores |
| `src/vendor/extract/` | Vendored `@ae3/extract` TypeScript source |
| `public/synth/` | The WebAssembly synth binding plus AudioWorklet and export-worker modules, served without bundling |
| `public/libav/`, `vendor/libav/` | Deployed MPEG-2/IPU decoder and its reproducible source build |
| `tests/` | Node test suite for parsers, scheduling, presentation, and export behavior |

## Updating ae3-sdk

The browser extractor and synthesizer come from
[`ae3-sdk`](https://github.com/pxdl/ae3-sdk). With that repository checked out
next to this one:

```sh
make -C ../ae3-sdk/wasm
npm run sync-sdk
```

Set `AE3_SDK=/path/to/ae3-sdk` when the checkout is elsewhere. The sync command
copies the extractor and synth artifacts and records the source revision in
`src/vendor/SDK_COMMIT`.

## License

The AE3 Asset Lab source is licensed under the [MIT License](LICENSE), except
where an individual file says otherwise. Bundled components retain their
upstream licenses; exact versions, checksums, and source links are listed in
[`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt).
