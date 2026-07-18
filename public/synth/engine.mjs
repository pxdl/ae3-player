/* PlayerEngine -- the audio-path playback engine, wrapped by worklet.mjs.
 *
 * Pure logic over the @ae3/synth binding: no AudioWorklet, DOM or fetch
 * dependency, so the private repo's exit gate drives this exact class under
 * Node and hashes its output against native wavdump renders.
 *
 * Mirrors the reference consumer (ae3-sdk harness/bgmplay.c):
 *   - a song load / seek builds a FRESH synth from cached buffers and re-applies
 *     the whole config (reload_locked) -- the core has no rewind;
 *   - seeking fast-forwards headless from 0, but CHUNKED across render() calls
 *     (bgmplay blocks its audio callback; a worklet must keep returning), so
 *     playback shows brief silence while the playhead sweeps to the target;
 *   - dials apply live, exactly the calls bgmplay makes on its keys.
 *
 * Defaults are the settled listening verdicts (ae3synth.h, memory
 * project_ae3_bgm_findings): EXACT event timing, GAUSSIAN kernel, reverb
 * depth 30, authored song volume, loop forever like the console. */
import { AE3Synth, LOOP_FOREVER } from "./ae3synth.mjs";

export { RATE, NVOICES, LOOP_FOREVER } from "./ae3synth.mjs";

/* Frames fast-forwarded per render() call while seeking: ~2 ms of compute at
 * the WASM core's >150x real time, inside the 2.67 ms quantum budget. */
const SEEK_CHUNK = 16384;

export const defaultConfig = () => ({
    songvol: 44,          /* overwritten per song by the authored value */
    revDepth: 30,
    exact: true,
    gaussian: true,
    loop: LOOP_FOREVER,   /* 0 = single pass (the gate's finite renders) */
});

export class PlayerEngine {
    /** @param {WebAssembly.Module} module compiled ae3synth.wasm */
    constructor(module) {
        this.module = module;
        this.synth = null;
        this.assets = null;             /* {hd,bd,mid,irx,libsd} Uint8Arrays */
        this.config = defaultConfig();
        this.playing = false;
        this.done = false;
        this.seekTarget = -1;           /* absolute sample; -1 = not seeking */
        this.busy = false;              /* rebuilding: render silence */
        this.warning = "";              /* nonfatal load issues (bgmplay P.err) */
        this.ffbuf = new Float32Array(SEEK_CHUNK * 2);
        this.voicebuf = new Int32Array(48 * 4);
    }

    /* Fresh synth from the cached buffers, full config re-applied. Load order
     * is bgmplay reload_locked's: pitch irx, bank, seq, libsd, dials. */
    async #build() {
        const { hd, bd, mid, irx, libsd } = this.assets;
        const c = this.config;
        const s = await AE3Synth.instantiate(this.module);
        this.warning = "";
        try {
            if (irx) s.loadPitchIrx(irx);
        } catch (e) { this.warning = String(e.message ?? e); }
        s.loadBank(hd, bd);             /* fatal: caller catches */
        s.loadSeq(mid);
        try {
            if (libsd) s.loadReverbIrx(libsd);
        } catch (e) { this.warning = String(e.message ?? e); }
        s.setReverbDepth(c.revDepth);
        s.setEventTiming(c.exact);
        s.setGaussian(c.gaussian);
        s.setLoop(c.loop);
        s.setSongVolume(c.songvol);
        this.synth?.dispose();
        this.synth = s;
        this.done = false;
    }

    /** Load a song. Returns {ppqn, events} for the main thread's timeline
     *  builder -- events packed [tick,kind,status,a,b,uspqn] per event. */
    async load(assets, config) {
        this.busy = true;
        try {
            this.assets = assets;
            Object.assign(this.config, config);
            this.seekTarget = -1;
            await this.#build();
            const ppqn = this.synth.seqPpqn();
            const evs = this.synth.seqEventsAll();
            const events = new Uint32Array(evs.length * 6);
            for (let i = 0; i < evs.length; i++) {
                const e = evs[i];
                events.set([e.tick, e.kind, e.status, e.a, e.b, e.uspqn], i * 6);
            }
            return { ppqn, events };
        } finally {
            this.busy = false;
        }
    }

    /** Restart from 0 and fast-forward to an absolute sample position (the
     *  caller clamps to the timeline). The fast-forward itself happens inside
     *  subsequent render() calls; playback state is preserved. */
    async seek(target) {
        if (!this.assets) return;
        this.busy = true;
        try {
            await this.#build();
            this.seekTarget = Math.max(0, Math.floor(target));
        } finally {
            this.busy = false;
        }
    }

    /* One bounded fast-forward step; returns true while still seeking. */
    #ffStep() {
        const remain = this.seekTarget - this.synth.pos();
        if (remain > 0) {
            const n = this.synth.render(this.ffbuf,
                                        Math.min(remain, SEEK_CHUNK));
            if (n > 0 && this.synth.pos() < this.seekTarget) return true;
        }
        this.seekTarget = -1;
        this.done = this.synth.done();
        return false;
    }

    /** Render up to `frames` interleaved-stereo frames into out. Returns the
     *  frames written; 0 means silence (paused, seeking, rebuilding, ended, or
     *  nothing loaded) -- the caller's buffers are already zeroed. */
    render(out, frames) {
        if (!this.synth || this.busy) return 0;
        if (this.seekTarget >= 0) { this.#ffStep(); return 0; }
        if (!this.playing || this.done) return 0;
        const n = this.synth.render(out, frames);
        if (n < frames && this.synth.done()) this.done = true;
        return Math.max(n, 0);
    }

    /** Live dial change -- the same calls bgmplay's keys make. */
    set(key, value) {
        this.config[key] = value;
        const s = this.synth;
        if (!s) return;
        switch (key) {
        case "songvol":  s.setSongVolume(value); break;
        case "revDepth": s.setReverbDepth(value); break;
        case "exact":    s.setEventTiming(value); break;
        case "gaussian": s.setGaussian(value); break;
        case "loop":     s.setLoop(value); break;
        }
    }

    /** Playback state for the UI: position, display clock, packed voice
     *  states [flags,ch,key,env]x48 (flags: 1 in_use, 2 active, 4 released). */
    snapshot() {
        const s = this.synth;
        if (!s || this.busy)
            return null;
        const v = this.voicebuf;
        for (let i = 0; i < 48; i++) {
            const st = s.voice(i);
            v[i * 4] = (st.in_use ? 1 : 0) | (st.active ? 2 : 0)
                     | (st.released ? 4 : 0);
            v[i * 4 + 1] = st.ch;
            v[i * 4 + 2] = st.key;
            v[i * 4 + 3] = st.env;
        }
        return {
            pos: s.pos(),
            clock: s.clock(),
            voices: v,
            playing: this.playing,
            seeking: this.seekTarget >= 0,
            done: this.done,
        };
    }
}
