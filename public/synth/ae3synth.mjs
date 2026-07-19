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

/* AE3_DUCK_* (cue layer) */
export const DUCK_DEMO = 0, DUCK_PHONE = 1;

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
    loadSe(bank, request) { const r = this.#ex.ae3_synth_load_se(this.#s, bank, request);
                            if (r !== 0) throw new Error(`loadSe: ${this.#error()}`); }
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

    /* ---- cue layer (the game's volume model above the driver; see ae3synth.h).
     * Enabled, it owns the song volume: per-song scale, options slider, dolby
     * factor, and the demo/phone ducks (DUCK_DEMO/DUCK_PHONE) with the game's
     * 0.7 x, 0.5 s in / 2.0 s out linear crossfades on the 60 Hz tick grid. */
    cueEnable(on)          { this.#ex.ae3_synth_cue_enable(this.#s, on ? 1 : 0); }
    cueScale(v)            { this.#ex.ae3_synth_cue_scale(this.#s, v); }
    cueSlider(v)           { this.#ex.ae3_synth_cue_slider(this.#s, v); }
    cueDolby(on)           { this.#ex.ae3_synth_cue_dolby(this.#s, on ? 1 : 0); }
    cueDuck(which, active) { this.#ex.ae3_synth_cue_duck(this.#s, which, active ? 1 : 0); }
    cueDuckConfig(which, level, inSecs, outSecs)
                           { this.#ex.ae3_synth_cue_duck_config(this.#s, which, level, inSecs, outSecs); }
    cueSongvol()           { return this.#ex.ae3_synth_cue_songvol(this.#s); }
    cueDuckLevel(which)    { return this.#ex.ae3_synth_cue_duck_level(this.#s, which); }

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

    /* ---- bank introspection (ae3_synth_bank_waveform*; see ae3synth.h) */
    bankWaveforms() { return this.#ex.ae3_synth_bank_waveforms(this.#s); }
    seBanks() { return this.#ex.ae3_synth_se_banks(this.#s); }
    seRequests(bank) { return this.#ex.ae3_synth_se_requests(this.#s, bank); }

    bankWaveform(i) {
        if (!this.#ex.ae3w_bank_waveform(this.#s, i, this.#scratch))
            return null;
        const v = this.#mem().i32, b = this.#scratch >> 2;
        return { addr: v[b], samples: v[b + 1], loop_start: v[b + 2],
                 prog: v[b + 3], tone: v[b + 4], root: v[b + 5],
                 tune: v[b + 6], refs: v[b + 7] };
    }

    /* Decode waveform i's single pass into a fresh Int16Array (null = bad i). */
    bankWaveformPcm(i) {
        const w = this.bankWaveform(i);
        if (w === null)
            return null;
        const p = this.#alloc(w.samples * 2 || 2);
        const n = this.#ex.ae3_synth_bank_waveform_pcm(this.#s, i, p, w.samples);
        /* re-view after the call: decode never grows memory, but stay in the
         * same growth-safe pattern render() uses */
        const heap = this.#mem().u8.buffer;
        const out = n >= 0 ? new Int16Array(heap.slice(p, p + n * 2)) : null;
        this.#ex.free(p);
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

/* ---- EXST (.x) streams: binding over ae3_exst_* (core/exst.c) ------------
 *
 * Standalone decoder, own wasm instance (same isolation stance as AE3Synth).
 * Semantics per core/ae3synth.h: per-sector decode with per-channel history
 * in a state object; payload flags never stop decode; the header's length
 * field is untrusted (16 shipped files overstate it -- EXST.md §4), the
 * actual whole-sector payload is the bound. decodeFile() is the workhorse
 * (player worker, gates); reset()/decodeSector() expose the streaming form
 * for chunked decode of the multi-minute music tracks. */

export const EXST_HDR = 0x78;
export const EXST_SECTOR = 2048;

export class AE3Exst {
    static async instantiate(wasmSource) {
        const module = wasmSource instanceof WebAssembly.Module
            ? wasmSource
            : await WebAssembly.compile(wasmSource);
        const exst = new AE3Exst();
        const imports = {};
        for (const im of WebAssembly.Module.imports(module)) {
            imports[im.module] ??= {};
            imports[im.module][im.name] =
                im.module === "env" && im.name === "emscripten_notify_memory_growth"
                    ? () => { exst.#views = null; }
                    : () => { throw new Error(`wasm called unstubbed import ${im.module}.${im.name}`); };
        }
        const instance = await WebAssembly.instantiate(module, imports);
        exst.#init(instance);
        return exst;
    }

    #ex;               /* wasm exports */
    #views = null;     /* heap views; null after memory growth */
    #state = 0;        /* ae3_exst*, opaque (size via ae3w_exst_state_size) */
    #scratch = 0;      /* 29-u32 header flattener output + sector staging */
    #sec = 0;          /* staged input sector */
    #out = 0;          /* decoded sector output: 3584 s16 */
    #channels = 0;

    #init(instance) {
        this.#ex = instance.exports;
        this.#ex._initialize();
        this.#state = this.#alloc(this.#ex.ae3w_exst_state_size());
        this.#scratch = this.#alloc(29 * 4);
        this.#sec = this.#alloc(EXST_SECTOR);
        this.#out = this.#alloc(3584 * 2);
    }

    #mem() {
        if (this.#views === null) {
            const b = this.#ex.memory.buffer;
            this.#views = { u8: new Uint8Array(b), u32: new Uint32Array(b) };
        }
        return this.#views;
    }

    #alloc(n) {
        const p = this.#ex.malloc(n);
        if (!p)
            throw new Error(`wasm malloc(${n}) failed`);
        return p;
    }

    /* Parse + validate a 0x78-byte stream header (throws on bad magic /
     * channel count). Field names mirror ae3_exst_header. */
    parseHeader(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const n = Math.min(u8.length, EXST_HDR);
        const p = this.#alloc(n || 1);
        this.#mem().u8.set(u8.subarray(0, n), p);
        const ok = this.#ex.ae3w_exst_parse(p, n, this.#scratch);
        this.#ex.free(p);
        if (!ok)
            throw new Error("not an EXST stream (bad magic or channel count)");
        const v = this.#mem().u32, b = this.#scratch >> 2;
        return {
            channels: v[b], rate: v[b + 1], loop: v[b + 2],
            loop_start: v[b + 3], length: v[b + 4],
            vol_l: Array.from(v.subarray(b + 5, b + 13)),
            vol_r: Array.from(v.subarray(b + 13, b + 21)),
            reverb: Array.from(v.subarray(b + 21, b + 29)),
        };
    }

    /* Arm the decode state (throws on unsupported channel count -- per-sector
     * decode needs frame-aligned slices, ch in {1,2,4,8}; shipped: 1 or 2). */
    reset(channels) {
        if (this.#ex.ae3_exst_reset(this.#state, channels) !== 0)
            throw new Error(`unsupported channel count ${channels}`);
        this.#channels = channels;
    }

    /* Decode one 2048-byte sector -> fresh Int16Array, interleaved,
     * 3584/channels samples per channel. */
    decodeSector(sector) {
        const u8 = sector instanceof Uint8Array ? sector : new Uint8Array(sector);
        if (u8.length !== EXST_SECTOR)
            throw new Error(`sector must be ${EXST_SECTOR} bytes`);
        this.#mem().u8.set(u8, this.#sec);
        const spc = this.#ex.ae3_exst_decode(this.#state, this.#sec, this.#out);
        if (spc < 0)
            throw new Error("decode state not armed (call reset)");
        const heap = this.#mem().u8.buffer;
        return new Int16Array(heap.slice(this.#out, this.#out + spc * this.#channels * 2));
    }

    /* Whole-file decode: header + actual whole-sector payload (the header
     * length field is reported, never trusted). trimPad drops the trailing
     * silent-pad run, shortened equally across channels like the oracle.
     * -> { header, sectors, padFrames, samplesPerChannel, pcm } */
    decodeFile(file, { trimPad = false } = {}) {
        const u8 = file instanceof Uint8Array ? file : new Uint8Array(file);
        const header = this.parseHeader(u8);
        this.reset(header.channels);
        const sectors = Math.floor((u8.length - EXST_HDR) / EXST_SECTOR);
        const payLen = sectors * EXST_SECTOR;
        const pay = this.#alloc(payLen || 1);
        this.#mem().u8.set(u8.subarray(EXST_HDR, EXST_HDR + payLen), pay);
        const padFrames = this.#ex.ae3_exst_trailing_pad(pay, payLen, header.channels);
        const spcSector = 3584 / header.channels;
        let samplesPerChannel = sectors * spcSector;
        const pcm = new Int16Array(samplesPerChannel * header.channels);
        for (let s = 0; s < sectors; s++) {
            this.#ex.ae3_exst_decode(this.#state, pay + s * EXST_SECTOR, this.#out);
            const heap16 = new Int16Array(this.#mem().u8.buffer, this.#out, 3584);
            pcm.set(heap16, s * 3584);
        }
        this.#ex.free(pay);
        if (trimPad)
            samplesPerChannel -= padFrames * 28;
        return {
            header, sectors, padFrames, samplesPerChannel,
            pcm: pcm.subarray(0, samplesPerChannel * header.channels),
        };
    }
}
