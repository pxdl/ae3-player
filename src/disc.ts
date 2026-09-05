/* Disc session: ISO -> @ae3/extract openDisc() -> assets in OPFS.
 *
 * First visit: the user points at their .iso. The BGM asset set (~50 MB:
 * banks, sequences, the two IRX donors, and mastering data) plus available
 * viewer UI packages is cached CLIENT-SIDE in origin-private storage keyed
 * per disc; meta.json is written LAST as the initial-session completeness
 * marker. Later visits can resume BGM without the ISO. Uncached libraries
 * still require the same ISO to be reattached. "Forget my disc" wipes both
 * the cache and its pointer.
 *
 * Without OPFS (or if persistence fails) the session still works, reading
 * straight from the ISO File for this visit only. */

import { openDisc, BlobSource, OpfsCache,
         type BgmSong, type VfiEntry } from "./vendor/extract/index.ts";
import { StreamStore } from "./streams.ts";
import { SeStore } from "./se.ts";
import { MovieStore } from "./movies.ts";
import { ImageStore } from "./images.ts";
import { ModelStore } from "./models.ts";
import { StagePreviewStore } from "./stage-previews.ts";
import { DiscReportStore } from "./disc-report.ts";
import type { SongAssets } from "./player.ts";
import { technicalReason } from "./errors.ts";
import {
    contentFingerprintMatches,
    fingerprintBytes,
    isContentFingerprint,
    type ContentFingerprint,
} from "./content-identity.ts";

export const LAST_DISC_KEY = "ae3.lastDisc";
const META = "meta.json";
const EPHEMERAL_HISTORY_KEY = "ae3EphemeralDisc";

function resumeBlockedForThisHistoryEntry(): boolean {
    if (typeof history === "undefined") return false;
    const state = history.state;
    return state !== null && typeof state === "object"
        && Reflect.get(state, EPHEMERAL_HISTORY_KEY) === true;
}

function setResumeBlockedForThisHistoryEntry(blocked: boolean): void {
    if (typeof history === "undefined") {
        if (blocked) throw new Error("History API is unavailable");
        return;
    }
    const current = history.state;
    const next: Record<string, unknown> = {};
    if (current !== null && typeof current === "object")
        Object.assign(next, current);
    if (blocked)
        next[EPHEMERAL_HISTORY_KEY] = true;
    else
        Reflect.deleteProperty(next, EPHEMERAL_HISTORY_KEY);
    history.replaceState(next, "");
}


/** Original US retail regression serial. */
export const US_SERIAL = "SCUS_975.01";

export function discSupportWarning(serial: string | null): string {
    if (serial === US_SERIAL) return "";
    return serial
        ? ` - partially tested build (${serial}); untested paths may be off`
        : " - untested build (unknown serial); things may be off";
}

/** Human-readable, path-safe form of open/read failures for UI surfaces. */
export function friendlyError(e: unknown): string {
    if (e instanceof DOMException
        && (e.name === "NotReadableError" || e.name === "NotFoundError"))
        return "the ISO file could not be read -- if it is on a removable "
             + "drive or was moved, reconnect it and choose it again";
    const reason = technicalReason(e);
    if (/short read/.test(reason))
        return `${reason} -- the image ends too early; the ISO file looks `
             + "truncated or partially copied";
    if (/ in DATA\.BIN/.test(reason))
        return `${reason} -- the disc was read but its layout is not supported; `
             + "see the build-support matrix or report the disc serial";
    return reason;
}

interface CachedAssetIdentity extends ContentFingerprint {
    readonly name: string;
}

interface Meta {
    readonly v: 2;
    readonly sourceKey: string;
    readonly serial: string | null;
    readonly volumeId: string;
    readonly songs: readonly BgmSong[];
    readonly hasIrx: boolean;
    readonly hasLibsd: boolean;
    readonly assets: readonly CachedAssetIdentity[];
}

function isBgmSong(value: unknown): value is BgmSong {
    if (value === null || typeof value !== "object") return false;
    const song = value as Record<string, unknown>;
    return typeof song.name === "string" && song.name.length > 0
        && typeof song.mid === "string" && song.mid.length > 0
        && typeof song.hd === "string" && song.hd.length > 0
        && typeof song.bd === "string" && song.bd.length > 0
        && Number.isSafeInteger(song.songvol)
        && (song.songvol as number) >= 0 && (song.songvol as number) <= 127
        && typeof song.volumeScale === "number"
        && Number.isFinite(song.volumeScale) && song.volumeScale >= 0;
}

function isCachedAssetIdentity(value: unknown): value is CachedAssetIdentity {
    if (!isContentFingerprint(value)) return false;
    const asset = value as ContentFingerprint & Record<string, unknown>;
    return typeof asset.name === "string" && asset.name.length > 0;
}

function damagedMeta(cause?: unknown): Error {
    return new Error(
        "cached disc metadata is damaged -- choose the same ISO to rebuild it or clear this site's data",
        cause === undefined ? undefined : { cause },
    );
}

function parseMeta(raw: Uint8Array, expectedSourceKey: string): Meta | null {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder().decode(raw));
    } catch (cause) {
        throw damagedMeta(cause);
    }
    if (value === null || typeof value !== "object")
        throw damagedMeta();
    const meta = value as Record<string, unknown>;
    if (meta.v !== 2) return null;
    if (meta.sourceKey !== expectedSourceKey
            || !(meta.serial === null
                || (typeof meta.serial === "string" && meta.serial.length > 0))
            || typeof meta.volumeId !== "string"
            || !Array.isArray(meta.songs) || meta.songs.length === 0
            || !meta.songs.every(isBgmSong)
            || typeof meta.hasIrx !== "boolean"
            || typeof meta.hasLibsd !== "boolean"
            || !Array.isArray(meta.assets) || meta.assets.length === 0
            || !meta.assets.every(isCachedAssetIdentity))
        throw damagedMeta();
    const songNames = meta.songs.map(song => song.name);
    const assets = meta.assets as CachedAssetIdentity[];
    const assetNames = assets.map(asset => asset.name);
    if (new Set(songNames).size !== songNames.length
            || new Set(assetNames).size !== assetNames.length)
        throw damagedMeta();
    const available = new Set(assetNames);
    for (const song of meta.songs as BgmSong[]) {
        if (!available.has(`bgm/${song.hd}`)
                || !available.has(`bgm/${song.bd}`)
                || !available.has(`bgm/${song.mid}`))
            throw damagedMeta();
    }
    if (meta.hasIrx && !available.has("irx/sg2iopm1.irx"))
        throw damagedMeta();
    if (meta.hasLibsd && !available.has("irx/libsd.irx"))
        throw damagedMeta();
    return meta as unknown as Meta;
}

export interface DiscSession {
    songs: BgmSong[];
    serial: string | null;
    volumeId: string;
    cached: boolean;                       /* true = OPFS-backed, ISO-free */
    persistenceWarning: string | null;       /* non-null = usable, not resumable */
    streams: StreamStore;                  /* sound/stream phase (STREAMS tab) */
    se: SeStore;                            /* lazy sound/se phase (SE tab) */
    movies: MovieStore;                    /* lazy per-movie FMV phase */
    images: ImageStore;                    /* lazy TIM2 image/sprite phase */
    models: ModelStore;                        /* lazy I3D model/animation/collision phase */
    stagePreviews: StagePreviewStore;        /* lazy warpgate stage-preview phase */
    report: DiscReportStore;                 /* reusable build-qualification report */
    read(name: string): Promise<Uint8Array | null>;
    songAssets(song: BgmSong): Promise<SongAssets>;
    forget(): Promise<void>;
}

async function assetsFor(session: DiscSession, song: BgmSong,
                         hasIrx: boolean, hasLibsd: boolean): Promise<SongAssets> {
    const need = async (n: string) => {
        const b = await session.read(n);
        if (!b) throw new Error(`missing asset ${n} -- forget the disc and re-open the ISO`);
        return b;
    };
    return {
        hd: await need(`bgm/${song.hd}`),
        bd: await need(`bgm/${song.bd}`),
        mid: await need(`bgm/${song.mid}`),
        irx: hasIrx ? await session.read("irx/sg2iopm1.irx") : null,
        libsd: hasLibsd ? await session.read("irx/libsd.irx") : null,
    };
}

async function forgetSessionCache(cache: OpfsCache | null): Promise<void> {
    const failures: unknown[] = [];
    try {
        localStorage.removeItem(LAST_DISC_KEY);
    } catch (error) {
        failures.push(error);
    }
    try {
        await cache?.forget();
    } catch (error) {
        failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, "failed to forget the disc cache");
}

function persistenceFallback(error: unknown): string {
    return `browser persistence is unavailable (${technicalReason(error)}); `
        + "using the attached ISO for this session";
}

function cachedAssetIdentities(meta: Meta): Map<string, ContentFingerprint> {
    return new Map(meta.assets.map(asset => [asset.name, asset]));
}

async function readVerifiedCachedAsset(
    cache: OpfsCache,
    name: string,
    identities: ReadonlyMap<string, ContentFingerprint>,
    verified: Set<string>,
): Promise<Uint8Array | null> {
    const expected = identities.get(name);
    if (!expected) return null;
    const bytes = await cache.read(name);
    if (!bytes) return null;
    if (!verified.has(name)) {
        const actual = await fingerprintBytes(bytes);
        if (!contentFingerprintMatches(expected, actual))
            throw new Error("cached asset content does not match its metadata");
        verified.add(name);
    }
    return bytes;
}

/** Resume the previous disc from OPFS; null = nothing cached (show picker). */
export async function resumeSession(): Promise<DiscSession | null> {
    if (resumeBlockedForThisHistoryEntry()) return null;
    const last = localStorage.getItem(LAST_DISC_KEY);
    if (!last || !OpfsCache.supported()) return null;
    const cache = await OpfsCache.open(last);
    const metaRaw = await cache.read(META);
    if (!metaRaw) return null;
    const meta = parseMeta(metaRaw, last);
    if (!meta) return null;
    const identities = cachedAssetIdentities(meta);
    const verified = new Set<string>();
    const session: DiscSession = {
        songs: [...meta.songs],
        serial: meta.serial,
        volumeId: meta.volumeId,
        cached: true,
        persistenceWarning: null,
        streams: new StreamStore(cache, null, last),
        se: new SeStore(cache, null, last),
        movies: new MovieStore(cache, null, last),
        images: new ImageStore(cache, null, last),
        models: new ModelStore(cache, null, last),
        stagePreviews: new StagePreviewStore(cache, null, last),
        report: new DiscReportStore(
            cache, null, last, meta.serial, meta.volumeId),
        read: (name) =>
            readVerifiedCachedAsset(cache, name, identities, verified),
        songAssets: (song) =>
            assetsFor(session, song, meta.hasIrx, meta.hasLibsd),
        forget: () => forgetSessionCache(cache),
    };
    return session;
}

export type Progress = (done: number, total: number, name: string) => void;

/** Open an ISO and extract the BGM asset set into OPFS (with progress).
 *  OPFS setup or write failures fall back to the ISO for this session; ISO read
 *  and format failures abort the open. */
export async function openIso(file: File, progress: Progress,
                              signal?: AbortSignal): Promise<DiscSession> {
    const disc = await openDisc(new BlobSource(file));
    signal?.throwIfAborted();
    let persistenceWarning: string | null = null;
    let persistenceAvailable = true;
    try {
        localStorage.removeItem(LAST_DISC_KEY);
    } catch (error) {
        signal?.throwIfAborted();
        try {
            setResumeBlockedForThisHistoryEntry(true);
        } catch (historyError) {
            throw new AggregateError(
                [error, historyError],
                "browser storage could not safely invalidate the previous disc session",
            );
        }
        persistenceWarning = persistenceFallback(error);
        persistenceAvailable = false;
        console.warn("Disc resume pointer clear failed; playing from the ISO", error);
    }
    if (persistenceAvailable) {
        try {
            setResumeBlockedForThisHistoryEntry(false);
        } catch (error) {
            signal?.throwIfAborted();
            persistenceWarning = persistenceFallback(error);
            persistenceAvailable = false;
            console.warn("Disc resume state clear failed; playing from the ISO", error);
        }
    }
    const cacheName = (e: VfiEntry) => `bgm/${e.path.slice(e.path.lastIndexOf("/") + 1)}`;
    const jobs: Array<[string, VfiEntry]> = [
        ...disc.assets.hd.map((e): [string, VfiEntry] => [cacheName(e), e]),
        ...disc.assets.bd.map((e): [string, VfiEntry] => [cacheName(e), e]),
        ...disc.assets.mid.map((e): [string, VfiEntry] => [cacheName(e), e]),
    ];
    if (disc.assets.sg2iopm1) jobs.push(["irx/sg2iopm1.irx", disc.assets.sg2iopm1]);
    if (disc.assets.libsd) jobs.push(["irx/libsd.irx", disc.assets.libsd]);

    /* Cache optional UI packages verbatim from the user's disc so the viewer
     * can decode selected TIM2 members at runtime without shipping game data.
     * A missing optional package is skipped. */
    const viewerPackages: ReadonlyArray<[string, string]> = [
        ["viewer/ci_studio.pck.sz", "/cinema/ci_studio/ui.pck.sz"],
        ["viewer/ui_title.pck.sz", "/etc/title/ui_title.pck.sz"],
        ["viewer/ui_phone.pck.sz", "/etc/phone/ui_phone.pck.sz"],
    ];
    for (const [name, suffix] of viewerPackages) {
        const entry = disc.vfi.entries.find((candidate) =>
            candidate.path.endsWith(suffix));
        if (entry) jobs.push([name, entry]);
    }


    /* Cache (OPFS) failures are soft -- the session falls back to reading the
     * ISO File directly. ISO read failures are hard. meta.json lands last, and
     * a cached payload is reusable only when its stored content fingerprint
     * matches the attached source. */
    let cache: OpfsCache | null = null;
    let ownedCache: OpfsCache | null = null;
    let previousMeta: Meta | null = null;
    const verifiedCacheAssets = new Set<string>();
    const assetIdentities: CachedAssetIdentity[] = [];
    if (persistenceAvailable && OpfsCache.supported()) {
        try {
            cache = await OpfsCache.open(disc.cacheKey);
            ownedCache = cache;
            const raw = await cache.read(META);
            if (raw) {
                try {
                    previousMeta = parseMeta(raw, disc.cacheKey);
                } catch (error) {
                    /* An interrupted first write can leave an empty file.
                     * Rebuild corrupt metadata, not a permanently cache-free session. */
                    console.warn("Cached disc metadata is damaged; rebuilding it from the ISO", error);
                    await cache.remove(META);
                }
            }
            signal?.throwIfAborted();
        } catch (error) {
            signal?.throwIfAborted();
            persistenceWarning = persistenceFallback(error);
            console.warn("OPFS unavailable; playing from the ISO", error);
            cache = null;
        }
    }
    const previousAssets = previousMeta
        ? cachedAssetIdentities(previousMeta)
        : new Map<string, ContentFingerprint>();
    for (let index = 0; index < jobs.length && cache; index++) {
        signal?.throwIfAborted();
        const [name, entry] = jobs[index]!;
        progress(index, jobs.length, name);
        const data = await disc.vfi.read(entry);        /* hard failure */
        signal?.throwIfAborted();
        try {
            const current = await fingerprintBytes(data);
            signal?.throwIfAborted();
            assetIdentities.push({ name, ...current });
            const previous = previousAssets.get(name);
            const stored = previous !== undefined
                    && contentFingerprintMatches(previous, current)
                ? await cache.read(name) : null;
            const reusable = stored !== null && stored.byteLength === data.byteLength
                && contentFingerprintMatches(current, await fingerprintBytes(stored));
            signal?.throwIfAborted();
            if (!reusable) {
                await cache.write(name, data);
                signal?.throwIfAborted();
            }
            verifiedCacheAssets.add(name);
        } catch (error) {
            signal?.throwIfAborted();
            persistenceWarning = persistenceFallback(error);
            console.warn("OPFS asset validation failed; playing from the ISO", error);
            cache = null;
        }
    }
    const meta: Meta = {
        v: 2,
        sourceKey: disc.cacheKey,
        serial: disc.serial,
        volumeId: disc.volumeId,
        songs: disc.songs,
        hasIrx: disc.assets.sg2iopm1 !== null,
        hasLibsd: disc.assets.libsd !== null,
        assets: assetIdentities,
    };
    if (cache) {
        try {
            await cache.write(META,
                new TextEncoder().encode(JSON.stringify(meta)));
            signal?.throwIfAborted();
        } catch (error) {
            signal?.throwIfAborted();
            persistenceWarning = persistenceFallback(error);
            console.warn("OPFS metadata write failed; playing from the ISO", error);
            cache = null;
        }
    }
    if (cache) {
        try {
            signal?.throwIfAborted();
            localStorage.setItem(LAST_DISC_KEY, disc.cacheKey);
        } catch (error) {
            signal?.throwIfAborted();
            persistenceWarning = persistenceFallback(error);
            console.warn("Disc resume pointer write failed; playing from the ISO", error);
            cache = null;
        }
    }
    signal?.throwIfAborted();
    progress(jobs.length, jobs.length, "done");

    const byName = new Map(jobs.map(([n, e]) => [n, e]));
    const currentAssetIdentities = cachedAssetIdentities(meta);
    const session: DiscSession = {
        songs: disc.songs,
        serial: disc.serial,
        volumeId: disc.volumeId,
        cached: cache !== null,
        persistenceWarning,
        streams: new StreamStore(cache, disc.vfi, disc.cacheKey),
        se: new SeStore(cache, disc.vfi, disc.cacheKey),
        movies: new MovieStore(cache, disc.vfi, disc.cacheKey),
        images: new ImageStore(cache, disc.vfi, disc.cacheKey),
        models: new ModelStore(cache, disc.vfi, disc.cacheKey),
        stagePreviews: new StagePreviewStore(cache, disc.vfi, disc.cacheKey),
        report: new DiscReportStore(
            cache, disc.vfi, disc.cacheKey, disc.serial, disc.volumeId),
        read: async (name) => {
            if (cache) {
                try {
                    const bytes = await readVerifiedCachedAsset(
                        cache, name, currentAssetIdentities, verifiedCacheAssets);
                    if (bytes) return bytes;
                } catch (error) {
                    console.warn("OPFS asset validation failed; using the attached ISO", error);
                    cache = null;
                    session.cached = false;
                    session.persistenceWarning = persistenceFallback(error);
                }
            }
            const entry = byName.get(name);
            return entry ? disc.vfi.read(entry) : null;
        },
        songAssets: (song) =>
            assetsFor(session, song, meta.hasIrx, meta.hasLibsd),
        forget: () => forgetSessionCache(ownedCache),
    };
    return session;
}
