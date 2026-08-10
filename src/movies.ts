import {
    BlobSource, OpfsCache, openDisc, locateFmvAssets, inspectFmvPrefix, demuxFmv,
    indexMpeg2SeekPoints, parseFmvSubtitles, subtitlesToSrt, subtitlesToVtt,
    type FmvAsset, type FmvDemux, type FmvHeader, type FmvVideoInfo,
    type Mpeg2SeekIndex, type SubtitleCue, type Vfi, type VfiEntry,
} from "./vendor/extract/index.ts";
import { assertZipEntryPath, storeZip } from "./zip.ts";
import {
    assertAttachedDiscIdentity,
    assertCacheSourceIdentity,
} from "./disc-identity.ts";
import { technicalReason } from "./errors.ts";
import { FmvFormatError, type FmvDiscovery } from "./vendor/extract/fmv.ts";
import {
    contentFingerprintMatches,
    fingerprintBytes,
    isContentFingerprint,
    type ContentFingerprint,
} from "./content-identity.ts";

const META = "movie_meta.json";
const CACHE_VERSION = "v1-ffmpeg-0.12.10-mediabunny-1.50.9";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MOVIE_LABELS: Readonly<Record<string, string>> = {
    new_advertise: "Advertisement",
    new_dolby_pl2: "Dolby Pro Logic II",
    new_million: "Million Monkeys",
    new_rc4: "RC4",
};
const LEGACY_OUTPUT_FORMATS = ["mkv", "mp4", "webm"] as const;

export type MovieGroup = "opening" | "story" | "gameplay";

export interface MovieSourceFileIdentity extends ContentFingerprint {
    readonly name: string;
}

export interface MovieEntry {
    readonly name: string;
    readonly label: string;
    readonly group: MovieGroup;
    readonly movie: VfiEntry;
    readonly subtitleBin: VfiEntry | null;
    readonly subtitleSbt: VfiEntry | null;
    readonly sourceBytes: number;
    readonly subtitleBytes: number;
    readonly subtitleCues: number;
    readonly subtitleEnd: number | null;
    readonly header: FmvHeader;
    readonly video: FmvVideoInfo;
    readonly duration: number;
    readonly sourceFingerprints: readonly MovieSourceFileIdentity[];
}

export interface MovieCatalogIssue {
    readonly name: string;
    readonly label: string;
    readonly group: MovieGroup;
    readonly sourceBytes: number;
    readonly reason: string;
}

export interface MovieCatalog {
    readonly v: 3;
    readonly sourceKey: string;
    readonly entries: readonly MovieEntry[];
    readonly issues: readonly MovieCatalogIssue[];
}

export interface MovieCacheInfo {
    sourceBytes: number;
    exportBytes: number;
    totalBytes: number;
}

interface SubtitleBundle {
    bin: Uint8Array | null;
    sbt: Uint8Array | null;
    cues: readonly SubtitleCue[];
}

const EMPTY_SUBTITLES: SubtitleBundle = {
    bin: null,
    sbt: null,
    cues: [],
};

export type MovieExportKind = "original" | "masters" | "mkv" | "mp4";

export interface MovieExport {
    filename: string;
    bytes: Uint8Array;
    mime: string;
}

export interface MoviePlaybackSource {
    name: string;
    video: Uint8Array;
    wav: Uint8Array;
    cues: readonly SubtitleCue[];
    videoInfo: FmvVideoInfo;
    seekIndex: Mpeg2SeekIndex;
    duration: number;
    cache: MovieCacheInfo;
}

export type MovieProgress = (progress: number, stage: string) => void;

function title(name: string): string {
    const scene = /^new_scene(\d\d)$/i.exec(name);
    if (scene) return `Scene ${scene[1]}`;
    const play = /^new_play(\d\d)$/i.exec(name);
    if (play) return `Gameplay ${play[1]}`;
    return MOVIE_LABELS[name.toLowerCase()]
        ?? name.replace(/^new_/, "").replaceAll("_", " ");
}

function group(name: string): MovieGroup {
    if (/^new_scene/i.test(name)) return "story";
    if (/^new_(play|rc4)/i.test(name)) return "gameplay";
    return "opening";
}

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : null;
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value)
        && value >= minimum;
}

function isPositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isZipEntryName(value: string): boolean {
    try {
        assertZipEntryPath(value);
        return true;
    } catch {
        return false;
    }
}

function isVfiEntry(value: unknown): value is VfiEntry {
    const entry = objectValue(value);
    return entry !== null
        && typeof entry.name === "string" && entry.name.length > 0
        && typeof entry.path === "string" && entry.path.length > 0
        && isSafeInteger(entry.entryOff)
        && isSafeInteger(entry.entrySize)
        && isSafeInteger(entry.parentOff)
        && isSafeInteger(entry.sector)
        && isSafeInteger(entry.size, 1);
}

function isFmvHeader(value: unknown): value is FmvHeader {
    const header = objectValue(value);
    return header !== null
        && isSafeInteger(header.fields, 1)
        && isPositiveNumber(header.fieldRate)
        && isSafeInteger(header.groups, 1)
        && isSafeInteger(header.sampleRate, 1)
        && isSafeInteger(header.channels, 1)
        && isSafeInteger(header.interleave, 1)
        && isSafeInteger(header.audioBlock, 1)
        && isSafeInteger(header.preload, 1)
        && isSafeInteger(header.audioBytes, 1);
}

function isPositivePair(value: unknown): value is readonly [number, number] {
    return Array.isArray(value) && value.length === 2
        && isPositiveNumber(value[0]) && isPositiveNumber(value[1]);
}

function isFmvVideoInfo(value: unknown): value is FmvVideoInfo {
    const video = objectValue(value);
    return video !== null
        && isSafeInteger(video.width, 1)
        && isSafeInteger(video.height, 1)
        && isPositiveNumber(video.frameRate)
        && (video.fieldOrder === "progressive"
            || video.fieldOrder === "tt"
            || video.fieldOrder === "bb")
        && isPositivePair(video.sampleAspect)
        && isPositivePair(video.displayAspect);
}

function isMovieSourceFingerprints(value: unknown,
                                   movie: VfiEntry,
                                   subtitleBin: VfiEntry | null,
                                   subtitleSbt: VfiEntry | null):
        value is readonly MovieSourceFileIdentity[] {
    if (!Array.isArray(value)) return false;
    const expected = new Map<string, number>([
        [movie.name, movie.size],
        ...(subtitleBin ? [[subtitleBin.name, subtitleBin.size] as const] : []),
        ...(subtitleSbt ? [[subtitleSbt.name, subtitleSbt.size] as const] : []),
    ]);
    if (value.length !== expected.size) return false;
    const names = new Set<string>();
    for (const item of value) {
        const candidate = objectValue(item);
        if (!candidate
                || typeof candidate.name !== "string"
                || !isZipEntryName(candidate.name)
                || names.has(candidate.name)
                || !isContentFingerprint(candidate)
                || candidate.bytes !== expected.get(candidate.name))
            return false;
        names.add(candidate.name);
    }
    return names.size === expected.size;
}

function isMovieEntry(value: unknown): value is MovieEntry {
    const entry = objectValue(value);
    if (entry === null || typeof entry.name !== "string" || entry.name.length === 0
            || !isZipEntryName(`${entry.name}.m2v`)
            || typeof entry.label !== "string" || entry.label.length === 0
            || !["opening", "story", "gameplay"].includes(entry.group as string)
            || !isVfiEntry(entry.movie)
            || !isZipEntryName(entry.movie.name)
            || !isSafeInteger(entry.sourceBytes, 1)
            || entry.sourceBytes !== entry.movie.size
            || !isSafeInteger(entry.subtitleBytes)
            || !isSafeInteger(entry.subtitleCues)
            || !(entry.subtitleEnd === null
                || (typeof entry.subtitleEnd === "number"
                    && Number.isFinite(entry.subtitleEnd) && entry.subtitleEnd >= 0))
            || !isFmvHeader(entry.header)
            || !isFmvVideoInfo(entry.video)
            || !isPositiveNumber(entry.duration))
        return false;
    if (entry.subtitleBin === null && entry.subtitleSbt === null) {
        return entry.subtitleBytes === 0
            && isMovieSourceFingerprints(
                entry.sourceFingerprints,
                entry.movie,
                null,
                null,
            );
    }
    if (!isVfiEntry(entry.subtitleBin) || !isVfiEntry(entry.subtitleSbt)
            || !isZipEntryName(entry.subtitleBin.name)
            || !isZipEntryName(entry.subtitleSbt.name)
            || !isMovieSourceFingerprints(
                entry.sourceFingerprints,
                entry.movie,
                entry.subtitleBin,
                entry.subtitleSbt,
            ))
        return false;
    return entry.subtitleBytes === entry.subtitleBin.size + entry.subtitleSbt.size;
}

function isMovieCatalogIssue(value: unknown): value is MovieCatalogIssue {
    const issue = objectValue(value);
    return issue !== null
        && typeof issue.name === "string" && issue.name.length > 0
        && isZipEntryName(`${issue.name}.m2v`)
        && typeof issue.label === "string" && issue.label.length > 0
        && ["opening", "story", "gameplay"].includes(issue.group as string)
        && isSafeInteger(issue.sourceBytes, 1)
        && typeof issue.reason === "string" && issue.reason.length > 0
        && issue.reason.length <= 320
        && technicalReason(issue.reason) === issue.reason;
}

function parseCatalog(value: unknown,
                      expectedSourceKey: string): MovieCatalog | null {
    const candidate = objectValue(value);
    if (candidate === null || candidate.v !== 3
            || candidate.sourceKey !== expectedSourceKey
            || !Array.isArray(candidate.entries)
            || !candidate.entries.every(isMovieEntry)
            || !Array.isArray(candidate.issues)
            || !candidate.issues.every(isMovieCatalogIssue))
        return null;
    const names = [
        ...candidate.entries.map(entry => entry.name),
        ...candidate.issues.map(issue => issue.name),
    ];
    if (new Set(names).size !== names.length)
        return null;
    return {
        v: 3,
        sourceKey: expectedSourceKey,
        entries: candidate.entries,
        issues: candidate.issues,
    };
}

async function subtitleData(vfi: Vfi, asset: FmvAsset,
                            signal?: AbortSignal): Promise<SubtitleBundle> {
    signal?.throwIfAborted();
    if (!asset.subtitleBin || !asset.subtitleSbt)
        return EMPTY_SUBTITLES;
    const [bin, sbt] = await Promise.all([
        vfi.read(asset.subtitleBin), vfi.read(asset.subtitleSbt),
    ]);
    if (bin.byteLength !== asset.subtitleBin.size
            || sbt.byteLength !== asset.subtitleSbt.size)
        throw new Error("subtitle source short read");
    signal?.throwIfAborted();
    return {
        cues: parseFmvSubtitles(bin, sbt, asset.name),
        bin,
        sbt,
    };
}

function movieCatalogIssue(asset: FmvDiscovery, label: string,
                           movieGroup: MovieGroup, cause: FmvFormatError): MovieCatalogIssue {
    return {
        name: asset.name,
        label,
        group: movieGroup,
        sourceBytes: asset.movie.size,
        reason: technicalReason(cause),
    };
}

export async function scanMovieCatalog(
    vfi: Vfi,
    sourceKey: string,
    progress?: MovieProgress,
    signal?: AbortSignal,
): Promise<MovieCatalog> {
    assertCacheSourceIdentity(null, sourceKey);
    const assets = locateFmvAssets(vfi);
    const entries: MovieEntry[] = [];
    const issues: MovieCatalogIssue[] = [];
    for (let index = 0; index < assets.length; index++) {
        signal?.throwIfAborted();
        const asset = assets[index]!;
        const label = title(asset.name);
        const movieGroup = group(asset.name);
        progress?.(index / assets.length, `scanning ${asset.name}`);
        if ("formatError" in asset) {
            issues.push(movieCatalogIssue(
                asset, label, movieGroup, asset.formatError));
            continue;
        }
        try {
            const movieBytes = await vfi.read(asset.movie);
            if (movieBytes.byteLength !== asset.movie.size)
                throw new Error("movie source short read");
            signal?.throwIfAborted();
            const { header, videoInfo } =
                inspectFmvPrefix(movieBytes, `movie ${asset.name}`);
            const subtitles = await subtitleData(vfi, asset, signal);
            signal?.throwIfAborted();
            const sourceFiles: Array<[string, Uint8Array]> = [
                [asset.movie.name, movieBytes],
            ];
            if (asset.subtitleBin && subtitles.bin)
                sourceFiles.push([asset.subtitleBin.name, subtitles.bin]);
            if (asset.subtitleSbt && subtitles.sbt)
                sourceFiles.push([asset.subtitleSbt.name, subtitles.sbt]);
            const sourceFingerprints = await Promise.all(
                sourceFiles.map(async ([name, bytes]) => ({
                    name,
                    ...await fingerprintBytes(bytes),
                })),
            );
            signal?.throwIfAborted();
            entries.push({
                name: asset.name,
                label,
                group: movieGroup,
                movie: asset.movie,
                subtitleBin: asset.subtitleBin,
                subtitleSbt: asset.subtitleSbt,
                sourceBytes: asset.movie.size,
                subtitleBytes: (asset.subtitleBin?.size ?? 0)
                    + (asset.subtitleSbt?.size ?? 0),
                subtitleCues: subtitles.cues.length,
                subtitleEnd: subtitles.cues.at(-1)?.end ?? null,
                header,
                video: videoInfo,
                duration: header.fields / header.fieldRate,
                sourceFingerprints,
            });
        } catch (cause) {
            signal?.throwIfAborted();
            if (!(cause instanceof FmvFormatError))
                throw cause;
            issues.push(movieCatalogIssue(asset, label, movieGroup, cause));
        }
    }
    signal?.throwIfAborted();
    progress?.(1, "movie catalog ready");
    return { v: 3, sourceKey, entries, issues };
}

function movieRoot(name: string): string {
    return `movies/${CACHE_VERSION}/${name}`;
}

function directMp4Key(name: string, captions: boolean): string {
    return `${movieRoot(name)}/export-direct-mp4-v1-${captions ? "captions" : "plain"}.mp4`;
}
function directMkvKey(name: string, captions: boolean): string {
    return `${movieRoot(name)}/export-lossless-mkv-v1-${captions ? "captions" : "plain"}.mkv`;
}


function legacyExportKey(name: string, format: string, captions: boolean): string {
    return `${movieRoot(name)}/export-${format}-${captions ? "captions" : "plain"}.${format}`;
}


interface MovieSourceIdentity {
    readonly v: 2;
    readonly sourceKey: string;
    readonly files: readonly MovieSourceFileIdentity[];
}

function sourceMetaKey(name: string): string {
    return `${movieRoot(name)}/source_meta.json`;
}

function catalogSourceFingerprints(entry: MovieEntry):
        Map<string, ContentFingerprint> {
    return new Map(entry.sourceFingerprints.map(file => [file.name, file]));
}


function parseSourceIdentity(value: unknown, entry: MovieEntry,
                             expectedSourceKey: string):
        Map<string, ContentFingerprint> | null {
    const identity = objectValue(value);
    if (!identity || identity.v !== 2
            || identity.sourceKey !== expectedSourceKey
            || !Array.isArray(identity.files))
        return null;
    const expected = catalogSourceFingerprints(entry);
    const files: MovieSourceFileIdentity[] = [];
    const names = new Set<string>();
    for (const value of identity.files) {
        const candidate = objectValue(value);
        if (!candidate
                || typeof candidate.name !== "string"
                || !isZipEntryName(candidate.name)
                || names.has(candidate.name)
                || !isContentFingerprint(candidate))
            return null;
        const fingerprint = expected.get(candidate.name);
        if (!fingerprint
                || !contentFingerprintMatches(candidate, fingerprint))
            return null;
        files.push(candidate as unknown as MovieSourceFileIdentity);
        names.add(candidate.name);
    }
    if (files.length !== expected.size) return null;
    return new Map(files.map(file => [file.name, file]));
}

export class MovieStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string;
    private catalogValue: MovieCatalog | null;
    private readonly memory = new Map<string, Uint8Array>();
    private cacheWarning: string | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null, cacheKey: string,
                catalog: MovieCatalog | null = null) {
        assertCacheSourceIdentity(cache, cacheKey);
        if (catalog && catalog.sourceKey !== cacheKey)
            throw new Error("movie catalog belongs to a different disc session");
        const parsed = catalog ? parseCatalog(catalog, cacheKey) : null;
        if (catalog && !parsed)
            throw new Error("movie catalog has an invalid schema");
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
        this.catalogValue = parsed;
    }

    hasIso(): boolean { return this.vfi !== null; }
    get persistenceWarning(): string | null { return this.cacheWarning; }

    async catalog(signal?: AbortSignal): Promise<MovieCatalog | null> {
        signal?.throwIfAborted();
        if (this.catalogValue)
            return this.catalogValue;
        if (this.cache) {
            let raw: Uint8Array | null;
            try {
                raw = await this.cache.read(META);
                signal?.throwIfAborted();
            } catch (error) {
                signal?.throwIfAborted();
                this.useAttachedIsoAfterCacheFailure(
                    error,
                    "the movie cache is unavailable -- reconnect the same disc or forget the disc cache",
                );
                raw = null;
            }
            if (raw) {
                try {
                    const parsed = parseCatalog(
                        JSON.parse(textDecoder.decode(raw)),
                        this.cacheKey,
                    );
                    if (!parsed)
                        throw new Error("the cached movie index has an invalid schema");
                    signal?.throwIfAborted();
                    if (!this.vfi) {
                        this.catalogValue = parsed;
                        return parsed;
                    }
                } catch (error) {
                    return this.recoverCorruptCatalog(error, signal);
                }
            }
        }
        signal?.throwIfAborted();
        if (!this.vfi)
            return null;
        this.catalogValue = await scanMovieCatalog(
            this.vfi, this.cacheKey, undefined, signal);
        signal?.throwIfAborted();
        await this.persistCatalog(signal);
        signal?.throwIfAborted();
        return this.catalogValue;
    }
    private useAttachedIsoAfterCacheFailure(error: unknown, message: string): void {
        if (!this.vfi) throw new Error(message, { cause: error });
        this.cacheWarning = `${message} (${technicalReason(error)}); `
            + "using the attached ISO for this session";
        console.warn("Movie cache failed; using the attached ISO", error);
        this.cache = null;
    }

    private recordCacheWriteFailure(error: unknown, message: string): void {
        this.cacheWarning = `${message} (${technicalReason(error)}); `
            + "movie data remains available for this session";
        console.warn("Movie cache write failed; keeping a session copy", error);
        this.cache = null;
    }


    private async recoverCorruptCatalog(error: unknown,
                                        signal?: AbortSignal): Promise<MovieCatalog> {
        signal?.throwIfAborted();
        if (!this.vfi) {
            throw new Error(
                "the cached movie index is damaged -- reconnect the same disc to rebuild it or forget the disc cache",
                { cause: error },
            );
        }
        console.warn("Cached movie index is damaged; rebuilding it from the attached ISO", error);
        this.catalogValue = await scanMovieCatalog(
            this.vfi, this.cacheKey, undefined, signal);
        signal?.throwIfAborted();
        await this.persistCatalog(signal);
        signal?.throwIfAborted();
        return this.catalogValue;
    }

    async persistCatalog(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (!this.cache || !this.catalogValue)
            return;
        try {
            await this.cache.write(META,
                textEncoder.encode(JSON.stringify(this.catalogValue)));
            signal?.throwIfAborted();
        } catch (error) {
            if (signal?.aborted) throw error;
            this.recordCacheWriteFailure(
                error,
                "the movie catalog could not be persisted",
            );
        }
    }

    async attachIso(file: File, progress?: MovieProgress,
                    signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const disc = await openDisc(new BlobSource(file));
        signal?.throwIfAborted();
        assertAttachedDiscIdentity(this.cacheKey, disc.cacheKey);
        const catalog = await scanMovieCatalog(
            disc.vfi, this.cacheKey, progress, signal);
        signal?.throwIfAborted();
        this.vfi = disc.vfi;
        this.catalogValue = catalog;
        await this.persistCatalog(signal);
        signal?.throwIfAborted();
    }

    private async entry(name: string, signal?: AbortSignal): Promise<MovieEntry> {
        signal?.throwIfAborted();
        const catalog = await this.catalog(signal);
        signal?.throwIfAborted();
        const entry = catalog?.entries.find(candidate => candidate.name === name);
        const issue = catalog?.issues.find(candidate => candidate.name === name);
        if (issue)
            throw new Error(`movie ${issue.name} is unavailable: ${issue.reason}`);
        if (!entry) throw new Error(`movie ${name} is not in this disc catalog`);
        return entry;
    }

    private async cachedRead(key: string, signal?: AbortSignal): Promise<Uint8Array | null> {
        signal?.throwIfAborted();
        const memory = this.memory.get(key);
        if (memory) {
            signal?.throwIfAborted();
            return memory;
        }
        if (!this.cache) return null;
        try {
            const cached = await this.cache.read(key);
            signal?.throwIfAborted();
            return cached;
        } catch (error) {
            signal?.throwIfAborted();
            this.useAttachedIsoAfterCacheFailure(
                error,
                "the movie cache is unavailable -- reconnect the same disc or forget the disc cache",
            );
            return null;
        }
    }

    private async cacheWrite(key: string, bytes: Uint8Array): Promise<boolean> {
        if (!this.cache) {
            this.memory.set(key, bytes);
            return false;
        }
        try {
            await this.cache.write(key, bytes);
            return true;
        } catch (error) {
            this.recordCacheWriteFailure(
                error,
                "movie data could not be persisted",
            );
            this.memory.set(key, bytes);
            return false;
        }
    }
    private async readDiscEntry(entry: VfiEntry,
                                expected: ContentFingerprint | undefined,
                                signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        if (!this.vfi)
            throw new Error("this movie is not cached -- reconnect the same disc to prepare it");
        if (!expected)
            throw new Error("the movie catalog source identity is incomplete");
        const current = this.vfi.find(entry.path);
        if (!current)
            throw new Error("a movie source file is missing from the attached disc");
        const bytes = await this.vfi.read(current);
        signal?.throwIfAborted();
        const actual = await fingerprintBytes(bytes);
        signal?.throwIfAborted();
        if (!contentFingerprintMatches(expected, actual))
            throw new Error(
                "the attached movie source content does not match this catalog "
                + "-- reopen the disc to rebuild the movie catalog",
            );
        return bytes;
    }

    private async readSourceIdentity(
        entry: MovieEntry,
        signal?: AbortSignal,
    ): Promise<Map<string, ContentFingerprint> | null> {
        const raw = await this.cachedRead(sourceMetaKey(entry.name), signal);
        signal?.throwIfAborted();
        if (!raw) return null;
        let value: unknown;
        try {
            value = JSON.parse(textDecoder.decode(raw));
        } catch (error) {
            this.useAttachedIsoAfterCacheFailure(
                error,
                "the cached movie source metadata is damaged -- reconnect the same disc or remove this movie cache",
            );
            return null;
        }
        const identity = parseSourceIdentity(value, entry, this.cacheKey);
        if (!identity) {
            this.useAttachedIsoAfterCacheFailure(
                new Error("the cached movie source metadata has an invalid schema"),
                "the cached movie source metadata is damaged -- reconnect the same disc or remove this movie cache",
            );
            return null;
        }
        return identity;
    }

    private async sourceIdentity(
        entry: MovieEntry,
        signal?: AbortSignal,
    ): Promise<Map<string, ContentFingerprint>> {
        const identity = await this.readSourceIdentity(entry, signal);
        if (!identity)
            throw new Error(
                "the cached movie source is incomplete -- reconnect the same disc or remove this movie cache",
            );
        return identity;
    }
    private async verifiedCachedSource(
        key: string,
        expected: ContentFingerprint | undefined,
        signal?: AbortSignal,
    ): Promise<Uint8Array> {
        if (!expected)
            throw new Error("the cached movie source metadata is incomplete");
        const bytes = await this.cachedRead(key, signal);
        signal?.throwIfAborted();
        if (!bytes)
            throw new Error(
                "the cached movie source is incomplete -- reconnect the same disc or remove this movie cache",
            );
        const actual = await fingerprintBytes(bytes);
        signal?.throwIfAborted();
        if (!contentFingerprintMatches(expected, actual))
            throw new Error(
                "the cached movie source is damaged -- reconnect the same disc or remove this movie cache",
            );
        return bytes;
    }

    private async source(entry: MovieEntry,
                         signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        const expected = catalogSourceFingerprints(entry);
        if (this.vfi)
            return this.readDiscEntry(
                entry.movie,
                expected.get(entry.movie.name),
                signal,
            );
        const identities = await this.sourceIdentity(entry, signal);
        const key = `${movieRoot(entry.name)}/${entry.movie.name}`;
        return this.verifiedCachedSource(
            key, identities.get(entry.movie.name), signal);
    }

    private async subtitles(entry: MovieEntry,
                            signal?: AbortSignal): Promise<SubtitleBundle> {
        signal?.throwIfAborted();
        if (!entry.subtitleBin || !entry.subtitleSbt)
            return EMPTY_SUBTITLES;
        const root = movieRoot(entry.name);
        let bin: Uint8Array;
        let sbt: Uint8Array;
        if (this.vfi) {
            const expected = catalogSourceFingerprints(entry);
            [bin, sbt] = await Promise.all([
                this.readDiscEntry(
                    entry.subtitleBin,
                    expected.get(entry.subtitleBin.name),
                    signal,
                ),
                this.readDiscEntry(
                    entry.subtitleSbt,
                    expected.get(entry.subtitleSbt.name),
                    signal,
                ),
            ]);
        } else {
            const identities = await this.sourceIdentity(entry, signal);
            [bin, sbt] = await Promise.all([
                this.verifiedCachedSource(
                    `${root}/${entry.subtitleBin.name}`,
                    identities.get(entry.subtitleBin.name),
                    signal,
                ),
                this.verifiedCachedSource(
                    `${root}/${entry.subtitleSbt.name}`,
                    identities.get(entry.subtitleSbt.name),
                    signal,
                ),
            ]);
        }
        signal?.throwIfAborted();
        const cues = parseFmvSubtitles(bin, sbt, entry.name);
        signal?.throwIfAborted();
        return { bin, sbt, cues };
    }

    private sourceFiles(
        entry: MovieEntry,
        source: Uint8Array,
        subtitles: SubtitleBundle,
    ): Array<[string, Uint8Array]> {
        const files: Array<[string, Uint8Array]> = [[entry.movie.name, source]];
        if (entry.subtitleBin && subtitles.bin)
            files.push([entry.subtitleBin.name, subtitles.bin]);
        if (entry.subtitleSbt && subtitles.sbt)
            files.push([entry.subtitleSbt.name, subtitles.sbt]);
        return files;
    }

    private async persistedSourceMatches(
        entry: MovieEntry,
        source: Uint8Array,
        subtitles: SubtitleBundle,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const raw = await this.cachedRead(sourceMetaKey(entry.name), signal);
        signal?.throwIfAborted();
        if (!raw) return false;
        let value: unknown;
        try {
            value = JSON.parse(textDecoder.decode(raw));
        } catch {
            return false;
        }
        const expected = parseSourceIdentity(value, entry, this.cacheKey);
        if (!expected) return false;
        for (const [name, bytes] of this.sourceFiles(entry, source, subtitles)) {
            const actual = await fingerprintBytes(bytes);
            signal?.throwIfAborted();
            const fingerprint = expected.get(name);
            if (!fingerprint || !contentFingerprintMatches(fingerprint, actual))
                return false;
        }
        return true;
    }

    private async persistSources(
        entry: MovieEntry,
        source: Uint8Array,
        subtitles: SubtitleBundle,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const files = this.sourceFiles(entry, source, subtitles);
        const identities = entry.sourceFingerprints;
        signal?.throwIfAborted();
        const root = movieRoot(entry.name);
        let persistent = true;
        for (const [name, bytes] of files) {
            const stored = await this.cacheWrite(`${root}/${name}`, bytes);
            persistent = stored && persistent;
            signal?.throwIfAborted();
        }
        const metadata: MovieSourceIdentity = {
            v: 2,
            sourceKey: this.cacheKey,
            files: identities,
        };
        const metadataStored = await this.cacheWrite(
            sourceMetaKey(entry.name),
            textEncoder.encode(JSON.stringify(metadata)),
        );
        signal?.throwIfAborted();
        return persistent && metadataStored;
    }

    private async demux(entry: MovieEntry, progress: MovieProgress,
                        signal?: AbortSignal): Promise<{
        demuxed: FmvDemux; subtitles: SubtitleBundle; sourcePersistent: boolean;
    }> {
        progress(0.02, "reading selected movie");
        signal?.throwIfAborted();
        const [source, subtitles] = await Promise.all([
            this.source(entry, signal), this.subtitles(entry, signal),
        ]);
        signal?.throwIfAborted();
        progress(0.08, "validating and demuxing");
        const demuxed = demuxFmv(source, entry.name);
        signal?.throwIfAborted();
        const sourcePersistent = await this.persistSources(
            entry, source, subtitles, signal);
        if (!sourcePersistent)
            progress(0.09, "persistent storage unavailable; movie source is session-only");
        return { demuxed, subtitles, sourcePersistent };
    }

    private async removeLegacyArtifacts(name: string, signal?: AbortSignal): Promise<void> {
        const keys = [`${movieRoot(name)}/playback.mp4`];
        for (const format of LEGACY_OUTPUT_FORMATS) {
            keys.push(
                legacyExportKey(name, format, false),
                legacyExportKey(name, format, true),
            );
        }
        for (const key of keys) {
            signal?.throwIfAborted();
            this.memory.delete(key);
            if (!this.cache) continue;
            try {
                await this.cache.remove(key);
            } catch (error) {
                signal?.throwIfAborted();
                this.cacheWarning = `obsolete movie cache data could not be removed `
                    + `(${technicalReason(error)}); playback remains available`;
                console.warn("Obsolete movie cache cleanup failed", error);
                this.cache = null;
            }
        }
        signal?.throwIfAborted();
    }

    private async exportDirect(entry: MovieEntry, format: "mkv" | "mp4",
                               captions: boolean, progress: MovieProgress,
                               signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        const label = format === "mkv" ? "Lossless MKV" : "Fast MP4";
        const key = format === "mkv"
            ? directMkvKey(entry.name, captions)
            : directMp4Key(entry.name, captions);
        progress(0.02, `reading ${label} source`);
        const [source, subtitles] = await Promise.all([
            this.source(entry, signal),
            this.subtitles(entry, signal),
        ]);
        signal?.throwIfAborted();

        const sourceMatches = this.vfi
            ? await this.persistedSourceMatches(entry, source, subtitles, signal)
            : true;
        signal?.throwIfAborted();
        if (sourceMatches) {
            const sessionCached = this.memory.has(key);
            const cached = await this.cachedRead(key, signal);
            signal?.throwIfAborted();
            if (cached) {
                progress(1, sessionCached
                    ? `using session-only ${label}`
                    : `using cached ${label}`);
                return cached;
            }
        }

        progress(0.08, "persisting original movie source");
        const sourcePersistent = await this.persistSources(
            entry, source, subtitles, signal);
        if (!sourcePersistent)
            progress(0.14, "original source ready; cache is session-only");

        const vtt = captions && subtitles.cues.length > 0
            ? subtitlesToVtt(subtitles.cues)
            : undefined;
        progress(0.16, `loading ${label} worker`);
        signal?.throwIfAborted();
        const exporter = await import("./movie-export-client.ts");
        signal?.throwIfAborted();
        progress(0.18, `starting ${label} export`);
        const convert = format === "mkv"
            ? exporter.exportMovieMkv
            : exporter.exportMovieMp4;
        const converted = await convert({
            name: entry.name,
            fmv: source,
            ...(vtt === undefined ? {} : { vtt }),
            cooperativeCopy: !sourcePersistent,
            expectations: {
                duration: entry.duration,
                width: entry.video.width,
                height: entry.video.height,
                fieldOrder: entry.video.fieldOrder,
                sampleAspect: entry.video.sampleAspect,
                displayAspect: entry.video.displayAspect,
                channels: entry.header.channels,
                sampleRate: entry.header.sampleRate,
            },
        }, (value, stage) => progress(0.18 + value * 0.76, stage), signal);
        signal?.throwIfAborted();

        progress(0.96, `caching ${label}`);
        const persistent = await this.cacheWrite(key, converted);
        signal?.throwIfAborted();
        progress(1, persistent
            ? `${label} ready`
            : `${label} ready; export cache is session-only`);
        signal?.throwIfAborted();
        return converted;
    }

    async prepare(name: string, progress: MovieProgress,
                  signal?: AbortSignal): Promise<MoviePlaybackSource> {
        signal?.throwIfAborted();
        const entry = await this.entry(name, signal);
        signal?.throwIfAborted();
        const { demuxed, subtitles, sourcePersistent } = await this.demux(
            entry, progress, signal);
        progress(0.7, "indexing MPEG-2 video");
        const seekIndex = indexMpeg2SeekPoints(
            demuxed.video, `${entry.name} MPEG-2 video`);
        signal?.throwIfAborted();
        await this.removeLegacyArtifacts(entry.name, signal);
        signal?.throwIfAborted();
        progress(0.9, "reading movie cache");
        const cache = await this.cacheInfo(name, signal);
        signal?.throwIfAborted();
        progress(1, sourcePersistent
            ? "movie source ready"
            : "movie source ready; cache is session-only");
        return {
            name: entry.name,
            video: demuxed.video,
            wav: demuxed.wav,
            cues: subtitles.cues,
            videoInfo: demuxed.videoInfo,
            seekIndex,
            duration: entry.duration,
            cache,
        };
    }

    async cacheInfo(name: string, signal?: AbortSignal): Promise<MovieCacheInfo> {
        signal?.throwIfAborted();
        const root = movieRoot(name);
        const entry = await this.entry(name, signal);
        const sourceKeys = [`${root}/${entry.movie.name}`];
        if (entry.subtitleBin) sourceKeys.push(`${root}/${entry.subtitleBin.name}`);
        if (entry.subtitleSbt) sourceKeys.push(`${root}/${entry.subtitleSbt.name}`);
        const identity = await this.readSourceIdentity(entry, signal);
        const sourceBytes = identity
            ? await this.totalSize(sourceKeys, signal)
            : 0;
        const exportKeys = [
            directMp4Key(name, false),
            directMp4Key(name, true),
            directMkvKey(name, false),
            directMkvKey(name, true),
        ];
        const exportBytes = await this.totalSize(exportKeys, signal);
        signal?.throwIfAborted();
        return {
            sourceBytes,
            exportBytes,
            totalBytes: sourceBytes + exportBytes,
        };
    }

    private async size(key: string, signal?: AbortSignal): Promise<number> {
        signal?.throwIfAborted();
        const memory = this.memory.get(key);
        if (memory)
            return memory.byteLength;
        if (!this.cache) return 0;
        try {
            const bytes = await this.cache.size(key);
            signal?.throwIfAborted();
            return bytes ?? 0;
        } catch (error) {
            signal?.throwIfAborted();
            this.useAttachedIsoAfterCacheFailure(
                error,
                "the movie cache could not be measured -- reconnect the same disc or forget the disc cache",
            );
            return 0;
        }
    }

    private async totalSize(keys: readonly string[], signal?: AbortSignal): Promise<number> {
        signal?.throwIfAborted();
        const values = await Promise.all(keys.map(key => this.size(key, signal)));
        signal?.throwIfAborted();
        return values.reduce((sum, value) => sum + value, 0);
    }

    async remove(name: string): Promise<void> {
        const prefix = `${movieRoot(name)}/`;
        for (const key of [...this.memory.keys()])
            if (key.startsWith(prefix)) this.memory.delete(key);
        await this.cache?.remove(movieRoot(name), true);
    }

    async export(name: string, kind: MovieExportKind, captions: boolean,
                 progress: MovieProgress, signal?: AbortSignal): Promise<MovieExport> {
        signal?.throwIfAborted();
        const entry = await this.entry(name, signal);
        signal?.throwIfAborted();
        if (kind === "original") {
            signal?.throwIfAborted();
            const [source, subtitles] = await Promise.all([
                this.source(entry, signal), this.subtitles(entry, signal),
            ]);
            signal?.throwIfAborted();
            const files: Array<[string, Uint8Array]> = [[entry.movie.name, source]];
            if (entry.subtitleBin && subtitles.bin) files.push([entry.subtitleBin.name, subtitles.bin]);
            if (entry.subtitleSbt && subtitles.sbt) files.push([entry.subtitleSbt.name, subtitles.sbt]);
            signal?.throwIfAborted();
            const bytes = storeZip(files);
            signal?.throwIfAborted();
            progress(1, "original archive ready");
            return { filename: `${name}-original.zip`, bytes, mime: "application/zip" };
        }
        if (kind === "masters") {
            signal?.throwIfAborted();
            const { demuxed, subtitles, sourcePersistent } = await this.demux(
                entry, progress, signal);
            signal?.throwIfAborted();
            const files: Array<[string, Uint8Array]> = [
                [`${name}.m2v`, demuxed.video], [`${name}.wav`, demuxed.wav],
            ];
            if (subtitles.cues.length)
                files.push([`${name}.srt`, subtitlesToSrt(subtitles.cues)]);
            signal?.throwIfAborted();
            const bytes = storeZip(files);
            signal?.throwIfAborted();
            progress(1, sourcePersistent
                ? "master archive ready"
                : "master archive ready; source cache is session-only");
            return { filename: `${name}-masters.zip`, bytes, mime: "application/zip" };
        }
        signal?.throwIfAborted();
        const converted = await this.exportDirect(
            entry, kind, captions, progress, signal);
        signal?.throwIfAborted();
        return {
            filename: `${name}.${kind}`,
            bytes: converted,
            mime: kind === "mkv" ? "video/x-matroska" : "video/mp4",
        };
    }
}
