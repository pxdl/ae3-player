# AE3 Asset Lab

AE3 Asset Lab is a browser-based asset explorer for Ape Escape 3. Point it at
your own game disc image and it extracts everything it needs in the browser.
Nothing is uploaded, and the repository ships no game data.

The app plays the game's sequenced music, streamed audio, embedded sound
effects, and all 22 full-motion videos, and browses every TIM2 image and sprite
sheet. Sequenced audio runs through a WebAssembly build of the
[ae3-sdk](https://github.com/pxdl/ae3-sdk) synthesizer.

## Music and audio

After you choose an ISO, the app extracts assets into an OPFS cache. Use
`clear data` to close the session, remove those cached assets, and return to the
disc picker. Interrupted extractions resume where they stopped, and the app
reports wrong, truncated, or non-AE3 images and unplugged drives directly.

The music library contains all 68 BGM songs at their authored per-song volumes.
Playback runs in an AudioWorklet with latency-aligned transport and seeking.
Controls cover loops, timing, interpolation, reverb, and volume. The UI also has
a loop-unwound piano roll, live voice slots, waveform and clipping meters, and
exports for Worker-rendered WAV, raw MIDI, bank pairs, and decoded sample kits.

The Streams tab lazily extracts 341 MB of music, dialogue, and cutscene audio.
It has waveform and spectrogram transport, pad-aware decoding, and raw `.x` or
WAV export.

The sound-effect library contains 101 banks and 2,699 assembled bank:request
entries, all played through the same 48-voice synth. Requests can use exact or
console-tick timing, caller volume, bright or Gaussian resampling, and reverb.
The transport seeks by time or event score. Its displays include the 48 voice
slots, the live output waveform, and a 480 Hz bytecode score with command values
and markers for samples, noise, source loops, and reverb sources.

Looped sound effects get a separate live panel. Each active voice keeps a stable
row with its intro and loop boundaries, decoder phase, seam count, and an ADSR
display that continues across source seams. The panel reports the event cycle,
measured audible completion, and authored source-envelope lifetime separately.
Infinite stream jumps can either loop or run once. Sample loops stay identified
even when their envelopes are finite, and velocity-zero stop requests are shown
as controls rather than silent effects. WAV export can render one pass or stop
at 10, 30, or 60 seconds. Raw `.hd` and `.bd` bank export is also available.

## Images and sprite sheets

The Images tab scans direct TIM2 files and every TIM2 member of the disc's
compressed PCK packages. The searchable catalog preserves the package path,
member attributes, picture count, dimensions, pixel format, and original byte
size. A lazy thumbnail grid is the default; a dense flat list and a
source-hierarchy tree provide alternate views. The desktop asset browser is
horizontally resizable, and the grid adds or removes columns with its width.
Grid and list results append automatically near the end of the scroll, while
tree folders populate only when opened.
Category filters first use exact UIS/I3D references in the same package, then
unambiguous package context. Still-unresolved assets are checked for references
from other packages. A `ui_` name prefix is used only as the final sprite
fallback when no format reference exists, and the inspector identifies that
lower-confidence evidence explicitly. Remaining ambiguous assets stay under
Other.

Previews decode locally from IDTEX4, IDTEX8, RGBA16, RGB24, or RGBA32 into a
checkerboard canvas. The decoder linearizes GS CSM1 palettes and expands the
PS2 0..128 alpha range to browser RGBA. A selected picture exports as PNG or as
its byte-exact source `.tm2`; Export All PNG preserves the package hierarchy in
one ZIP and avoids a second archive-sized memory copy. Multi-picture TIM2 files
produce one catalog row and PNG per picture. Completed scans and the original
source containers stay in the disc's OPFS cache for later ISO-free browsing
without creating one browser file per texture.
Declared TIM2 dimensions are preserved exactly: transparent margins authored
into a texture or sprite sheet are displayed and exported rather than cropped.

## FMV playback and export

The FMV tab scans the 22-movie catalog without loading every movie, then reads
and caches only the one you select. Clicking a movie carries the play request
through the source read, decoder startup, canvas attachment, and priming, so it
starts without another click. Keyboard selection prepares the first frame but
does not start playback.

A dedicated worker decodes bounded batches from the original MPEG-2 elementary
stream with a custom LGPL libav.js/FFmpeg WebAssembly build. WebGL2 presents the
packed I420 frames while the decoded WAV supplies the master clock. The SDK's
7:6 sample aspect ratio sets the displayed picture box; the WebGL backing store
keeps the coded source dimensions. Interlaced video uses bob deinterlacing at
59.94 fps. Local captions are available for the ten subtitled scenes.

The two-row transport sits below the picture. It stays with the captions and
picture controls in fullscreen. Four export options are available:

- Original ZIP preserves the `.str`, `.bin`, and `.sbt` files byte for byte.
- Masters ZIP contains the original MPEG-2 stream, decoded WAV, and SRT captions.
- Lossless MKV remuxes the original MPEG-2 with decoded 16-bit PCM and optional
  embedded WebVTT captions.
- Fast MP4 uses browser-encoded H.264 and AAC.

MKV and MP4 exports run in a separate worker, so export work does not share the
playback worker. FMV playback and export live in the Asset Lab's FMV tab. Monkey
TV appears as a disabled, in-development option.

## Offline use and browser support

The app is a PWA. After the first visit, its shell works offline and cached
assets play without the ISO. The MPEG-2 decoder and movie export modules are not
part of the initial precache; the app fetches and caches each one on first use.

Chrome and Chromium are the reference browsers. Core audio, playback, the UI,
and Lossless MKV export do not require WebCodecs. Fast MP4 does require AVC and
AAC encoding through WebCodecs in a worker. When those encoders are unavailable,
the app says so and keeps Original ZIP, Masters ZIP, and Lossless MKV enabled.

Safari creates its `AudioContext` inside the first click because autoplay
permission is tied to the gesture that created it. A context created at page
load may remain interrupted under stricter per-site Auto-Play settings. If audio
does not start, check Safari Settings > Websites > Auto-Play and the tab's mute
state. `Promise.withResolvers` requires Safari 17.4 or newer. OPFS writes require
Safari 18.2 or newer and may still be declined by the browser; in that case, the
app reads from the ISO again on the next visit.

Testing on July 21, 2026 covered original MPEG-2 playback in Chrome 150, Firefox
152, and Safari 26.4. The tested paths included progressive video, bobbed
interlaced video, captions, seeking, cache resume, and complete movies. The
one-click startup path was also tested in all three browsers with a delayed
source read and a cold decoder. Each browser reached `playing` without getting
stuck at `ready` or suppressing an autoplay rejection.

## Architecture

- `src/` contains the Vite and TypeScript app: disc sessions, OPFS extraction,
  worklet control, timelines, media stores, the movie playback pipeline, lazy
  export, and the UI. It does not use a framework.
- `src/vendor/extract/` is the bundled TypeScript source for `@ae3/extract`.
- `public/synth/` contains the unbundled audio path: the vendored `@ae3/synth`
  binding, `ae3synth.wasm`, the app engine, and its `AudioWorkletProcessor`.
  These files are served verbatim. See `public/synth/README.md` for details.
- `public/libav/` and `vendor/libav/` contain the reproducible minimal LGPL
  MPEG-2 decoder, its deployed source bundle, pinned configuration, checksums,
  and build script.

Run `npm run sync-sdk` to refresh vendored SDK artifacts. Set `AE3_SDK` if the
SDK checkout is not in the default sibling directory. The command records the
source revision in `src/vendor/SDK_COMMIT`.

The private research repository contains the audio equality gate because it
needs a disc. It checks engine output against the SDK's native `wavdump`, along
with worklet-quantum rendering and seek continuity.

## Development

```
npm install
npm run sync-sdk   # only when bumping the SDK
npm run dev        # or: npm run build && npm run preview
npm run typecheck
npm test
```

`npm run build` also generates `dist/sw.js`, the precache service worker, through
`scripts/gen-sw.mjs`. GitHub Pages deployments use
`.github/workflows/deploy.yml` on every push to `main`. Once the repository is
public, Pages must use the "GitHub Actions" source.

## Licensing

The application source is MIT-licensed. FMV playback and Fast MP4 frame
extraction use a custom libav.js/FFmpeg build under LGPL-2.1-or-later. Movie
muxing includes parts of Mediabunny and the MPEG-2 Matroska codec registration
in `scripts/patch-mediabunny-mpeg2.mjs`, under MPL-2.0.

The notices retain the former `@ffmpeg/*` GPL source offer because one older
service-worker cache can still serve that release. Exact versions, license
links, checksums, and corresponding-source links are in
[`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt).

License: MIT.
