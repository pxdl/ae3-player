/* AudioWorkletProcessor wrapper around PlayerEngine.
 *
 * The WASM synth lives HERE, on the rendering thread (WEB_PORT_PLAN §1): the
 * main thread compiles ae3synth.wasm once and posts the WebAssembly.Module;
 * process() renders 128-frame quanta directly. Control flows in over the
 * port; a ~47 Hz snapshot (every 8 quanta) flows out, stamped with
 * currentFrame so the main thread can align the playhead to what is heard.
 *
 * Everything in public/synth/ is served UNBUNDLED by design -- the audio path
 * has no build step and no main-thread glue (see README.md here). */
import { PlayerEngine } from "./engine.mjs";

const SNAPSHOT_QUANTA = 8;      /* 8 x 128 = 1024 samples ~ 21 ms ~ 47 Hz */

registerProcessor("ae3-player", class extends AudioWorkletProcessor {
    constructor() {
        super();
        this.engine = null;
        this.buf = new Float32Array(128 * 2);
        this.quanta = 0;
        this.peakL = 0;
        this.peakR = 0;
        this.wasDone = false;
        this.port.onmessage = (e) => { this.#onmessage(e.data); };
    }

    async #onmessage(m) {
        try {
            switch (m.t) {
            case "init": {
                /* m.module: wasm BYTES, compiled here. Chrome silently drops
                 * a postMessage'd WebAssembly.Module on the way into an
                 * AudioWorkletGlobalScope (no error, no delivery -- measured
                 * 2026-07-18), so the compile-on-main-thread plan does not
                 * work; bytes clone fine. A precompiled Module is still
                 * accepted for the Node gate, which drives PlayerEngine
                 * directly anyway. */
                const module = m.module instanceof WebAssembly.Module
                    ? m.module
                    : await WebAssembly.compile(m.module);
                this.engine = new PlayerEngine(module);
                this.port.postMessage({ t: "ready" });
                break;
            }
            case "load": {
                const { ppqn, events } = await this.engine.load(
                    { hd: m.hd, bd: m.bd, mid: m.mid,
                      irx: m.irx, libsd: m.libsd }, m.config);
                this.wasDone = false;
                this.port.postMessage(
                    { t: "loaded", ppqn, events,
                      warning: this.engine.warning }, [events.buffer]);
                break;
            }
            case "play":  this.engine.playing = true;  break;
            case "pause": this.engine.playing = false; break;
            case "seek":
                await this.engine.seek(m.sample);
                this.wasDone = false;
                break;
            case "set": this.engine.set(m.key, m.value); break;
            }
        } catch (e) {
            this.port.postMessage({ t: "error", message: String(e.message ?? e) });
        }
    }

    process(_inputs, outputs) {
        try {
            return this.#render(outputs);
        } catch (e) {
            /* keep the processor alive but silent; surface the fault instead
             * of dying with an opaque processorerror */
            this.engine = null;
            this.port.postMessage({ t: "error",
                message: `render fault: ${e.stack ?? e.message ?? e}` });
            return true;
        }
    }

    #render(outputs) {
        const eng = this.engine;
        if (!eng) return true;
        const out = outputs[0], L = out[0], R = out[1];
        const n = eng.render(this.buf, 128);     /* output pre-zeroed per spec */
        for (let i = 0; i < n; i++) {
            const l = this.buf[2 * i], r = this.buf[2 * i + 1];
            L[i] = l;
            R[i] = r;
            const al = Math.abs(l), ar = Math.abs(r);
            if (al > this.peakL) this.peakL = al;
            if (ar > this.peakR) this.peakR = ar;
        }
        if (eng.done && !this.wasDone) {
            this.wasDone = true;
            this.port.postMessage({ t: "ended" });
        }
        if (++this.quanta >= SNAPSHOT_QUANTA) {
            this.quanta = 0;
            const s = eng.snapshot();
            if (s) {
                s.t = "snapshot";
                s.ctxFrame = currentFrame;
                s.peakL = this.peakL;
                s.peakR = this.peakR;
                this.port.postMessage(s);
            }
            this.peakL = this.peakR = 0;
        }
        return true;
    }
});
