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
| Audio | Sequenced music, streamed audio, and embedded sound effects; source/language filters; WebAssembly synthesis; live visualizers; WAV, MIDI, decoded sample, and source exports |
| FMV | Original MPEG-2 playback at the authored cadence, selectable audio and caption languages, seeking, source and master archives, lossless MKV, and fast MP4 export |
| Images | TIM2 textures and sprite sheets from direct files and PCK packages; PNG and byte-exact source export |
| Stage previews | Every localized IPC archive and its TIM2 title art; source/language selection; separate, composite, and source exports |
| 3D | I3D models, TIM2 materials, authored RGBA, skeletal animation, and collision; interactive preview and GLB or source export; lighting remains an approximation |
| Disc report | Reproducible local compatibility scan for images, effect banks, and FMV metadata; complete JSON and Markdown table output |

## Use the app

1. Open the [hosted app](https://pxdl.github.io/ae3-player/).
2. Drop or select your own `.iso` file.
3. Choose a library from the sidebar. Asset Lab extracts each larger collection
   only when you first open it.

The disc reader accepts plain ISO9660 images with 2048-byte sectors. CHD, CSO,
raw BIN/CUE, and 2352-byte-sector dumps are not supported.
The US demo's nested `APEESC3/DATA.BIN` archive is supported.

Completed extraction phases are cached in the browser's origin-private file
system (OPFS). Later visits can use those cached assets without the ISO. If a
library has not been cached yet, the app asks for the same ISO again. Reattaching
the ISO rebuilds interrupted or obsolete indexes without disabling writable
storage. Cached music payloads are verified before reuse. Use `clear data` to
remove the local session and its cache.

AE3 Asset Lab is an installable PWA. The application shell and any resources
already fetched by the browser remain available offline.

## Browser support

Chrome and Chromium are the reference browsers. Core playback and the ZIP and
MKV export paths do not require WebCodecs. Fast MP4 export requires H.264 and
AAC encoding through WebCodecs in a worker.

If OPFS is unavailable or the browser declines a write, the app reads from the
attached ISO for that session instead of persisting the extracted data.

### Disc build support

The table records extracted inventories, not a claim that every asset was
manually inspected. Generate image, effect-bank, and FMV metadata counts from
the app's **Report** tab. `Untested` means no claim is made for that family.
The UI retains a conservative warning for non-US and unknown serials.

The tested PAL beta (2006-02-21) and retail images share `SCES_536.42`.
A full byte comparison found their 3,919,091,712-byte `DATA.BIN` archives
identical; the PAL inventory below applies to those two images, not every
build with that serial. Playback checks used PAL retail.

Japanese-demo and Korean-retail observations below are retained from checks
using [`ae3-sdk` revision `5b2207e3580ae4cc1d588641f4fe3f898350e501`](https://github.com/pxdl/ae3-sdk/commit/5b2207e3580ae4cc1d588641f4fe3f898350e501).

| Build | Images | Effects | FMV |
| --- | --- | --- | --- |
| US retail (`SCUS_975.01`) | Tested: 11,931 textures / 11,950 pictures | Tested: 101 banks | Tested: 22/22 inspected |
| Japanese demo (`PCPX_966.57`) | Tested: 3,518 textures / 3,527 pictures; 22 declared entries without TIM2 signatures listed | Untested | Untested |
| Korean retail (`SCKA_200.62`) | Untested | Tested: 101 banks; `boss_specter` inspected | Untested |
| PAL retail (`SCES_536.42`) | Tested: 25,353 textures / 25,380 pictures; 4 declared non-TIM2 members listed | Tested: 505 banks across 5 languages | Tested: 22 movies / 50 localized caption pairs |
| PAL beta (2006-02-21; `SCES_536.42`) | Same verified asset archive as retail | Same verified asset archive as retail | 22 movies / 50 localized caption pairs independently inspected |
| All other builds and regions | Untested | Untested | Untested |

The Images tab reports package members that are declared as TIM2 but do not
contain a TIM2 signature. They stay out of the usable image catalog and appear
in an expandable list with their package, member index, size, and reason.

The four PAL entries are `ape_nrm02_b.tm2` in
`debug/{de,es,fr,it}/etc/title/bg_c/character.pck.sz`. Their source bytes do not
contain TIM2 signatures; they remain explicit skipped diagnostics rather than
fabricated images.

Additional checks:

- US demo (`SCUS_975.48`): 20 complete music cues extracted and resumed from
  cache; `b_1_white_brass` played in the production build. Incomplete
  retail-table references are not offered as playable cues.
- PAL: 4,670 streams, including all five nested language archives and loose UK
  streams; 505 effect banks; five stage archives with 28 slots each. Source
  paths remain distinct in selection, cache keys, and exports.
- PAL retail playback: French `phone_001`, Spanish `boss_specter` request 95:3,
  and stage-preview decoding through all five language choices.
- PAL FMV: all five audio/caption choices exercised. `new_scene02` played to
  completion at 25 fps with measured presentation/audio-clock skew below
  20 ms; interlaced `new_play01` presented at 50 fps with skew below 10 ms.
  Italian MKV output retained 25 fps, Italian audio/subtitle tags, and the
  32.64-second duration. These clock checks are not a subjective lip-sync audit.
- US retail rendering: authored cyan glass and its alpha survive preview and
  GLB export; opaque zero-alpha-texture materials remain visible. A 300-selection
  mixed 3D browsing run returned to constant GPU resource counts with at most
  three expanded packages retained. Exact retail VU1 lighting and GS rendering
  are not yet reproduced.

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
