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
import { PlayerEngine, TICK_SAMPLES } from "./engine.mjs";

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
        this.commands = [];
        this.draining = false;
        /* waveform history: one min/max/clip column per 60 Hz tick (800
         * samples), like bgmplay's audio_cb -- finished columns ship with the
         * next snapshot as [lmin,lmax,rmin,rmax,clip] x n; the main thread
         * keeps the ring. Fast-forward output never lands here (render()
         * returns silence while seeking), matching bgmplay's headless seek. */
        this.wcur = { lmin: 0, lmax: 0, rmin: 0, rmax: 0, clip: 0, n: 0 };
        this.wcols = [];
        this.port.onmessage = (e) => { this.#enqueue(e.data); };
    }

    #enqueue(message) {
        if (message.t === "seek") {
            const pending = this.commands.at(-1);
            if (pending?.t === "seek") {
                pending.sample = message.sample;
                return;
            }
        } else if (message.t === "load") {
            this.commands = this.commands.filter(
                (command) => command.t !== "seek");
        }
        this.commands.push(message);
        if (!this.draining) void this.#drain();
    }

    async #drain() {
        this.draining = true;
        try {
            while (this.commands.length) {
                const message = this.commands.shift();
                try {
                    await this.#handle(message);
                } catch (e) {
                    this.port.postMessage(
                        { t: "error", message: String(e.message ?? e) });
                }
            }
        } finally {
            this.draining = false;
            if (this.commands.length) void this.#drain();
        }
    }

    async #handle(m) {
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
                { kind: m.mode === "se" ? "se" : "bgm",
                  hd: m.hd, bd: m.bd, mid: m.mid,
                  bank: m.bank, request: m.request,
                  irx: m.irx, libsd: m.libsd }, m.config);
            this.wasDone = false;
            this.wcur.n = 0;        /* bgmplay clears wcol on song load */
            this.wcols.length = 0;
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
        const w = this.wcur;
        for (let i = 0; i < n; i++) {
            const l = this.buf[2 * i], r = this.buf[2 * i + 1];
            L[i] = l;
            R[i] = r;
            const al = Math.abs(l), ar = Math.abs(r);
            if (al > this.peakL) this.peakL = al;
            if (ar > this.peakR) this.peakR = ar;
            if (w.n === 0) {
                w.lmin = w.lmax = l; w.rmin = w.rmax = r; w.clip = 0;
            } else {
                if (l < w.lmin) w.lmin = l; else if (l > w.lmax) w.lmax = l;
                if (r < w.rmin) w.rmin = r; else if (r > w.rmax) w.rmax = r;
            }
            if (al >= 0.9999 || ar >= 0.9999) w.clip = 1;
            if (++w.n >= TICK_SAMPLES) {
                this.wcols.push(w.lmin, w.lmax, w.rmin, w.rmax, w.clip);
                w.n = 0;
            }
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
                s.wcols = new Float32Array(this.wcols);
                this.wcols.length = 0;
                this.port.postMessage(s, [s.wcols.buffer]);
            }
            this.peakL = this.peakR = 0;
        }
        return true;
    }
});
