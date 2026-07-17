# ae3-player

Browser player for the Ape Escape 3 soundtrack — point it at your own game
disc image and it extracts the music assets **client-side** (nothing uploaded,
nothing shipped), then plays them through a bit-exact WebAssembly build of the
[ae3-sdk](https://github.com/pxdl/ae3-sdk) synthesizer core: real-time
playback, piano roll, voice slots, waveform, WAV export.

**Status: placeholder.** The app skeleton lands once the SDK's WASM build
(`@ae3/synth`) and browser extraction package (`@ae3/extract`) exist — see the
SDK repo. Planned stack: Vite + TypeScript, AudioWorklet playback, OPFS asset
cache, static hosting on GitHub Pages (PWA, works offline after first visit).

This repository will never contain or serve game data. Your disc stays on your
machine.

License: MIT.
