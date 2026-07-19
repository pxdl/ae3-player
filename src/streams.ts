/* STREAMS tab backbone (VIEWER_PLAN §2): the sound/stream (.x) family --
 * extraction phase, catalog, taxonomy grouping, worker decode, playback.
 *
 * Extraction is a SECOND OPFS phase with its own completeness marker
 * (stream_meta.json, written LAST like the BGM phase's meta.json), run on
 * first STREAMS use -- BGM-only listeners never pay the +341 MB. A session
 * resumed from OPFS without streams cached needs the ISO once more
 * (attachIso); the catalog and all grouping derive from the user's own
 * extraction, in code -- this site ships no game data.
 *
 * Format ground truth: ae3-sdk/docs/formats/EXST.md. Decode runs in a
 * worker over the SDK's AE3Exst (public/synth/stream.mjs, the module the
 * private corpus gate drives under Node). */

import { OpfsCache, openDisc, BlobSource,
         type Vfi, type VfiEntry } from "./vendor/extract/index.ts";

const META = "stream_meta.json";

export type ProgressFn = (done: number, total: number, name: string) => void;

export interface StreamEntry {
    name: string;        /* basename, e.g. "phone_001.x" */
    channels: number;
    rate: number;
    sectors: number;     /* actual payload sectors, (size - 0x78) >> 11 */
    length: number;      /* header length field; 16 files overstate (spec §4) */
}

export interface StreamCatalog { v: 1; entries: StreamEntry[]; }

/* Catalog-time header read (magic + channels s16@+0x06 + rate u32@+0x08 +
 * length u32@+0x14, little-endian) -- the same fields ae3_exst_parse
 * validates; the wasm decoder re-parses authoritatively at play time. */
function xHeader(b: Uint8Array, size: number, name: string): Omit<StreamEntry, "name"> {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 0x78 || v.getUint32(0, true) !== 0x54535845)
        throw new Error(`${name}: not an EXST stream`);
    const channels = v.getUint16(0x06, true);
    if (channels < 1 || channels > 8)
        throw new Error(`${name}: channel count ${channels} out of range`);
    return { channels, rate: v.getUint32(0x08, true),
             sectors: Math.floor((size - 0x78) / 0x800),
             length: v.getUint32(0x14, true) };
}

/* ---- taxonomy (VIEWER_PLAN §3, measured on the whole corpus) -------------
 * channels == 2 -> MUSIC, else VOICE; sub-grouped by the first '_'-token
 * (whole name when none). Derived per disc from the user's own catalog. */

export interface StreamGroup { key: string; entries: StreamEntry[]; }

export function groupStreams(entries: StreamEntry[]):
        { music: StreamGroup[]; voice: StreamGroup[] } {
    const buckets = { music: new Map<string, StreamEntry[]>(),
                      voice: new Map<string, StreamEntry[]>() };
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const stem = e.name.replace(/\.x$/, "");
        const key = stem.includes("_") ? stem.slice(0, stem.indexOf("_")) : stem;
        const m = e.channels === 2 ? buckets.music : buckets.voice;
        (m.get(key) ?? m.set(key, []).get(key)!).push(e);
    }
    const order = (m: Map<string, StreamEntry[]>): StreamGroup[] =>
        [...m.entries()].map(([key, es]) => ({ key, entries: es }))
            .sort((a, b) => b.entries.length - a.entries.length
                            || a.key.localeCompare(b.key));
    return { music: order(buckets.music), voice: order(buckets.voice) };
}

/* ---- store: OPFS phase + payload access ---------------------------------- */

export class StreamStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string | null;
    private byName = new Map<string, VfiEntry>();
    private catalog: StreamCatalog | null = null;   /* in-memory (no-OPFS runs) */

    constructor(cache: OpfsCache | null, vfi: Vfi | null,
                cacheKey: string | null) {
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    /** ISO reachable this session (constructed from one, or attachIso ran). */
    hasIso(): boolean { return this.vfi !== null; }

    /** Completed catalog, if the streams phase ever finished (or ran
     *  cache-less this session). null = show the setup panel. */
    async cached(): Promise<StreamCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        const raw = await this.cache.read(META);
        if (!raw) return null;
        try {
            const c = JSON.parse(new TextDecoder().decode(raw)) as StreamCatalog;
            if (c.v !== 1 || !Array.isArray(c.entries)) return null;
            this.catalog = c;
            return c;
        } catch {
            return null;
        }
    }

    /** Re-attach the ISO for a session resumed from OPFS. Refuses a
     *  different disc: the streams would land under the wrong cache key. */
    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        if (this.cacheKey && disc.cacheKey !== this.cacheKey)
            throw new Error("this ISO is a different disc than the cached one "
                            + "-- forget the disc first to switch");
        this.vfi = disc.vfi;
        this.byName.clear();
    }

    private locate(): Map<string, VfiEntry> {
        if (this.byName.size || !this.vfi) return this.byName;
        /* region-tolerant like locateBgmAssets: best-populated stream dir */
        const all = this.vfi.entries.filter(e =>
            /(^|\/)sound\/stream\/[^/]+\.x$/.test(e.path));
        const byDir = new Map<string, VfiEntry[]>();
        for (const e of all) {
            const dir = e.path.slice(0, e.path.lastIndexOf("/"));
            (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(e);
        }
        const best = [...byDir.values()]
            .sort((a, b) => b.length - a.length)[0] ?? [];
        for (const e of best)
            this.byName.set(e.path.slice(e.path.lastIndexOf("/") + 1), e);
        return this.byName;
    }

    /** The streams phase: copy every .x into OPFS (has()-skip resumable),
     *  build the catalog from windowed header reads, write the marker LAST.
     *  Cache-less sessions build the catalog only (payloads read from the
     *  ISO on demand, this visit only). */
    async extract(progress: ProgressFn): Promise<StreamCatalog> {
        if (!this.vfi)
            throw new Error("no ISO attached -- choose your disc image first");
        const entries = [...this.locate().entries()]
            .sort((a, b) => a[0].localeCompare(b[0]));
        if (entries.length === 0)
            throw new Error("no sound/stream assets found in DATA.BIN");
        const rows: StreamEntry[] = [];
        let cache = this.cache;
        for (let i = 0; i < entries.length; i++) {
            const [name, e] = entries[i]!;
            progress(i, entries.length, name);
            const hdr = await this.vfi.src.read(this.vfi.byteOffset(e), 0x78);
            rows.push({ name, ...xHeader(hdr, e.size, name) });
            if (!cache) continue;
            try {
                if (await cache.has(`stream/${name}`)) continue;
            } catch (err) {
                console.warn("OPFS failed; streams from the ISO this visit", err);
                cache = null;
                continue;
            }
            const data = await this.vfi.read(e);        /* hard failure */
            try {
                await cache.write(`stream/${name}`, data);
            } catch (err) {
                console.warn("OPFS write failed; streams from the ISO this visit", err);
                cache = null;
            }
        }
        const catalog: StreamCatalog = { v: 1, entries: rows };
        if (cache)
            await cache.write(META,
                new TextEncoder().encode(JSON.stringify(catalog)));
        this.catalog = catalog;
        progress(entries.length, entries.length, "done");
        return catalog;
    }

    /** One stream's bytes: OPFS first, ISO fallback when in hand. */
    async read(name: string): Promise<Uint8Array | null> {
        if (this.cache) {
            const b = await this.cache.read(`stream/${name}`);
            if (b) return b;
        }
        const e = this.locate().get(name);
        return e && this.vfi ? this.vfi.read(e) : null;
    }
}

/* ---- worker decode ------------------------------------------------------- */

export interface DecodedStream {
    name: string;
    header: { channels: number; rate: number; loop: number;
              loop_start: number; length: number;
              vol_l: number[]; vol_r: number[]; reverb: number[] };
    sectors: number;
    padFrames: number;
    samplesPerChannel: number;    /* untrimmed */
    pcm: Int16Array;              /* untrimmed, interleaved */
}

/* Own worker (same script as the exporter's): stream decodes never queue
 * behind a WAV render, and vice versa. */
export class StreamDecoder {
    private worker: Worker | null = null;
    private seq = 0;
    private pending = new Map<number, {
        resolve: (v: any) => void; reject: (e: Error) => void }>();

    private ensure(): Worker {
        if (this.worker) return this.worker;
        this.worker = new Worker(
            `${import.meta.env.BASE_URL}synth/export-worker.mjs`,
            { type: "module" });
        this.worker.onmessage = (e) => {
            const m = e.data;
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            if (m.t === "error") p.reject(new Error(m.message));
            else p.resolve(m);
        };
        this.worker.onerror = (e) => {
            const err = new Error(e.message || "stream worker failed");
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
        };
        return this.worker;
    }

    private call<T>(msg: Record<string, unknown>,
                    transfer: Transferable[]): Promise<T> {
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ensure().postMessage({ ...msg, id }, transfer);
        });
    }

    /** Full untrimmed decode (the UI derives the trimmed view locally). */
    async decode(name: string, file: Uint8Array): Promise<DecodedStream> {
        const m = await this.call<any>({ t: "stream", file }, [file.buffer]);
        return { name, header: m.header, sectors: m.sectors,
                 padFrames: m.padFrames,
                 samplesPerChannel: m.samplesPerChannel, pcm: m.pcm };
    }

    /** WAV bytes exactly as `ae3 exst --decode [--trim-pad]` frames them. */
    async wav(name: string, file: Uint8Array,
              trimPad: boolean): Promise<Uint8Array> {
        const m = await this.call<any>(
            { t: "stream-wav", file, trimPad, name }, [file.buffer]);
        return m.wav;
    }
}

/* ---- playback ------------------------------------------------------------ */

/* AudioBuffer playback (no worklet: streams are fixed PCM). The buffer
 * carries the stream's native rate; the context resamples on output. Trim
 * switches between two views of the SAME decode -- trimming only removes
 * tail samples, so no re-decode round-trip. */
export class StreamPlayer {
    onended: (() => void) | null = null;
    private ctx: AudioContext | null = null;
    private node: AudioBufferSourceNode | null = null;
    private stream: DecodedStream | null = null;
    private bufs = new Map<boolean, AudioBuffer>();   /* key: trimmed? */
    private trim = true;
    private playing_ = false;
    private t0 = 0;             /* ctx.currentTime at start */
    private off = 0;            /* seconds into the buffer at start */

    /** Lazy context -- call from a user gesture (Safari autoplay policy,
     *  same stance as the BGM player). */
    private ensureCtx(): AudioContext {
        this.ctx ??= new AudioContext();
        void this.ctx.resume();
        return this.ctx;
    }

    private samples(trim: boolean): number {
        const s = this.stream!;
        return trim ? s.samplesPerChannel - s.padFrames * 28
                    : s.samplesPerChannel;
    }

    private buffer(trim: boolean): AudioBuffer {
        let b = this.bufs.get(trim);
        if (b) return b;
        const s = this.stream!;
        const n = Math.max(1, this.samples(trim));
        const ch = s.header.channels;
        b = new AudioBuffer({ numberOfChannels: ch, length: n,
                              sampleRate: s.header.rate });
        for (let c = 0; c < ch; c++) {
            const f = new Float32Array(n);
            for (let i = 0; i < n; i++)
                f[i] = s.pcm[i * ch + c]! / 32768;
            b.copyToChannel(f, c);
        }
        this.bufs.set(trim, b);
        return b;
    }

    load(s: DecodedStream, trim: boolean): void {
        this.stop();
        this.stream = s;
        this.trim = trim;
        this.bufs.clear();
        this.off = 0;
    }

    decoded(): DecodedStream | null { return this.stream; }
    playing(): boolean { return this.playing_; }
    dur(): number {
        return this.stream ? this.samples(this.trim) / this.stream.header.rate : 0;
    }
    pos(): number {
        if (!this.stream) return 0;
        const p = this.playing_ && this.ctx
            ? this.off + this.ctx.currentTime - this.t0 : this.off;
        return Math.min(p, this.dur());
    }

    /** Trim toggle keeps the position (clamped into the new duration). */
    setTrim(trim: boolean): void {
        if (trim === this.trim) return;
        const was = this.playing_;
        const at = this.pos();
        this.stopNode();
        this.trim = trim;
        this.off = Math.min(at, this.dur());
        if (was) this.play();
    }

    play(): void {
        if (!this.stream || this.playing_) return;
        const ctx = this.ensureCtx();
        if (this.off >= this.dur()) this.off = 0;     /* SPACE after end restarts */
        const node = ctx.createBufferSource();
        node.buffer = this.buffer(this.trim);
        node.connect(ctx.destination);
        node.onended = () => {
            if (this.node !== node) return;           /* superseded/stopped */
            this.node = null;
            this.off = this.dur();
            this.playing_ = false;
            this.onended?.();
        };
        node.start(0, this.off);
        this.node = node;
        this.t0 = ctx.currentTime;
        this.playing_ = true;
    }

    private stopNode(): void {
        if (this.node) {
            const n = this.node;
            this.node = null;                         /* mute onended */
            try { n.stop(); } catch { /* not started */ }
        }
        this.playing_ = false;
    }

    pause(): void {
        if (!this.playing_) return;
        this.off = this.pos();
        this.stopNode();
    }

    seek(sec: number): void {
        const was = this.playing_;
        this.stopNode();
        this.off = Math.max(0, Math.min(sec, this.dur()));
        if (was) this.play();
    }

    stop(): void {
        this.stopNode();
        this.off = 0;
        this.stream = null;
        this.bufs.clear();
    }
}
