# The audio + export paths (served unbundled, on purpose)

Everything in this directory runs in (or is loaded into) the
`AudioWorkletGlobalScope` or the export Worker and is served **verbatim** --
no bundler touches it (WEB_PORT_PLAN §1: standalone build, no main-thread
glue in the audio path). Plain ES modules with relative imports keep dev and
production byte-identical and base-path safe, and let the private exit gate
import `engine.mjs` / `exporter.mjs` directly under Node.

| file | role |
|---|---|
| `ae3synth.mjs` | vendored `@ae3/synth` binding (ae3-sdk `wasm/js/`) |
| `wav.mjs` | vendored WAV framing, byte-identical to wavdump's (ae3-sdk `wasm/js/`) |
| `ae3synth.wasm` | vendored synth core (ae3-sdk `wasm/dist/`; fetched as bytes, compiled inside the worklet/worker) |
| `engine.mjs` | app-owned playback engine: load / chunked seek / dials / snapshot |
| `worklet.mjs` | app-owned `AudioWorkletProcessor` wrapper: renders quanta, posts snapshots + waveform columns |
| `exporter.mjs` | app-owned offline WAV render (wavdump's mode, second synth instance) |
| `export-worker.mjs` | app-owned Worker wrapper around `exporter.mjs` |

Vendored files are refreshed by `npm run sync-sdk` (provenance in
`src/vendor/SDK_COMMIT`). Do not edit them here.
