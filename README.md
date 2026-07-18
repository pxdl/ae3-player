# ae3-player

Browser player for the Ape Escape 3 soundtrack — point it at your own game
disc image and it extracts the music assets **client-side** (nothing uploaded,
nothing shipped), then plays them through a bit-exact WebAssembly build of the
[ae3-sdk](https://github.com/pxdl/ae3-sdk) synthesizer core.

**Status: W4 player alpha.** Working today: ISO picker → in-browser extraction
→ OPFS cache ("forget my disc" wipes it), the 68-song list with the game's own
authored per-song volumes (from `bgm_desc.exdb` on your disc), AudioWorklet
playback, transport with a latency-aligned playhead, seek, loop/timing/kernel/
reverb/volume dials. Next (W5): piano roll, voice slots, waveform, help
overlay, WAV export. Then (W6): PWA/offline, browser pass, error paths,
publish.

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

License: MIT.
