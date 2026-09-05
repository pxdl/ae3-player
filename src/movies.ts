import {
    BlobSource, OpfsCache, openDisc, locateFmvAssets, demuxFmv,
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
import {
    FmvFormatError, inspectFmv, fmvLanguage, FMV_PAL_AUDIO_LANGUAGES,
    type FmvDiscovery, type FmvSubtitleAsset,
} from "./vendor/extract/fmv.ts";
import {
    contentFingerprintMatches,
    fingerprintBytes,
    isContentFingerprint,
    type ContentFingerprint,
} from "./content-identity.ts";

const META = "movie_meta.json";
const CACHE_VERSION = "v2-source-lanes-mpeg-cadence";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MOVIE_LABELS: Readonly<Record<string, string>> = {
    new_advertise: "Advertisement",
    new_dolby_pl2: "Dolby Pro Logic II",
    new_million: "Million Monkeys",
    new_rc4: "RC4",
};

export type MovieGroup = "opening" | "story" | "gameplay";

export interface MovieSourceFileIdentity extends ContentFingerprint {
    readonly name: string;
}

export interface MovieAudioTrack {
    readonly index: number;
    readonly language: string | null;
    readonly label: string;
}

export interface MovieSubtitleTrack extends FmvSubtitleAsset {
    readonly cues: number;
    readonly end: number | null;
}

export interface MovieSelection {
    readonly audioTrack: number;
    readonly subtitleId: string | null;
}

export interface MovieEntry {
    readonly name: string;
    readonly label: string;
    readonly group: MovieGroup;
    readonly movie: VfiEntry;
    readonly audioTracks: readonly MovieAudioTrack[];
    readonly subtitleTracks: readonly MovieSubtitleTrack[];
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
    readonly v: 4;
    readonly sourceKey: string;
    readonly entries: readonly MovieEntry[];
    readonly issues: readonly MovieCatalogIssue[];
}

export interface MovieCacheInfo {
    sourceBytes: number;
    exportBytes: number;
    totalBytes: number;
}

interface SubtitleTrackData {
    asset: FmvSubtitleAsset;
    bin: Uint8Array;
    sbt: Uint8Array;
    cues: readonly SubtitleCue[];
}

type SubtitleBundle = readonly SubtitleTrackData[];

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
    subtitleTracks: readonly { id: string; cues: readonly SubtitleCue[] }[];
    subtitleId: string | null;
    videoInfo: FmvVideoInfo;
    seekIndex: Mpeg2SeekIndex;
    duration: number;
    cache: MovieCacheInfo;
}

export type MovieProgress = (progress: number, stage: string) => void;

export function defaultMovieSelection(entry: MovieEntry): MovieSelection {
    const audio = entry.audioTracks[0]!;
    return {
        audioTrack: audio.index,
        subtitleId: (entry.subtitleTracks.find(track => track.language === audio.language)
            ?? entry.subtitleTracks[0])?.id ?? null,
    };
}

function checkedSelection(entry: MovieEntry, selection = defaultMovieSelection(entry)): MovieSelection {
    if (!entry.audioTracks.some(track => track.index === selection.audioTrack)
            || (selection.subtitleId !== null
                && !entry.subtitleTracks.some(track => track.id === selection.subtitleId)))
        throw new Error("movie language selection is not available in this source");
    return selection;
}

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

function isMovieSourceFingerprints(value: unknown, movie: VfiEntry,
                                   subtitles: readonly FmvSubtitleAsset[]):
        value is readonly MovieSourceFileIdentity[] {
    if (!Array.isArray(value)) return false;
    const expected = new Map<string, number>([[movie.name, movie.size]]);
    for (const track of subtitles) {
        if (expected.has(track.bin.name) || expected.has(track.sbt.name)) return false;
        expected.set(track.bin.name, track.bin.size);
        expected.set(track.sbt.name, track.sbt.size);
    }
    if (value.length !== expected.size) return false;
    const names = new Set<string>();
    for (const item of value) {
        const candidate = objectValue(item);
        if (!candidate || typeof candidate.name !== "string"
                || !isZipEntryName(candidate.name) || names.has(candidate.name)
                || !isContentFingerprint(candidate)
                || candidate.bytes !== expected.get(candidate.name))
            return false;
        names.add(candidate.name);
    }
    return names.size === expected.size;
}

function isLanguage(value: unknown): value is string | null {
    return value === null || (typeof value === "string" && /^[a-z]{3}$/.test(value));
}

function isSubtitleTrack(value: unknown): value is MovieSubtitleTrack {
    const track = objectValue(value);
    return track !== null && typeof track.id === "string" && isZipEntryName(track.id)
        && isLanguage(track.language) && typeof track.label === "string" && track.label.length > 0
        && isVfiEntry(track.bin) && isZipEntryName(track.bin.name)
        && isVfiEntry(track.sbt) && isZipEntryName(track.sbt.name)
        && isSafeInteger(track.cues)
        && (track.end === null || (typeof track.end === "number"
            && Number.isFinite(track.end) && track.end >= 0));
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
    if (!Array.isArray(entry.subtitleTracks) || !entry.subtitleTracks.every(isSubtitleTrack)
            || !Array.isArray(entry.audioTracks)
            || (entry.audioTracks.length !== 1 && entry.audioTracks.length !== 5))
        return false;
    for (let index = 0; index < entry.audioTracks.length; index++) {
        const track = objectValue(entry.audioTracks[index]);
        if (!track || track.index !== index || !isLanguage(track.language)
                || typeof track.label !== "string" || track.label.length === 0)
            return false;
    }
    const subtitles = entry.subtitleTracks;
    const directory = entry.movie.path.slice(0, entry.movie.path.lastIndexOf("/") + 1);
    return entry.name === entry.movie.path.replace(/\.str$/i, "")
        && new Set(subtitles.map(track => track.id)).size === subtitles.length
        && subtitles.every(track => track.bin.path === directory + track.bin.name
            && track.sbt.path === directory + track.sbt.name)
        && entry.subtitleBytes === subtitles.reduce((sum, track) => sum + track.bin.size + track.sbt.size, 0)
        && entry.subtitleCues === subtitles.reduce((sum, track) => sum + track.cues, 0)
        && isMovieSourceFingerprints(entry.sourceFingerprints, entry.movie, subtitles);
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
    if (candidate === null || candidate.v !== 4
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
        v: 4,
        sourceKey: expectedSourceKey,
        entries: candidate.entries,
        issues: candidate.issues,
    };
}

async function subtitleData(vfi: Vfi, asset: FmvAsset,
                            signal?: AbortSignal): Promise<SubtitleBundle> {
    return Promise.all(asset.subtitles.map(async track => {
        signal?.throwIfAborted();
        const [bin, sbt] = await Promise.all([vfi.read(track.bin), vfi.read(track.sbt)]);
        if (bin.byteLength !== track.bin.size || sbt.byteLength !== track.sbt.size)
            throw new Error("subtitle source short read");
        signal?.throwIfAborted();
        return { asset: track, bin, sbt, cues: parseFmvSubtitles(bin, sbt, track.bin.path) };
    }));
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
        const basename = asset.movie.name.replace(/\.str$/i, "");
        const label = title(basename);
        const movieGroup = group(basename);
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
            const { header, videoInfo, audioTracks, duration } =
                inspectFmv(movieBytes, `movie ${asset.name}`);
            const subtitles = await subtitleData(vfi, asset, signal);
            signal?.throwIfAborted();
            const sourceFiles: Array<[string, Uint8Array]> = [
                [asset.movie.name, movieBytes],
            ];
            for (const track of subtitles) {
                sourceFiles.push([track.asset.bin.name, track.bin], [track.asset.sbt.name, track.sbt]);
            }
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
                audioTracks: audioTracks === 5
                    ? FMV_PAL_AUDIO_LANGUAGES.map((locale, index) => ({ index, ...fmvLanguage(locale) }))
                    : [{ index: 0, language: null, label: "Original audio" }],
                subtitleTracks: subtitles.map(track => ({
                    ...track.asset, cues: track.cues.length, end: track.cues.at(-1)?.end ?? null,
                })),
                sourceBytes: asset.movie.size,
                subtitleBytes: subtitles.reduce((sum, track) => sum + track.bin.length + track.sbt.length, 0),
                subtitleCues: subtitles.reduce((sum, track) => sum + track.cues.length, 0),
                subtitleEnd: subtitles.length
                    ? Math.max(...subtitles.map(track => track.cues.at(-1)?.end ?? 0)) : null,
                header,
                video: videoInfo,
                duration,
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
    return { v: 4, sourceKey, entries, issues };
}

function movieRoot(name: string): string {
    return `movies/${CACHE_VERSION}/${name}`;
}

function directExportKey(name: string, format: "mp4" | "mkv", selection: MovieSelection): string {
    const subtitle = selection.subtitleId === null ? "none" : `track-${encodeURIComponent(selection.subtitleId)}`;
    return `${movieRoot(name)}/export-${format}-lane-${selection.audioTrack}-sub-${subtitle}.${format}`;
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
                "the cached movie index is damaged or obsolete -- reconnect the same disc to rebuild it or forget the disc cache",
                { cause: error },
            );
        }
        console.warn("Cached movie index is damaged or obsolete; rebuilding it from the attached ISO", error);
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
            if (!this.vfi) throw new Error(
                "the cached movie source metadata is damaged -- reconnect the same disc or remove this movie cache",
                { cause: error },
            );
            return null;
        }
        const identity = parseSourceIdentity(value, entry, this.cacheKey);
        if (!identity) {
            if (!this.vfi) throw new Error(
                "the cached movie source metadata is damaged -- reconnect the same disc or remove this movie cache",
                { cause: new Error("invalid movie source schema") },
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
        if (entry.subtitleTracks.length === 0) return [];
        const root = movieRoot(entry.name);
        const identities = this.vfi ? catalogSourceFingerprints(entry)
            : await this.sourceIdentity(entry, signal);
        return Promise.all(entry.subtitleTracks.map(async asset => {
            const readFile = (file: VfiEntry): Promise<Uint8Array> => this.vfi
                ? this.readDiscEntry(file, identities.get(file.name), signal)
                : this.verifiedCachedSource(`${root}/${file.name}`, identities.get(file.name), signal);
            const [bin, sbt] = await Promise.all([readFile(asset.bin), readFile(asset.sbt)]);
            signal?.throwIfAborted();
            return { asset, bin, sbt, cues: parseFmvSubtitles(bin, sbt, asset.bin.path) };
        }));
    }

    private sourceFiles(
        entry: MovieEntry,
        source: Uint8Array,
        subtitles: SubtitleBundle,
    ): Array<[string, Uint8Array]> {
        const files: Array<[string, Uint8Array]> = [[entry.movie.name, source]];
        for (const track of subtitles)
            files.push([track.asset.bin.name, track.bin], [track.asset.sbt.name, track.sbt]);
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

    private async demux(entry: MovieEntry, selection: MovieSelection, progress: MovieProgress,
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
        const demuxed = demuxFmv(source, entry.name, selection.audioTrack);
        signal?.throwIfAborted();
        const sourcePersistent = await this.persistSources(
            entry, source, subtitles, signal);
        if (!sourcePersistent)
            progress(0.09, "persistent storage unavailable; movie source is session-only");
        return { demuxed, subtitles, sourcePersistent };
    }

    private async exportDirect(entry: MovieEntry, format: "mkv" | "mp4",
                               selection: MovieSelection, progress: MovieProgress,
                               signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        const label = format === "mkv" ? "Lossless MKV" : "Fast MP4";
        const key = directExportKey(entry.name, format, selection);
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

        const captionTrack = subtitles.find(track => track.asset.id === selection.subtitleId);
        const vtt = captionTrack && captionTrack.cues.length > 0
            ? subtitlesToVtt(captionTrack.cues)
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
            audioTrack: selection.audioTrack,
            audioLanguage: entry.audioTracks[selection.audioTrack]!.language,
            subtitleLanguage: captionTrack?.asset.language ?? null,
            ...(vtt === undefined ? {} : { vtt }),
            cooperativeCopy: !sourcePersistent,
            expectations: {
                duration: entry.duration,
                width: entry.video.width,
                height: entry.video.height,
                fieldOrder: entry.video.fieldOrder,
                frameRate: entry.video.frameRate,
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
                  signal?: AbortSignal, selection?: MovieSelection): Promise<MoviePlaybackSource> {
        signal?.throwIfAborted();
        const entry = await this.entry(name, signal);
        const selected = checkedSelection(entry, selection);
        signal?.throwIfAborted();
        const { demuxed, subtitles, sourcePersistent } = await this.demux(
            entry, selected, progress, signal);
        progress(0.7, "indexing MPEG-2 video");
        const seekIndex = indexMpeg2SeekPoints(
            demuxed.video, `${entry.name} MPEG-2 video`);
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
            subtitleTracks: subtitles.map(track => ({ id: track.asset.id, cues: track.cues })),
            subtitleId: selected.subtitleId,
            videoInfo: demuxed.videoInfo,
            seekIndex,
            duration: demuxed.duration,
            cache,
        };
    }

    async cacheInfo(name: string, signal?: AbortSignal): Promise<MovieCacheInfo> {
        signal?.throwIfAborted();
        const root = movieRoot(name);
        const entry = await this.entry(name, signal);
        const sourceKeys = [`${root}/${entry.movie.name}`];
        for (const track of entry.subtitleTracks)
            sourceKeys.push(`${root}/${track.bin.name}`, `${root}/${track.sbt.name}`);
        const identity = await this.readSourceIdentity(entry, signal);
        const sourceBytes = identity
            ? await this.totalSize(sourceKeys, signal)
            : 0;
        const exportKeys: string[] = [];
        for (const audio of entry.audioTracks) {
            for (const subtitleId of [null, ...entry.subtitleTracks.map(track => track.id)]) {
                const selection = { audioTrack: audio.index, subtitleId };
                exportKeys.push(directExportKey(name, "mp4", selection),
                    directExportKey(name, "mkv", selection));
            }
        }
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
                 progress: MovieProgress, signal?: AbortSignal, selection?: MovieSelection): Promise<MovieExport> {
        signal?.throwIfAborted();
        const entry = await this.entry(name, signal);
        const selected = checkedSelection(entry, selection);
        const filename = encodeURIComponent(name);
        const basename = entry.movie.name.replace(/\.str$/i, "");
        const variant = entry.audioTracks.length > 1
            ? `-lane-${selected.audioTrack}-${entry.audioTracks[selected.audioTrack]!.language ?? "und"}` : "";
        signal?.throwIfAborted();
        if (kind === "original") {
            signal?.throwIfAborted();
            const [source, subtitles] = await Promise.all([
                this.source(entry, signal), this.subtitles(entry, signal),
            ]);
            signal?.throwIfAborted();
            const files = this.sourceFiles(entry, source, subtitles);
            signal?.throwIfAborted();
            const bytes = storeZip(files);
            signal?.throwIfAborted();
            progress(1, "original archive ready");
            return { filename: `${filename}-original.zip`, bytes, mime: "application/zip" };
        }
        if (kind === "masters") {
            signal?.throwIfAborted();
            const { demuxed, subtitles, sourcePersistent } = await this.demux(
                entry, selected, progress, signal);
            signal?.throwIfAborted();
            const files: Array<[string, Uint8Array]> = [
                [`${basename}.m2v`, demuxed.video], [`${basename}${variant}.wav`, demuxed.wav],
            ];
            for (const track of subtitles) {
                const suffix = track.asset.id.slice(basename.replace(/^new_/i, "").length);
                files.push([`${basename}${suffix}.srt`, subtitlesToSrt(track.cues)]);
            }
            signal?.throwIfAborted();
            const bytes = storeZip(files);
            signal?.throwIfAborted();
            progress(1, sourcePersistent
                ? "master archive ready"
                : "master archive ready; source cache is session-only");
            return { filename: `${filename}${variant}-masters.zip`, bytes, mime: "application/zip" };
        }
        signal?.throwIfAborted();
        const converted = await this.exportDirect(
            entry, kind, captions ? selected : { ...selected, subtitleId: null }, progress, signal);
        signal?.throwIfAborted();
        return {
            filename: `${filename}${variant}${captions && selected.subtitleId
                ? `-sub-${encodeURIComponent(selected.subtitleId)}` : ""}.${kind}`,
            bytes: converted,
            mime: kind === "mkv" ? "video/x-matroska" : "video/mp4",
        };
    }
}
