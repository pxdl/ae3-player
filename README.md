# ae3-player

Browser player and local media viewer for Ape Escape 3 — point it at your own
game disc image and it extracts assets **client-side** (nothing uploaded,
nothing shipped). It plays the game's sequenced music, streams, and embedded
sound effects, and exposes all 22 full-motion videos in a Cinema channel.
Sequenced audio runs through a WebAssembly build of the
[ae3-sdk](https://github.com/pxdl/ae3-sdk) synthesizer core.

Working today: ISO picker → in-browser extraction → OPFS cache ("forget my
disc" wipes it); all 68 BGM songs at the game's authored per-song volumes;
341 MB of lazily extracted streamed music, dialogue, and cutscene audio; and
101 embedded SE banks exposing 2,699 assembled bank:request entries through
the same 48-voice synth. BGM includes AudioWorklet playback, latency-aligned
transport and seek, loop/timing/kernel/reverb/volume dials, a loop-unwound
piano roll, voice slots, waveform and clip meters, Worker-rendered WAV, raw
MIDI, bank-pair, and decoded sample-kit export. Streams include pad-aware
decode, waveform/spectrogram transport, raw `.x`, and WAV export. SE includes
exact or console-tick request timing, caller volume, gaussian/bright
resampling, reverb, transport and event-score seeking, a 48-voice grid, a live
output waveform, and a 480 Hz bytecode score with command values and sample,
noise, source-loop, and reverb-source markers. A separate live source-loop
panel gives every active looped SE voice its own stable slot row, intro/loop
boundaries, decoder phase and seam count, plus an ADSR display that continues
across source seams. It reports event-track/cycle duration separately from
measured audible completion and authored source-envelope lifetime. Infinite
stream jumps can loop or execute once; sample loops remain identified even when
their envelopes are technically finite. Velocity-zero voice-stop requests are
labeled as control-only rather than silent effects. WAV export offers one pass
or 10/30/60-second caps, alongside raw `.hd`/`.bd` bank export.
Cinema performs a lightweight 22-movie catalog scan, then reads, validates,
converts, and caches only the movie the user chooses. Playback preserves the
game's 7:6 sample aspect ratio, bobs interlaced sources to 59.94 fps, and exposes
local WebVTT captions for the ten subtitled scenes. Exports include byte-exact
original `.str`/`.bin`/`.sbt` ZIPs; bit-exact MPEG-2, decoded WAV, and SRT
masters; lossless MPEG-2/FLAC/SubRip MKV; H.264/AAC MP4; and VP9/Opus WebM with
a WebVTT sidecar.

The app is a PWA: after the first visit its shell works offline and cached
assets play without the ISO. Interrupted extractions resume where they left
off, with explicit errors for wrong/truncated/non-AE3 images and unplugged
drives. The 32 MiB FFmpeg core is excluded from the initial precache; it is
fetched and cached only after the first movie preparation or conversion.

Browser support: Chrome/Chromium is the tested reference; Firefox works.
Safari works as of the in-gesture audio fix: the whole audio stack is created
inside the first click, because Safari ties the autoplay dispensation to the
gesture that CREATED the `AudioContext` — a context built at page-load time
can stay "interrupted" forever under stricter per-site Auto-Play policies,
no matter who calls `resume()` later. If audio still refuses to start, the
status line says so; check Safari Settings > Websites > Auto-Play for this
site and the tab's mute state. Safari floors: `Promise.withResolvers` needs
17.4+; OPFS writes need 18.2+ and can be declined by the browser (the app
then plays straight from the ISO and asks for it again next visit).
Cinema playback and conversion were exercised on this workstation in current
Chrome 150, Firefox 152, and Safari 26.4. Conversion uses the single-thread core
because the Pages deployment does not provide the COOP/COEP isolation required
by `SharedArrayBuffer`.

This repository never contains or serves game data. Your disc stays on your
machine.

## Architecture

- `src/` — Vite + TypeScript app: disc session (extraction + OPFS), worklet
  controller, timeline, media stores, lazy movie converter, and UI. No
  framework.
- `src/vendor/extract/` — vendored `@ae3/extract` (TS source, bundled).
- `public/synth/` — the **unbundled audio path**: vendored `@ae3/synth`
  binding + `ae3synth.wasm`, plus the app's engine + `AudioWorkletProcessor`.
  Served verbatim; see `public/synth/README.md` for why.
- Vendored artifacts refresh via `npm run sync-sdk` (set `AE3_SDK` to your
  ae3-sdk checkout; provenance lands in `src/vendor/SDK_COMMIT`).

The audio-path equality gate (engine output hashed against the SDK's native
`wavdump`, worklet-quantum rendering, seek continuity) lives in the private
research repo — it needs the disc.

## Dev

```
npm install
npm run sync-sdk   # only when bumping the SDK
npm run dev        # or: npm run build && npm run preview
npm run typecheck
```

`npm run build` also generates `dist/sw.js` (the precache service worker;
`scripts/gen-sw.mjs`). Deploys go to GitHub Pages via
`.github/workflows/deploy.yml` on every push to `main` (needs Pages set to
the "GitHub Actions" source once the repo is public).

The application source is MIT-licensed. The optional Cinema converter also
distributes `@ffmpeg/core` under GPL-2.0-or-later and unmodified Mediabunny
portions under MPL-2.0. Exact versions, license links, and corresponding-source
links are deployed in [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt).

License: MIT.
