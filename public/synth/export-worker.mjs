/* Plain-Worker wrapper around exporter.mjs + kit.mjs: the browser side of
 * WAV / sample-kit export. Runs on this worker thread with its own synth
 * instance -- the audio worklet never stalls -- then transfers the finished
 * bytes back. The wasm is fetched next to this script (once, then cached in
 * the worker). */
import { renderWavFile } from "./exporter.mjs";
import { buildSampleKit } from "./kit.mjs";

let wasmBytes = null;

onmessage = async (e) => {
    const m = e.data;
    try {
        wasmBytes ??= await (await fetch(
            new URL("./ae3synth.wasm", import.meta.url))).arrayBuffer();
        if (m.t === "kit") {
            const entries = await buildSampleKit(wasmBytes, m.files);
            postMessage({ t: "kit-done", entries },
                        entries.map((x) => x.wav.buffer));
            return;
        }
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
