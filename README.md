# ae3-player

Browser sound player for Ape Escape 3 — point it at your own game disc image
and it extracts assets **client-side** (nothing uploaded, nothing shipped),
then plays the game's sequenced music, streams, and embedded sound effects.
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
resampling, reverb, voice/wave views, ten-second-capped assembled WAV export,
and raw `.hd`/`.bd` bank export.

The app is a PWA: after the first visit its code works offline and cached
assets play without the ISO. Interrupted extractions resume where they left
off, with explicit errors for wrong/truncated/non-AE3 images and unplugged
drives.

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

This repository never contains or serves game data. Your disc stays on your
machine.

## Architecture

- `src/` — Vite + TypeScript app: disc session (extraction + OPFS), worklet
  controller, timeline (the loop-unwound display clock), UI. No framework,
  no runtime dependencies.
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

License: MIT.
