/* STREAMS tab backbone: the sound/stream (.x) family -- extraction phase,
 * catalog, taxonomy grouping, worker decode, playback.
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
import {
    assertAttachedDiscIdentity,
    assertCacheSourceIdentity,
} from "./disc-identity.ts";
import { technicalReason } from "./errors.ts";

const META = "stream_meta.json";

export type ProgressFn = (done: number, total: number, name: string) => void;

export interface StreamEntry {
    name: string;        /* basename, e.g. "phone_001.x" */
    channels: number;
    rate: number;
    sectors: number;     /* actual payload sectors, (size - 0x78) >> 11 */
    length: number;      /* header length field; 16 files overstate (spec §4) */
}

export interface StreamCatalog {
    readonly v: 2;
    readonly sourceKey: string;
    readonly entries: readonly StreamEntry[];
}

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

/* ---- taxonomy, measured on the whole corpus ------------------------------
 * channels == 2 -> MUSIC, else VOICE; sub-grouped by the first '_'-token
 * (whole name when none). Derived per disc from the user's own catalog. */

export interface StreamGroup { key: string; entries: StreamEntry[]; }

export function groupStreams(entries: readonly StreamEntry[]):
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

const STREAM_NAME = /^[^/\\\u0000-\u001f\u007f-\u009f]+\.x$/i;

function isSafeInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= minimum;
}

function isStreamCatalog(value: unknown,
                         expectedSourceKey: string): value is StreamCatalog {
    if (value === null || typeof value !== "object") return false;
    const catalog = value as Record<string, unknown>;
    if (catalog.v !== 2 || catalog.sourceKey !== expectedSourceKey
            || !Array.isArray(catalog.entries)
            || catalog.entries.length === 0)
        return false;
    const names = new Set<string>();
    return catalog.entries.every(value => {
        if (value === null || typeof value !== "object") return false;
        const entry = value as Record<string, unknown>;
        if (typeof entry.name !== "string"
                || !STREAM_NAME.test(entry.name)
                || names.has(entry.name)
                || !isSafeInteger(entry.channels, 1) || entry.channels > 8
                || !isSafeInteger(entry.rate, 1)
                || !isSafeInteger(entry.sectors)
                || !isSafeInteger(entry.length))
            return false;
        names.add(entry.name);
        return true;
    });
}

/* ---- store: OPFS phase + payload access ---------------------------------- */

export class StreamStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string;
    private byName = new Map<string, VfiEntry>();
    private catalog: StreamCatalog | null = null;   /* in-memory (no-OPFS runs) */
    private cacheWarning: string | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null,
                cacheKey: string) {
        assertCacheSourceIdentity(cache, cacheKey);
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    /** ISO reachable this session (constructed from one, or attachIso ran). */
    hasIso(): boolean { return this.vfi !== null; }
    get persistenceWarning(): string | null { return this.cacheWarning; }

    /** Completed catalog, if the streams phase ever finished (or ran
     *  cache-less this session). null = show the setup panel. */
    async cached(): Promise<StreamCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        let raw: Uint8Array | null;
        try {
            raw = await this.cache.read(META);
        } catch (error) {
            this.useAttachedIsoAfterCacheFailure(
                error,
                "the Streams cache is unavailable -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch (error) {
            this.useAttachedIsoAfterCacheFailure(
                error,
                "the cached Streams index is damaged -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        if (!isStreamCatalog(parsed, this.cacheKey)) {
            this.useAttachedIsoAfterCacheFailure(
                new Error("the cached Streams index has an invalid schema"),
                "the cached Streams index is damaged -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        this.catalog = parsed;
        return parsed;
    }

    /** Re-attach the ISO for a session resumed from OPFS. Refuses a
     *  different disc: the streams would land under the wrong cache key. */
    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        assertAttachedDiscIdentity(this.cacheKey, disc.cacheKey);
        this.vfi = disc.vfi;
        this.byName.clear();
    }

    private useAttachedIsoAfterCacheFailure(error: unknown, message: string): void {
        if (!this.vfi) throw new Error(message, { cause: error });
        this.cacheWarning = `${message} (${technicalReason(error)}); `
            + "using the attached ISO for this session";
        console.warn("Streams cache failed; using the attached ISO", error);
        this.cache = null;
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
            } catch (error) {
                this.useAttachedIsoAfterCacheFailure(
                    error,
                    "the Streams cache is unavailable",
                );
                cache = null;
                continue;
            }
            const data = await this.vfi.read(e);        /* hard failure */
            try {
                await cache.write(`stream/${name}`, data);
            } catch (error) {
                this.useAttachedIsoAfterCacheFailure(
                    error,
                    "the Streams cache is unavailable",
                );
                cache = null;
            }
        }
        const catalog: StreamCatalog = {
            v: 2,
            sourceKey: this.cacheKey,
            entries: rows,
        };
        if (cache) {
            try {
                await cache.write(
                    META,
                    new TextEncoder().encode(JSON.stringify(catalog)),
                );
            } catch (error) {
                this.useAttachedIsoAfterCacheFailure(
                    error,
                    "the Streams index could not be persisted",
                );
            }
        }
        this.catalog = catalog;
        progress(entries.length, entries.length, "done");
        return catalog;
    }

    /** One stream's bytes: OPFS first, ISO fallback when in hand. */
    async read(name: string): Promise<Uint8Array | null> {
        if (!STREAM_NAME.test(name))
            throw new Error("the stream name is invalid");
        if (this.cache) {
            try {
                const bytes = await this.cache.read(`stream/${name}`);
                if (bytes) return bytes;
            } catch (error) {
                this.useAttachedIsoAfterCacheFailure(
                    error,
                    "the Streams cache is unavailable",
                );
            }
        }
        const entry = this.locate().get(name);
        return entry && this.vfi ? this.vfi.read(entry) : null;
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
interface StreamDone {
    readonly t: "stream-done";
    readonly id: number;
    readonly header: DecodedStream["header"];
    readonly sectors: number;
    readonly padFrames: number;
    readonly samplesPerChannel: number;
    readonly pcm: Int16Array;
}

interface StreamWavDone {
    readonly t: "stream-wav-done";
    readonly id: number;
    readonly name: string;
    readonly wav: Uint8Array;
}

type StreamWorkerSuccess = StreamDone | StreamWavDone;
type StreamPendingKind = "decode" | "wav";

function objectRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : null;
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): boolean {
    return Object.keys(value).every(key => allowed.has(key));
}

const STREAM_ERROR_KEYS = new Set(["t", "id", "message"]);

function isIntegerArray(value: unknown, length: number): value is number[] {
    return Array.isArray(value)
        && value.length === length
        && value.every(item => typeof item === "number"
            && Number.isSafeInteger(item));
}

function isStreamDone(value: unknown): value is StreamDone {
    const message = objectRecord(value);
    const header = objectRecord(message?.header);
    if (!message || message.t !== "stream-done"
            || !hasOnlyKeys(message, new Set([
                "t", "id", "header", "sectors", "padFrames",
                "samplesPerChannel", "pcm",
            ]))
            || !isSafeInteger(message.id, 1)
            || !header
            || !hasOnlyKeys(header, new Set([
                "channels", "rate", "loop", "loop_start", "length",
                "vol_l", "vol_r", "reverb",
            ]))
            || !isSafeInteger(header.channels, 1) || header.channels > 8
            || !isSafeInteger(header.rate, 1)
            || !(header.loop === 0 || header.loop === 1)
            || !isSafeInteger(header.loop_start, -1)
            || !isSafeInteger(header.length)
            || !isIntegerArray(header.vol_l, 8)
            || !isIntegerArray(header.vol_r, 8)
            || !isIntegerArray(header.reverb, 8)
            || !isSafeInteger(message.sectors)
            || !isSafeInteger(message.padFrames)
            || !isSafeInteger(message.samplesPerChannel)
            || !(message.pcm instanceof Int16Array))
        return false;
    const samples = message.samplesPerChannel as number;
    const channels = header.channels as number;
    return Number.isSafeInteger(samples * channels)
        && message.pcm.length === samples * channels
        && (message.padFrames as number) * 28 <= samples;
}

function isStreamWavDone(value: unknown, expectedName: string): value is StreamWavDone {
    const message = objectRecord(value);
    return message !== null
        && hasOnlyKeys(message, new Set(["t", "id", "name", "wav"]))
        && message.t === "stream-wav-done"
        && isSafeInteger(message.id, 1)
        && message.name === expectedName
        && message.wav instanceof Uint8Array
        && message.wav.byteLength >= 44;
}


/* Own worker (same script as the exporter's): stream decodes never queue
 * behind a WAV render, and vice versa. */
export class StreamDecoder {
    private worker: Worker | null = null;
    private seq = 0;
    private pending = new Map<number, {
        kind: StreamPendingKind;
        name: string;
        resolve: (value: StreamWorkerSuccess) => void;
        reject: (error: Error) => void;
    }>();

    private failWorker(worker: Worker, error: Error): void {
        if (this.worker !== worker) return;
        worker.terminate();
        this.worker = null;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    private ensure(): Worker {
        if (this.worker) return this.worker;
        const worker = new Worker(
            `${import.meta.env?.BASE_URL ?? "/"}synth/export-worker.mjs`,
            { type: "module" },
        );
        this.worker = worker;
        worker.onmessage = event => {
            if (this.worker !== worker) return;
            const message = objectRecord(event.data);
            if (!message || !isSafeInteger(message.id, 1)) {
                this.failWorker(worker, new Error("invalid stream worker response"));
                return;
            }
            const id = message.id;
            const pending = this.pending.get(id);
            if (!pending) {
                this.failWorker(worker, new Error("invalid stream worker response"));
                return;
            }
            if (message.t === "error") {
                if (!hasOnlyKeys(message, STREAM_ERROR_KEYS)
                        || typeof message.message !== "string"
                        || message.message.length === 0) {
                    this.failWorker(worker, new Error("invalid stream worker response"));
                    return;
                }
                this.pending.delete(id);
                pending.reject(new Error(technicalReason(message.message)));
                return;
            }
            let result: StreamWorkerSuccess;
            if (pending.kind === "decode") {
                if (!isStreamDone(message)) {
                    this.failWorker(worker, new Error("invalid stream worker response"));
                    return;
                }
                result = message;
            } else {
                if (!isStreamWavDone(message, pending.name)) {
                    this.failWorker(worker, new Error("invalid stream worker response"));
                    return;
                }
                result = message;
            }
            this.pending.delete(id);
            pending.resolve(result);
        };
        worker.onerror = event => {
            event.preventDefault();
            this.failWorker(
                worker,
                new Error(technicalReason(event.message || "stream worker failed")),
            );
        };
        worker.onmessageerror = () => {
            this.failWorker(worker, new Error("invalid stream worker response"));
        };
        return worker;
    }

    dispose(): void {
        const error = new Error("stream operation cancelled for another disc");
        if (this.worker) {
            this.failWorker(this.worker, error);
            return;
        }
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    private call(kind: "decode", name: string,
                 msg: Record<string, unknown>,
                 transfer: Transferable[]): Promise<StreamDone>;
    private call(kind: "wav", name: string,
                 msg: Record<string, unknown>,
                 transfer: Transferable[]): Promise<StreamWavDone>;
    private call(kind: StreamPendingKind, name: string,
                 msg: Record<string, unknown>,
                 transfer: Transferable[]): Promise<StreamWorkerSuccess> {
        const id = ++this.seq;
        const { promise, resolve, reject } =
            Promise.withResolvers<StreamWorkerSuccess>();
        this.pending.set(id, { kind, name, resolve, reject });
        try {
            this.ensure().postMessage({ ...msg, id }, transfer);
        } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            const worker = this.worker;
            if (worker) this.failWorker(worker, error);
            else {
                this.pending.delete(id);
                reject(error);
            }
        }
        return promise;
    }

    /** Full untrimmed decode (the UI derives the trimmed view locally). */
    async decode(name: string, file: Uint8Array): Promise<DecodedStream> {
        const message = await this.call(
            "decode",
            name,
            { t: "stream", file },
            [file.buffer],
        );
        return {
            name,
            header: message.header,
            sectors: message.sectors,
            padFrames: message.padFrames,
            samplesPerChannel: message.samplesPerChannel,
            pcm: message.pcm,
        };
    }

    /** WAV bytes exactly as `ae3 exst --decode [--trim-pad]` frames them. */
    async wav(name: string, file: Uint8Array,
              trimPad: boolean): Promise<Uint8Array> {
        const message = await this.call(
            "wav",
            name,
            { t: "stream-wav", file, trimPad, name },
            [file.buffer],
        );
        return message.wav;
    }
}

/* ---- playback ------------------------------------------------------------ */

/* AudioBuffer playback (no worklet: streams are fixed PCM). The buffer
 * carries the stream's native rate; the context resamples on output. Trim
 * switches between two views of the SAME decode -- trimming only removes
 * tail samples, so no re-decode round-trip. */
export class StreamPlayer {
    onended: (() => void) | null = null;
    onerror: ((error: Error) => void) | null = null;
    private ctx: AudioContext | null = null;
    private node: AudioBufferSourceNode | null = null;
    private stream: DecodedStream | null = null;
    private bufs = new Map<boolean, AudioBuffer>();   /* key: trimmed? */
    private trim = true;
    private playing_ = false;
    private t0 = 0;             /* ctx.currentTime at start */
    private off = 0;            /* seconds into the buffer at start */
    private generation = 0;

    /** Lazy context -- call from a user gesture (Safari autoplay policy,
     *  same stance as the BGM player). */
    private ensureCtx(generation: number): AudioContext {
        this.ctx ??= new AudioContext();
        const ctx = this.ctx;
        void ctx.resume().catch(cause => {
            if (this.ctx !== ctx || this.generation !== generation) return;
            const error = cause instanceof Error ? cause : new Error(String(cause));
            this.stopNode();
            this.onerror?.(error);
        });
        return ctx;
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
        const generation = ++this.generation;
        const ctx = this.ensureCtx(generation);
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
        this.generation++;
        if (this.node) {
            const node = this.node;
            this.node = null;                         /* mute onended */
            try {
                node.stop();
            } catch (error) {
                if (!(error instanceof DOMException
                        && error.name === "InvalidStateError"))
                    console.error("stream source stop failed", error);
            }
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
