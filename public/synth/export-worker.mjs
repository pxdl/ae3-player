/* Plain-Worker wrapper around exporter.mjs: the browser side of WAV export.
 * Renders on this worker thread with its own synth instance -- the audio
 * worklet never stalls -- then transfers the finished file back. The wasm is
 * fetched next to this script (once, then cached in the worker). */
import { renderWavFile } from "./exporter.mjs";

let wasmBytes = null;

onmessage = async (e) => {
    const m = e.data;
    try {
        wasmBytes ??= await (await fetch(
            new URL("./ae3synth.wasm", import.meta.url))).arrayBuffer();
        let last = 0;
        const { wav, frames } = await renderWavFile(
            wasmBytes, m.files, m.opts, (fr) => {
                const now = Date.now();
                if (now - last >= 100) {
                    last = now;
                    postMessage({ t: "progress", frames: fr });
                }
            });
        postMessage({ t: "done", wav, frames }, [wav.buffer]);
    } catch (err) {
        postMessage({ t: "error", message: String(err?.message ?? err) });
    }
};
