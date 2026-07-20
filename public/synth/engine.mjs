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

export { RATE, NVOICES, LOOP_FOREVER, TICK_SAMPLES } from "./ae3synth.mjs";

/* Frames fast-forwarded per render() call while seeking: ~2 ms of compute at
 * the WASM core's >150x real time, inside the 2.67 ms quantum budget. */
const SEEK_CHUNK = 16384;

export const defaultConfig = () => ({
    songvol: 44,          /* overwritten per song by the authored value */
    revDepth: 30,
    exact: true,
    gaussian: true,
    loop: LOOP_FOREVER,   /* 0 = single pass (the gate's finite renders) */
    /* M8 cue layer (the game's volume model above the driver). While cueOn the
     * layer owns song volume at cueScale (the song's authored volume_scale --
     * byte-identical to the static songvol path until a duck is held; verified
     * SDK-side). duckDemo/duckPhone mirror the game's cutscene/phone ducks:
     * 0.7x, 0.5 s in / 2.0 s out, linear. */
    cueOn: false,
    cueScale: 44.5 / 127,  /* overwritten per song; trunc-safe fallback */
    duckDemo: false,
    duckPhone: false,
});

export class PlayerEngine {
    /** @param {WebAssembly.Module} module compiled ae3synth.wasm */
    constructor(module) {
        this.module = module;
        this.synth = null;
        this.assets = null;             /* BGM or embedded-SE load descriptor */
        this.config = defaultConfig();
        this.playing = false;
        this.done = false;
        this.seekTarget = -1;           /* absolute sample; -1 = not seeking */
        this.busy = false;              /* rebuilding: render silence */
        this.warning = "";              /* nonfatal load issues (bgmplay P.err) */
        this.ffbuf = new Float32Array(SEEK_CHUNK * 2);
        this.voicebuf = new Int32Array(48 * 4);
    }

    /* Fresh synth from the cached buffers, full config re-applied. BGM follows
     * bgmplay reload_locked; SE selects one embedded bank/request after the
     * shared bank load. */
    async #build() {
        const { hd, bd, mid, irx, libsd, kind, bank, request } = this.assets;
        const c = this.config;
        const s = await AE3Synth.instantiate(this.module);
        this.warning = "";
        try {
            if (irx) s.loadPitchIrx(irx);
        } catch (e) { this.warning = String(e.message ?? e); }
        s.loadBank(hd, bd);             /* fatal: caller catches */
        if (kind === "se") s.loadSe(bank, request);
        else s.loadSeq(mid);
        try {
            if (libsd) s.loadReverbIrx(libsd);
        } catch (e) { this.warning = String(e.message ?? e); }
        s.setReverbDepth(c.revDepth);
        s.setEventTiming(c.exact);
        s.setGaussian(c.gaussian);
        s.setLoop(c.loop);
        s.setSongVolume(c.songvol);
        if (kind !== "se" && c.cueOn) {
            /* Fresh instance: duck levels restart from 1.0, like bgmplay
             * reload_locked. */
            s.cueScale(c.cueScale);
            s.cueEnable(true);
            s.cueDuck(0, c.duckDemo);
            s.cueDuck(1, c.duckPhone);
        }
        this.synth?.dispose();
        this.synth = s;
        this.done = false;
    }

    /** Load BGM or an embedded SE request. BGM returns packed sequence events
     * for the main-thread timeline; SE returns an empty event vector. */
    async load(assets, config) {
        this.busy = true;
        try {
            this.assets = assets;
            Object.assign(this.config, config);
            this.seekTarget = -1;
            await this.#build();
            const isSe = assets.kind === "se";
            const ppqn = isSe ? 0 : this.synth.seqPpqn();
            const evs = isSe ? [] : this.synth.seqEventsAll();
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
        case "cueOn":    /* arm at the stored scale / disarm (last value stays
                            until the caller's next songvol set -- bgmplay's
                            cue_disarm) */
            if (value) {
                s.cueScale(this.config.cueScale);
                s.cueEnable(true);
                s.cueDuck(0, this.config.duckDemo);
                s.cueDuck(1, this.config.duckPhone);
            } else {
                s.cueEnable(false);
            }
            break;
        case "cueScale":  s.cueScale(value); break;
        case "duckDemo":  s.cueDuck(0, value); break;
        case "duckPhone": s.cueDuck(1, value); break;
        }
    }

    /** Playback state for the UI: position, display clock, packed voice
     *  states [flags,ch,key,env]x48 (flags: 1 in_use, 2 active, 4 released),
     *  and the display stats bgmplay's slot label + footer read. */
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
        const st = s.stats();
        return {
            pos: s.pos(),
            clock: s.clock(),
            voices: v,
            stats: {
                voices_started: st.voices_started,
                peak_voices: st.peak_voices,
                notes_dropped: st.notes_dropped,
                bus_peak: st.bus_peak,
                bus_clipped: st.bus_clipped,
                wet_peak: st.wet_peak,
                wet_clipped: st.wet_clipped,
                loops_taken: st.loops_taken,
            },
            playing: this.playing,
            seeking: this.seekTarget >= 0,
            done: this.done,
            /* live cue songvol while the layer is armed (-1 otherwise), for
             * the VOL dial to show the duck staircase */
            cueSongvol: this.config.cueOn ? s.cueSongvol() : -1,
        };
    }
}
