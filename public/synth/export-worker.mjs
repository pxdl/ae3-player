/* Plain-Worker wrapper around exporter.mjs + kit.mjs + stream.mjs: the
 * browser side of WAV / sample-kit export and EXST stream decode. Runs on
 * this worker thread with its own synth instance -- the audio worklet never
 * stalls -- then transfers the finished bytes back. The wasm is fetched next
 * to this script (once, then cached in the worker). */
import { renderWavFile, renderSeWavFile } from "./exporter.mjs";
import { buildSampleKit } from "./kit.mjs";
import { decodeStream, streamWav } from "./stream.mjs";
import { inspectSeBank, measureSePlayback } from "./se.mjs";

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
        if (m.t === "se-inspect") {
            const inspection = await inspectSeBank(wasmBytes, m.files);
            postMessage({ t: "se-inspect-done", id: m.id, inspection },
                        [inspection.requests.buffer]);
            return;
        }
        if (m.t === "se-measure") {
            const measure = await measureSePlayback(wasmBytes, m.files, m.opts);
            postMessage({ t: "se-measure-done", id: m.id, measure });
            return;
        }
        if (m.t === "stream") {
            /* untrimmed decode; the UI derives the trimmed view from
             * padFrames without a second round-trip */
            const r = await decodeStream(wasmBytes, m.file);
            postMessage({ t: "stream-done", id: m.id, header: r.header,
                          sectors: r.sectors, padFrames: r.padFrames,
                          samplesPerChannel: r.samplesPerChannel, pcm: r.pcm },
                        [r.pcm.buffer]);
            return;
        }
        if (m.t === "stream-wav") {
            const r = await decodeStream(wasmBytes, m.file,
                                         { trimPad: m.trimPad });
            const wav = streamWav(r.header, r.pcm);
            postMessage({ t: "stream-wav-done", id: m.id, name: m.name, wav },
                        [wav.buffer]);
            return;
        }
        const render = m.t === "se-render" ? renderSeWavFile : renderWavFile;
        let last = 0;
        const { wav, frames } = await render(
            wasmBytes, m.files, m.opts, (fr) => {
                const now = Date.now();
                if (now - last >= 100) {
                    last = now;
                    postMessage({ t: "progress", frames: fr });
                }
            });
        postMessage({ t: "done", wav, frames }, [wav.buffer]);
    } catch (err) {
        postMessage({ t: "error", id: m?.id, message: String(err?.message ?? err) });
    }
};
