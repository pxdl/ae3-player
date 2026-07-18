/* @ae3/synth -- thin binding over the standalone ae3synth.wasm.
 *
 * Environment-agnostic by construction: no fs, no fetch, no TextDecoder (absent
 * from AudioWorkletGlobalScope), no Emscripten glue. The caller supplies the
 * wasm as bytes or a precompiled WebAssembly.Module. AudioWorklet callers must
 * post the BYTES and compile inside the worklet: Chrome silently drops a
 * postMessage'd WebAssembly.Module bound for an AudioWorkletGlobalScope -- no
 * error on either side, the message just never arrives (measured 2026-07-18,
 * ae3-player W4). One wasm instance per synth -- isolated heap, and the export
 * path's second synth never shares state with the audio path's.
 *
 * API mirrors core/ae3synth.h one-to-one; see that header for semantics. Struct
 * returns cross the boundary through the flatteners in ../abi.c -- the field
 * lists here and the write order there change together. */

export const RATE = 48000;
export const NVOICES = 48;
export const TICK_HZ = 60;
export const TICK_SAMPLES = RATE / TICK_HZ;
export const LOOP_FOREVER = 0x7f;

/* AE3_EV_* */
export const EV_CH = 0, EV_TEMPO = 1, EV_END = 2,
             EV_LOOP_START = 3, EV_LOOP_END = 4, EV_LOOP_COUNT = 5, EV_HOOK = 6;

/* ae3_stats declaration order, as ../abi.c writes it (hashes as lo32,hi32). */
const STATS_FIELDS = [
    "prog_slots", "progs_used", "tones",
    "ppqn",
    "events", "note_ons", "note_offs", "ccs", "prog_changes", "pitch_bends",
    "tempo_changes", "meta_skipped", "end_tick", "end_sample",
    "loop_starts", "loop_ends", "loop_sets", "hooks",
    "hash_ch_lo", "hash_ch_hi", "hash_tempo_lo", "hash_tempo_hi",
    "voices_started", "noteons_aborted", "notes_dropped", "peak_voices",
    "slots_freed_live", "pitch_idx_clamped", "pitch_step_clamped",
    "bus_clipped", "bus_peak", "wet_clipped", "wet_peak",
    "cc_lfo", "cc_nrpn", "cc6_shadow", "cc6_rev_apply", "cc_stub",
    "loops_taken",
];

export class AE3Synth {
    /* wasmSource: BufferSource with the .wasm bytes, or a WebAssembly.Module. */
    static async instantiate(wasmSource) {
        const module = wasmSource instanceof WebAssembly.Module
            ? wasmSource
            : await WebAssembly.compile(wasmSource);
        const synth = new AE3Synth();
        /* Stub every declared import; only the growth notification is expected
         * (used to drop stale heap views), anything else loudly fails if hit. */
        const imports = {};
        for (const im of WebAssembly.Module.imports(module)) {
            imports[im.module] ??= {};
            imports[im.module][im.name] =
                im.module === "env" && im.name === "emscripten_notify_memory_growth"
                    ? () => { synth.#views = null; }
                    : () => { throw new Error(`wasm called unstubbed import ${im.module}.${im.name}`); };
        }
        const instance = await WebAssembly.instantiate(module, imports);
        synth.#init(instance);
        return synth;
    }

    #ex;               /* wasm exports */
    #s = 0;            /* ae3_synth* */
    #views = null;     /* {u8, i32, u32, f32, f64}; null after memory growth */
    #scratch = 0;      /* 512-byte block for the small flattener outputs */
    #rbuf = 0;         /* persistent render buffer */
    #rcap = 0;         /* its capacity in frames */

    #init(instance) {
        this.#ex = instance.exports;
        this.#ex._initialize();          /* WASI-reactor libc setup */
        this.#s = this.#ex.ae3_synth_new();
        if (!this.#s)
            throw new Error("ae3_synth_new failed");
        this.#scratch = this.#alloc(512);
    }

    #mem() {
        if (this.#views === null) {
            const b = this.#ex.memory.buffer;
            this.#views = {
                u8: new Uint8Array(b), i32: new Int32Array(b), u32: new Uint32Array(b),
                f32: new Float32Array(b), f64: new Float64Array(b),
            };
        }
        return this.#views;
    }

    #alloc(n) {
        const p = this.#ex.malloc(n);
        if (!p)
            throw new Error(`wasm malloc(${n}) failed`);
        return p;
    }

    #error() {
        /* ASCII by construction (core error strings); read to NUL by hand. */
        const u8 = this.#mem().u8;
        let p = this.#ex.ae3_synth_error(this.#s), out = "";
        while (u8[p])
            out += String.fromCharCode(u8[p++]);
        return out;
    }

    /* Copy buf into wasm memory, run fn(ptr, len), free, throw on nonzero. */
    #load(what, fn, ...bufs) {
        const ptrs = bufs.map(b => {
            const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
            const p = this.#alloc(u8.length || 1);
            this.#mem().u8.set(u8, p);
            return [p, u8.length];
        });
        const r = fn(...ptrs.flat());
        for (const [p] of ptrs)
            this.#ex.free(p);
        if (r !== 0)
            throw new Error(`${what}: ${this.#error()}`);
    }

    /* ---- loading (core copies what it keeps; our staging is freed at once) */
    loadBank(hd, bd)   { this.#load("loadBank", (h, hn, b, bn) => this.#ex.ae3_synth_load_bank(this.#s, h, hn, b, bn), hd, bd); }
    loadSeq(mid)       { this.#load("loadSeq", (p, n) => this.#ex.ae3_synth_load_seq(this.#s, p, n), mid); }
    loadPitchIrx(irx)  { this.#load("loadPitchIrx", (p, n) => this.#ex.ae3_synth_load_pitch_irx(this.#s, p, n), irx); }
    loadReverbIrx(irx) { this.#load("loadReverbIrx", (p, n) => this.#ex.ae3_synth_load_reverb_irx(this.#s, p, n), irx); }

    /* ---- dials + direct events */
    setGaussian(on)        { this.#ex.ae3_synth_gaussian(this.#s, on ? 1 : 0); }
    setReverbDepth(d)      { this.#ex.ae3_synth_reverb_depth(this.#s, d); }
    setSongVolume(l, r = l){ this.#ex.ae3_synth_song_volume(this.#s, l, r); }
    setLoop(count)         { this.#ex.ae3_synth_set_loop(this.#s, count); }
    setEventTiming(exact)  { this.#ex.ae3_synth_event_timing(this.#s, exact ? 1 : 0); }
    noteOn(ch, key, vel)   { this.#ex.ae3_synth_note_on(this.#s, ch, key, vel); }
    noteOff(ch, key)       { this.#ex.ae3_synth_note_off(this.#s, ch, key); }
    program(ch, prog)      { this.#ex.ae3_synth_program(this.#s, ch, prog); }

    /* Render into an interleaved-stereo Float32Array; frames defaults to
     * out.length/2. Returns frames written (0 = song over, -1 = nothing
     * loaded), exactly ae3_synth_render. */
    render(out, frames = out.length >> 1) {
        if (frames > this.#rcap) {
            if (this.#rbuf)
                this.#ex.free(this.#rbuf);
            this.#rcap = frames;
            this.#rbuf = this.#alloc(frames * 8);
        }
        const n = this.#ex.ae3_synth_render(this.#s, this.#rbuf, frames);
        if (n > 0) {
            const f32 = this.#mem().f32;       /* after render: growth-safe */
            const base = this.#rbuf >> 2;
            out.set(f32.subarray(base, base + n * 2));
        }
        return n;
    }

    /* ---- introspection */
    done() { return !!this.#ex.ae3_synth_done(this.#s); }
    pos()  { return this.#ex.ae3w_pos(this.#s); }

    voice(i) {
        if (!this.#ex.ae3w_voice(this.#s, i, this.#scratch))
            return null;
        const v = this.#mem().i32, b = this.#scratch >> 2;
        return { in_use: !!v[b], active: !!v[b + 1], released: !!v[b + 2],
                 ch: v[b + 3], key: v[b + 4], env: v[b + 5] };
    }

    seqEvents() { return this.#ex.ae3_synth_seq_events(this.#s); }
    seqPpqn()   { return this.#ex.ae3_synth_seq_ppqn(this.#s); }

    seqEvent(i) {
        if (!this.#ex.ae3w_seq_event(this.#s, i, this.#scratch))
            return null;
        const v = this.#mem().u32, b = this.#scratch >> 2;
        return { tick: v[b], kind: v[b + 1], status: v[b + 2],
                 a: v[b + 3], b: v[b + 4], uspqn: v[b + 5] };
    }

    /* The whole parsed sequence in one walk (timeline builders read it once). */
    seqEventsAll() {
        const n = this.seqEvents(), out = new Array(n);
        for (let i = 0; i < n; i++)
            out[i] = this.seqEvent(i);
        return out;
    }

    clock() {
        this.#ex.ae3w_clock(this.#s, this.#scratch);
        const v = this.#mem().f64, b = this.#scratch >> 3;
        return { seg_tick: v[b], seg_sample: v[b + 1],
                 spt: v[b + 2], tick_offset: v[b + 3] };
    }

    stats() {
        this.#ex.ae3w_stats(this.#s, this.#scratch);
        const v = this.#mem().f64, b = this.#scratch >> 3;
        const raw = new Map(STATS_FIELDS.map((name, i) => [name, v[b + i]]));
        /* Recombine the split FNV hashes exactly. */
        const u64 = (lo, hi) => (BigInt(hi) << 32n) | BigInt(lo);
        const out = {};
        for (const [name, val] of raw)
            if (!name.endsWith("_lo") && !name.endsWith("_hi"))
                out[name] = val;
        out.hash_ch = u64(raw.get("hash_ch_lo"), raw.get("hash_ch_hi"));
        out.hash_tempo = u64(raw.get("hash_tempo_lo"), raw.get("hash_tempo_hi"));
        return out;
    }

    /* Free the synth. The wasm instance (and its whole memory) is dropped with
     * this object; dispose exists so long-lived hosts can release eagerly. */
    dispose() {
        if (this.#s) {
            this.#ex.ae3_synth_free(this.#s);
            this.#s = 0;
        }
    }
}
