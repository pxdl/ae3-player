# The audio path (served unbundled, on purpose)

Everything in this directory runs in (or is loaded into) the
`AudioWorkletGlobalScope` and is served **verbatim** -- no bundler touches it
(WEB_PORT_PLAN §1: standalone build, no main-thread glue in the audio path).
Plain ES modules with relative imports keep dev and production byte-identical
and base-path safe, and let the private exit gate import `engine.mjs` directly
under Node.

| file | role |
|---|---|
| `ae3synth.mjs` | vendored `@ae3/synth` binding (ae3-sdk `wasm/js/`) |
| `ae3synth.wasm` | vendored synth core (ae3-sdk `wasm/dist/`; compiled on the main thread, the `Module` is posted in) |
| `engine.mjs` | app-owned playback engine: load / chunked seek / dials / snapshot |
| `worklet.mjs` | app-owned `AudioWorkletProcessor` wrapper: renders quanta, posts snapshots |

Vendored files are refreshed by `npm run sync-sdk` (provenance in
`src/vendor/SDK_COMMIT`). Do not edit them here.
