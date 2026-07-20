/* Embedded-SE tab backbone: lazy sound/se extraction, bank catalog, and
 * worker-side table inspection through the public ae3_synth_se_* API.
 * Everything comes from the user's disc and stays in origin-private storage. */

import { BlobSource, OpfsCache, openDisc,
         type Vfi, type VfiEntry } from "./vendor/extract/index.ts";

const META = "se_meta.json";

export type SeProgress = (done: number, total: number, name: string) => void;

export interface SeBankEntry {
    name: string;              /* pair stem, e.g. "gmecha" */
    hd: string;
    bd: string;
    bytes: number;
}

export interface SeCatalog { v: 1; entries: SeBankEntry[]; }
export interface SeBankFiles { hd: Uint8Array; bd: Uint8Array; }

export interface SeBytecodeEvent {
    tick: number;
    offset: number;
    exactFrame: number;
    consoleFrame: number;
    kind: "note" | "off" | "control" | "loop";
    key?: number;
    velocity?: number;
    program?: number;
    command?: number;
    args?: number[];
    source?: string;
    sampleLoop?: boolean;
    sampleFrames?: number;
    root?: number;
    cutGroup?: number;
    reverb?: boolean;
    noise?: boolean;
    adsr1?: number;
    adsr2?: number;
    envelopeFrames?: number;
    indefinite?: boolean;
}

export interface SeLoopInfo {
    startTick: number;
    endTick: number;
    cycleTicks: number;
    count: number;
    startExactFrame: number;
    endExactFrame: number;
    cycleExactFrames: number;
    startConsoleFrame: number;
    endConsoleFrame: number;
    cycleConsoleFrames: number;
}

export interface SeRequestInfo {
    durationTicks: number;
    exactFrames: number;
    consoleFrames: number;
    notes: number;
    controls: number;
    activeVoices: number;
    loopingVoices: number;
    sustainedVoices: number;
    sustained: boolean;
    sourceEndExactFrame: number;
    sourceEndConsoleFrame: number;
    loop: SeLoopInfo | null;
    events: SeBytecodeEvent[];
}

export interface SeInspection {
    requests: Uint16Array;
    details: (SeRequestInfo | null)[][];
    ticksPerSecond: number;
}

export interface SePlaybackMeasure {
    frames: number | null;
    sustained: boolean;
    estimated: boolean;
}

export interface SeMeasureFiles extends SeBankFiles {
    irx: Uint8Array | null;
    libsd: Uint8Array | null;
}

export class SeStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string | null;
    private byName = new Map<string, VfiEntry>();
    private catalog: SeCatalog | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null,
                cacheKey: string | null) {
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }

    async cached(): Promise<SeCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        const raw = await this.cache.read(META);
        if (!raw) return null;
        try {
            const catalog = JSON.parse(new TextDecoder().decode(raw)) as SeCatalog;
            if (catalog.v !== 1 || !Array.isArray(catalog.entries)) return null;
            this.catalog = catalog;
            return catalog;
        } catch {
            return null;
        }
    }

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
        const all = this.vfi.entries.filter((entry) =>
            /(^|\/)sound\/se\/[^/]+\.(hd|bd)$/.test(entry.path));
        const byDir = new Map<string, VfiEntry[]>();
        for (const entry of all) {
            const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
            (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(entry);
        }
        const best = [...byDir.values()]
            .sort((a, b) => b.length - a.length)[0] ?? [];
        for (const entry of best)
            this.byName.set(entry.path.slice(entry.path.lastIndexOf("/") + 1), entry);
        return this.byName;
    }

    private pairs(): SeBankEntry[] {
        const files = this.locate();
        const rows: SeBankEntry[] = [];
        for (const [hd, header] of files) {
            if (!hd.endsWith(".hd")) continue;
            const name = hd.slice(0, -3);
            const bd = `${name}.bd`;
            const body = files.get(bd);
            if (body) rows.push({ name, hd, bd, bytes: header.size + body.size });
        }
        return rows.sort((a, b) => a.name.localeCompare(b.name));
    }

    async extract(progress: SeProgress): Promise<SeCatalog> {
        if (!this.vfi)
            throw new Error("no ISO attached -- choose your disc image first");
        const rows = this.pairs();
        if (rows.length === 0)
            throw new Error("no sound/se bank pairs found in DATA.BIN");
        const files = rows.flatMap((row) => [row.hd, row.bd]);
        let cache = this.cache;
        for (let i = 0; i < files.length; i++) {
            const name = files[i]!;
            progress(i, files.length, name);
            if (!cache) continue;
            try {
                if (await cache.has(`se/${name}`)) continue;
            } catch (error) {
                console.warn("OPFS failed; SE banks from the ISO this visit", error);
                cache = null;
                continue;
            }
            const entry = this.locate().get(name)!;
            const data = await this.vfi.read(entry);
            try {
                await cache.write(`se/${name}`, data);
            } catch (error) {
                console.warn("OPFS write failed; SE banks from the ISO this visit", error);
                cache = null;
            }
        }
        const catalog: SeCatalog = { v: 1, entries: rows };
        if (cache)
            await cache.write(META,
                new TextEncoder().encode(JSON.stringify(catalog)));
        this.catalog = catalog;
        progress(files.length, files.length, "done");
        return catalog;
    }

    private async read(name: string): Promise<Uint8Array | null> {
        if (this.cache) {
            const data = await this.cache.read(`se/${name}`);
            if (data) return data;
        }
        const entry = this.locate().get(name);
        return entry && this.vfi ? this.vfi.read(entry) : null;
    }

    async bank(entry: SeBankEntry): Promise<SeBankFiles> {
        const [hd, bd] = await Promise.all([this.read(entry.hd), this.read(entry.bd)]);
        if (!hd || !bd)
            throw new Error(`missing SE bank ${entry.name} -- re-extract, or re-open the ISO`);
        return { hd, bd };
    }
}

export class SeInspector {
    private worker: Worker | null = null;
    private seq = 0;
    private pending = new Map<number, {
        resolve: (value: SeInspection) => void;
        reject: (error: Error) => void;
    }>();
    private measurePending = new Map<number, {
        resolve: (value: SePlaybackMeasure) => void;
        reject: (error: Error) => void;
    }>();

    private ensure(): Worker {
        if (this.worker) return this.worker;
        this.worker = new Worker(
            `${import.meta.env.BASE_URL}synth/export-worker.mjs`,
            { type: "module" });
        this.worker.onmessage = (event) => {
            const message = event.data;
            const pending = this.pending.get(message.id)
                ?? this.measurePending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            this.measurePending.delete(message.id);
            if (message.t === "error") pending.reject(new Error(message.message));
            else if (message.t === "se-measure-done")
                pending.resolve(message.measure);
            else
                pending.resolve(message.inspection);
        };
        this.worker.onerror = (event) => {
            const error = new Error(event.message || "SE inspector worker failed");
            for (const pending of this.pending.values()) pending.reject(error);
            for (const pending of this.measurePending.values()) pending.reject(error);
            this.pending.clear();
            this.measurePending.clear();
        };
        return this.worker;
    }

    inspect(files: SeBankFiles): Promise<SeInspection> {
        const id = ++this.seq;
        const { promise, resolve, reject } = Promise.withResolvers<SeInspection>();
        this.pending.set(id, { resolve, reject });
        this.ensure().postMessage({ t: "se-inspect", id, files },
                                  [files.hd.buffer, files.bd.buffer]);
        return promise;
    }

    measure(files: SeMeasureFiles, bank: number, request: number,
            exact: boolean, revDepth: number): Promise<SePlaybackMeasure> {
        const id = ++this.seq;
        const { promise, resolve, reject } =
            Promise.withResolvers<SePlaybackMeasure>();
        this.measurePending.set(id, { resolve, reject });
        const buffers = [files.hd, files.bd, files.irx, files.libsd]
            .filter((file) => file !== null)
            .map((file) => file.buffer);
        this.ensure().postMessage({
            t: "se-measure", id, files,
            opts: { bank, request, exact, revDepth },
        }, buffers);
        return promise;
    }
}
