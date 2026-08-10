/* Embedded-SE tab backbone: lazy sound/se extraction, bank catalog, and
 * worker-side table inspection through the public ae3_synth_se_* API.
 * Disc data is cached in OPFS when available; otherwise the attached ISO
 * remains the source for this session. */

import { BlobSource, OpfsCache, openDisc,
         type Vfi, type VfiEntry } from "./vendor/extract/index.ts";
import {
    assertAttachedDiscIdentity,
    assertCacheSourceIdentity,
} from "./disc-identity.ts";
import { technicalReason } from "./errors.ts";
import {
    contentFingerprintMatches,
    fingerprintBytes,
    isContentFingerprint,
    type ContentFingerprint,
} from "./content-identity.ts";
import { assertZipEntryPath } from "./zip.ts";

const META = "se_meta.json";

export type SeProgress = (done: number, total: number, name: string) => void;

export interface SeBankEntry {
    readonly name: string;
    readonly hd: string;
    readonly bd: string;
    readonly bytes: number;
    readonly hdFingerprint: ContentFingerprint;
    readonly bdFingerprint: ContentFingerprint;
}
export interface SeCatalog {
    readonly v: 2;
    readonly sourceKey: string;
    readonly entries: readonly SeBankEntry[];
}
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


function isZipEntryName(value: string): boolean {
    try {
        assertZipEntryPath(value);
        return true;
    } catch {
        return false;
    }
}

function isSeCatalog(value: unknown, expectedSourceKey: string): value is SeCatalog {
    if (value === null || typeof value !== "object") return false;
    const catalog = value as Record<string, unknown>;
    if (catalog.v !== 2 || catalog.sourceKey !== expectedSourceKey
            || !Array.isArray(catalog.entries)
            || catalog.entries.length === 0)
        return false;
    const names = new Set<string>();
    for (const value of catalog.entries) {
        if (value === null || typeof value !== "object") return false;
        const entry = value as Record<string, unknown>;
        if (typeof entry.name !== "string" || entry.name.length === 0
                || names.has(entry.name)
                || entry.hd !== `${entry.name}.hd`
                || entry.bd !== `${entry.name}.bd`
                || !isZipEntryName(entry.hd as string)
                || !isZipEntryName(entry.bd as string)
                || !Number.isSafeInteger(entry.bytes)
                || (entry.bytes as number) <= 0
                || !isContentFingerprint(entry.hdFingerprint)
                || !isContentFingerprint(entry.bdFingerprint)
                || entry.bytes !== entry.hdFingerprint.bytes
                    + entry.bdFingerprint.bytes)
            return false;
        names.add(entry.name);
    }
    return true;
}
export class SeStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string;
    private byName = new Map<string, VfiEntry>();
    private catalog: SeCatalog | null = null;
    private cacheWarning: string | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null,
                cacheKey: string) {
        assertCacheSourceIdentity(cache, cacheKey);
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }
    get persistenceWarning(): string | null { return this.cacheWarning; }

    async cached(): Promise<SeCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        let raw: Uint8Array | null;
        try {
            raw = await this.cache.read(META);
        } catch (error) {
            this.useIsoAfterCacheFailure(
                error,
                "the Effects cache is unavailable -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch (error) {
            this.useIsoAfterCacheFailure(
                error,
                "the cached Effects index is damaged -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        if (!isSeCatalog(parsed, this.cacheKey)) {
            this.useIsoAfterCacheFailure(
                new Error("the cached Effects index has an invalid schema"),
                "the cached Effects index is damaged -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        this.catalog = parsed;
        return parsed;
    }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        assertAttachedDiscIdentity(this.cacheKey, disc.cacheKey);
        this.vfi = disc.vfi;
        this.byName.clear();
    }

    private useIsoAfterCacheFailure(error: unknown, message: string): void {
        if (!this.vfi)
            throw new Error(message, { cause: error });
        this.cacheWarning = `${message} (${technicalReason(error)}); `
            + "using the attached ISO for this session";
        console.warn(`${message}; using the attached ISO`, error);
        this.cache = null;
    }

    private locate(): Map<string, VfiEntry> {
        if (this.byName.size || !this.vfi) return this.byName;
        const all = this.vfi.entries.filter((entry) =>
            /(^|\/)sound\/se\/[^/]+\.(hd|bd)$/.test(entry.path));
        const byDir = new Map<string, VfiEntry[]>();
        for (const entry of all) {
            const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
            let entries = byDir.get(dir);
            if (!entries) {
                entries = [];
                byDir.set(dir, entries);
            }
            entries.push(entry);
        }
        let best: VfiEntry[] = [];
        for (const entries of byDir.values()) {
            if (entries.length > best.length) best = entries;
        }
        for (const entry of best)
            this.byName.set(entry.path.slice(entry.path.lastIndexOf("/") + 1), entry);
        return this.byName;
    }

    private pairs(): Array<{
        name: string;
        hd: string;
        bd: string;
        bytes: number;
    }> {
        const files = this.locate();
        const rows: Array<{ name: string; hd: string; bd: string; bytes: number }> = [];
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
        const pairs = this.pairs();
        if (pairs.length === 0)
            throw new Error("no sound/se bank pairs found in DATA.BIN");
        const total = pairs.length * 2;
        const entries: SeBankEntry[] = [];
        let done = 0;
        let cache = this.cache;
        for (const pair of pairs) {
            const fingerprints: ContentFingerprint[] = [];
            for (const name of [pair.hd, pair.bd]) {
                progress(done++, total, name);
                const source = this.locate().get(name);
                if (!source) throw new Error("an Effects bank source disappeared");
                const data = await this.vfi.read(source);
                fingerprints.push(await fingerprintBytes(data));
                if (!cache) continue;
                try {
                    await cache.write(`se/${name}`, data);
                } catch (error) {
                    this.useIsoAfterCacheFailure(
                        error,
                        "cached Effects storage is unavailable",
                    );
                    cache = null;
                }
            }
            entries.push({
                ...pair,
                hdFingerprint: fingerprints[0]!,
                bdFingerprint: fingerprints[1]!,
            });
        }
        const catalog: SeCatalog = {
            v: 2,
            sourceKey: this.cacheKey,
            entries,
        };
        if (cache) {
            try {
                await cache.write(META,
                    new TextEncoder().encode(JSON.stringify(catalog)));
            } catch (error) {
                this.useIsoAfterCacheFailure(
                    error,
                    "cached Effects storage is unavailable",
                );
            }
        }
        this.catalog = catalog;
        progress(total, total, "done");
        return catalog;
    }

    private contentMismatch(message: string): never {
        this.cache = null;
        this.catalog = null;
        throw new Error(message);
    }

    private async read(name: string,
                       expected: ContentFingerprint): Promise<Uint8Array | null> {
        if (this.vfi) {
            const entry = this.locate().get(name);
            if (!entry) return null;
            const data = await this.vfi.read(entry);
            const actual = await fingerprintBytes(data);
            if (!contentFingerprintMatches(expected, actual))
                this.contentMismatch(
                    "the cached Effects index does not match the attached disc content "
                    + "-- re-extract or forget the disc cache",
                );
            return data;
        }
        if (!this.cache) return null;
        let data: Uint8Array | null;
        try {
            data = await this.cache.read(`se/${name}`);
        } catch (error) {
            throw new Error(
                "cached Effects data is unavailable -- reconnect the same disc or forget the disc cache",
                { cause: error },
            );
        }
        if (!data) return null;
        const actual = await fingerprintBytes(data);
        if (!contentFingerprintMatches(expected, actual))
            this.contentMismatch(
                "cached Effects data is damaged -- reconnect the same disc or forget the disc cache",
            );
        return data;
    }

    async bank(entry: SeBankEntry): Promise<SeBankFiles> {
        const [hd, bd] = await Promise.all([
            this.read(entry.hd, entry.hdFingerprint),
            this.read(entry.bd, entry.bdFingerprint),
        ]);
        if (!hd || !bd)
            throw new Error("an Effects bank source is missing -- re-extract or re-open the ISO");
        return { hd, bd };
    }
}

function asError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : null;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isByte(value: unknown): value is number {
    return isSafeNonnegativeInteger(value) && value <= 0xff;
}

function hasOnlyKeys(value: Record<string, unknown>,
                     allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every(key => allowed.has(key));
}

const LOOP_KEYS = new Set([
    "startTick", "endTick", "cycleTicks", "count",
    "startExactFrame", "endExactFrame", "cycleExactFrames",
    "startConsoleFrame", "endConsoleFrame", "cycleConsoleFrames",
]);

function isSeLoopInfo(value: unknown): value is SeLoopInfo {
    const loop = record(value);
    if (!loop || !hasOnlyKeys(loop, LOOP_KEYS))
        return false;
    for (const key of LOOP_KEYS) {
        if (!isSafeNonnegativeInteger(loop[key])) return false;
    }
    if (!isByte(loop.count)) return false;
    const checked = loop as unknown as SeLoopInfo;
    return checked.startTick <= checked.endTick
        && checked.cycleTicks === checked.endTick - checked.startTick
        && checked.startExactFrame <= checked.endExactFrame
        && checked.cycleExactFrames
            === checked.endExactFrame - checked.startExactFrame
        && checked.startConsoleFrame <= checked.endConsoleFrame
        && checked.cycleConsoleFrames
            === checked.endConsoleFrame - checked.startConsoleFrame;
}

const EVENT_COMMON_KEYS = [
    "tick", "offset", "exactFrame", "consoleFrame", "kind",
] as const;
const EVENT_NOTE_KEYS = ["key", "velocity", "program"] as const;
const EVENT_CONTROL_KEYS = ["command", "args"] as const;
const EVENT_TONE_KEYS = [
    "source", "sampleLoop", "sampleFrames", "root", "cutGroup", "reverb",
    "noise", "adsr1", "adsr2", "envelopeFrames", "indefinite",
] as const;
const BASIC_NOTE_EVENT_KEYS = new Set([
    ...EVENT_COMMON_KEYS, ...EVENT_NOTE_KEYS,
]);
const NOTE_EVENT_KEYS = new Set([
    ...BASIC_NOTE_EVENT_KEYS, ...EVENT_TONE_KEYS,
]);
const CONTROL_EVENT_KEYS = new Set([
    ...EVENT_COMMON_KEYS, ...EVENT_CONTROL_KEYS,
]);

function hasToneMetadata(event: Record<string, unknown>): boolean {
    return EVENT_TONE_KEYS.some(key => event[key] !== undefined);
}

function isToneMetadata(event: Record<string, unknown>): boolean {
    if (typeof event.source !== "string"
            || event.source.length === 0 || event.source.length > 128
            || /[^\x20-\x7e]/.test(event.source)
            || typeof event.sampleLoop !== "boolean"
            || !isSafeNonnegativeInteger(event.sampleFrames)
            || !isByte(event.root)
            || !isByte(event.cutGroup)
            || typeof event.reverb !== "boolean"
            || typeof event.noise !== "boolean"
            || !isSafeNonnegativeInteger(event.adsr1) || event.adsr1 > 0xffff
            || !isSafeNonnegativeInteger(event.adsr2) || event.adsr2 > 0xffff
            || typeof event.indefinite !== "boolean")
        return false;
    return event.indefinite
        ? event.envelopeFrames === undefined
        : isSafeNonnegativeInteger(event.envelopeFrames);
}

function isSeBytecodeEvent(
    value: unknown,
    info: Pick<SeRequestInfo, "durationTicks" | "exactFrames" | "consoleFrames">,
): value is SeBytecodeEvent {
    const event = record(value);
    if (!event
            || !isSafeNonnegativeInteger(event.tick)
            || !isSafeNonnegativeInteger(event.offset)
            || !isSafeNonnegativeInteger(event.exactFrame)
            || !isSafeNonnegativeInteger(event.consoleFrame)
            || event.tick > info.durationTicks
            || event.exactFrame > info.exactFrames
            || event.consoleFrame > info.consoleFrames)
        return false;

    if (event.kind === "note" || event.kind === "off") {
        const tone = hasToneMetadata(event);
        if (!hasOnlyKeys(event, tone ? NOTE_EVENT_KEYS : BASIC_NOTE_EVENT_KEYS)
                || !isByte(event.key)
                || !isByte(event.velocity)
                || !isByte(event.program))
            return false;
        if (event.kind === "off") return !tone && event.velocity === 0;
        return !tone || isToneMetadata(event);
    }
    if (event.kind !== "control" && event.kind !== "loop") return false;
    if (!hasOnlyKeys(event, CONTROL_EVENT_KEYS)
            || !isByte(event.command)
            || !Array.isArray(event.args)
            || !event.args.every(isByte))
        return false;
    const expectedArgs = event.command === 7
        || event.command === 10
        || event.command === 0x41 ? 4 : 3;
    return event.args.length === expectedArgs
        && (event.kind === "loop"
            ? event.command === 0x60
            : event.command !== 0x60);
}

const REQUEST_KEYS = new Set([
    "durationTicks", "exactFrames", "consoleFrames", "notes", "controls",
    "activeVoices", "loopingVoices", "sustainedVoices", "sustained",
    "sourceEndExactFrame", "sourceEndConsoleFrame", "loop", "events",
]);
const REQUEST_NUMBER_KEYS = [
    "durationTicks", "exactFrames", "consoleFrames", "notes", "controls",
    "activeVoices", "loopingVoices", "sustainedVoices",
    "sourceEndExactFrame", "sourceEndConsoleFrame",
] as const;


function isSeRequestInfo(value: unknown): value is SeRequestInfo {
    const info = record(value);
    if (!info || !hasOnlyKeys(info, REQUEST_KEYS)
            || REQUEST_NUMBER_KEYS.some(key =>
                !isSafeNonnegativeInteger(info[key]))
            || typeof info.sustained !== "boolean"
            || !Array.isArray(info.events))
        return false;
    const checked = info as unknown as SeRequestInfo;
    if (!(checked.loop === null || isSeLoopInfo(checked.loop))
            || !checked.events.every(event =>
                isSeBytecodeEvent(event, checked)))
        return false;
    const notes = checked.events.filter(event =>
        event.kind === "note" || event.kind === "off").length;
    const controls = checked.events.length - notes;
    return checked.notes === notes
        && checked.controls === controls
        && checked.loopingVoices <= checked.activeVoices
        && checked.sustainedVoices <= checked.loopingVoices
        && checked.sustained === (checked.sustainedVoices > 0)
        && checked.sourceEndExactFrame >= checked.exactFrames
        && checked.sourceEndConsoleFrame >= checked.consoleFrames;
}

function isSeInspection(value: unknown): value is SeInspection {
    const inspection = record(value);
    if (!inspection
            || !(inspection.requests instanceof Uint16Array)
            || !Array.isArray(inspection.details)
            || inspection.details.length !== inspection.requests.length
            || !isSafeNonnegativeInteger(inspection.ticksPerSecond)
            || inspection.ticksPerSecond === 0)
        return false;
    const checked = inspection as unknown as SeInspection;
    return checked.details.every((details, bank) =>
        Array.isArray(details)
        && details.length === checked.requests[bank]
        && details.every(detail => detail === null || isSeRequestInfo(detail)));
}

const MEASURE_KEYS = new Set(["frames", "sustained", "estimated"]);

function isSePlaybackMeasure(value: unknown): value is SePlaybackMeasure {
    const measure = record(value);
    return measure !== null
        && hasOnlyKeys(measure, MEASURE_KEYS)
        && (measure.frames === null
            || isSafeNonnegativeInteger(measure.frames))
        && typeof measure.sustained === "boolean"
        && typeof measure.estimated === "boolean";
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

    private failWorker(worker: Worker, error: Error): void {
        if (this.worker !== worker) return;
        this.worker = null;
        worker.terminate();
        for (const pending of this.pending.values()) pending.reject(error);
        for (const pending of this.measurePending.values()) pending.reject(error);
        this.pending.clear();
        this.measurePending.clear();
    }

    private ensure(): Worker {
        if (this.worker) return this.worker;
        const baseUrl = import.meta.env?.BASE_URL ?? "/";
        const worker = new Worker(`${baseUrl}synth/export-worker.mjs`,
                                  { type: "module" });
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<unknown>) => {
            try {
                const message = record(event.data);
                if (!message || !isSafeNonnegativeInteger(message.id)
                        || message.id === 0) {
                    this.failWorker(worker, new Error("invalid SE worker response"));
                    return;
                }
                const id = message.id;
                const pending = this.pending.get(id);
                const measurePending = this.measurePending.get(id);
                if (!pending && !measurePending) {
                    this.failWorker(worker, new Error("invalid SE worker response"));
                    return;
                }
                if (message.t === "error"
                        && hasOnlyKeys(message, new Set(["t", "id", "message"]))
                        && typeof message.message === "string"
                        && message.message.length > 0) {
                    const error = new Error(technicalReason(message.message));
                    pending?.reject(error);
                    measurePending?.reject(error);
                } else if (message.t === "se-inspect-done"
                        && hasOnlyKeys(message, new Set(["t", "id", "inspection"]))
                        && pending && isSeInspection(message.inspection)) {
                    pending.resolve(message.inspection);
                } else if (message.t === "se-measure-done"
                        && hasOnlyKeys(message, new Set(["t", "id", "measure"]))
                        && measurePending && isSePlaybackMeasure(message.measure)) {
                    measurePending.resolve(message.measure);
                } else {
                    this.failWorker(worker, new Error("invalid SE worker response"));
                    return;
                }
                this.pending.delete(id);
                this.measurePending.delete(id);
            } catch {
                this.failWorker(worker, new Error("invalid SE worker response"));
            }
        };
        worker.onerror = (event) => {
            event.preventDefault();
            this.failWorker(
                worker,
                new Error(technicalReason(event.message || "SE inspector worker failed")),
            );
        };
        worker.onmessageerror = () => {
            this.failWorker(worker, new Error("invalid SE worker response"));
        };
        return worker;
    }

    dispose(): void {
        const error = new Error("SE operation cancelled for another disc");
        if (this.worker) {
            this.failWorker(this.worker, error);
            return;
        }
        for (const pending of this.pending.values()) pending.reject(error);
        for (const pending of this.measurePending.values()) pending.reject(error);
        this.pending.clear();
        this.measurePending.clear();
    }

    inspect(files: SeBankFiles): Promise<SeInspection> {
        const id = ++this.seq;
        const { promise, resolve, reject } = Promise.withResolvers<SeInspection>();
        this.pending.set(id, { resolve, reject });
        try {
            this.ensure().postMessage({ t: "se-inspect", id, files },
                                      [files.hd.buffer, files.bd.buffer]);
        } catch (cause) {
            this.pending.delete(id);
            reject(asError(cause));
        }
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
        try {
            this.ensure().postMessage({
                t: "se-measure", id, files,
                opts: { bank, request, exact, revDepth },
            }, buffers);
        } catch (cause) {
            this.measurePending.delete(id);
            reject(asError(cause));
        }
        return promise;
    }
}
