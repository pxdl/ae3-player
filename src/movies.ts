import {
    BlobSource, OpfsCache, openDisc, locateFmvAssets, inspectFmvAsset, demuxFmv,
    indexMpeg2SeekPoints, parseFmvSubtitles, subtitlesToSrt, subtitlesToVtt,
    type FmvAsset, type FmvDemux, type FmvHeader, type FmvVideoInfo,
    type Mpeg2SeekIndex, type SubtitleCue, type Vfi, type VfiEntry,
} from "./vendor/extract/index.ts";
import { storeZip } from "./zip.ts";

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

export interface MovieEntry {
    name: string;
    label: string;
    group: MovieGroup;
    movie: VfiEntry;
    subtitleBin: VfiEntry | null;
    subtitleSbt: VfiEntry | null;
    sourceBytes: number;
    subtitleBytes: number;
    subtitleCues: number;
    subtitleEnd: number | null;
    header: FmvHeader;
    video: FmvVideoInfo;
    duration: number;
}

export interface MovieCatalog {
    v: 1;
    entries: MovieEntry[];
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

function validCatalog(value: unknown): value is MovieCatalog {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<MovieCatalog>;
    return candidate.v === 1 && Array.isArray(candidate.entries)
        && candidate.entries.every(entry => !!entry && typeof entry.name === "string"
            && typeof entry.sourceBytes === "number" && !!entry.header && !!entry.video);
}

async function subtitleData(vfi: Vfi, asset: FmvAsset,
                            signal?: AbortSignal): Promise<SubtitleBundle> {
    signal?.throwIfAborted();
    if (!asset.subtitleBin || !asset.subtitleSbt)
        return EMPTY_SUBTITLES;
    const [bin, sbt] = await Promise.all([
        vfi.read(asset.subtitleBin), vfi.read(asset.subtitleSbt),
    ]);
    signal?.throwIfAborted();
    return {
        cues: parseFmvSubtitles(bin, sbt, asset.name),
        bin,
        sbt,
    };
}

export async function scanMovieCatalog(vfi: Vfi, progress?: MovieProgress,
                                       signal?: AbortSignal): Promise<MovieCatalog> {
    const assets = locateFmvAssets(vfi);
    const entries: MovieEntry[] = [];
    for (let index = 0; index < assets.length; index++) {
        signal?.throwIfAborted();
        const asset = assets[index]!;
        progress?.(index / assets.length, `scanning ${asset.name}`);
        const [{ header, videoInfo }, subtitles] = await Promise.all([
            inspectFmvAsset(vfi, asset.movie),
            subtitleData(vfi, asset, signal),
        ]);
        signal?.throwIfAborted();
        entries.push({
            name: asset.name,
            label: title(asset.name),
            group: group(asset.name),
            movie: asset.movie,
            subtitleBin: asset.subtitleBin,
            subtitleSbt: asset.subtitleSbt,
            sourceBytes: asset.movie.size,
            subtitleBytes: (asset.subtitleBin?.size ?? 0) + (asset.subtitleSbt?.size ?? 0),
            subtitleCues: subtitles.cues.length,
            subtitleEnd: subtitles.cues.at(-1)?.end ?? null,
            header,
            video: videoInfo,
            duration: header.fields / header.fieldRate,
        });
    }
    signal?.throwIfAborted();
    progress?.(1, "movie catalog ready");
    return { v: 1, entries };
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

export class MovieStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string | null;
    private catalogValue: MovieCatalog | null;
    private readonly memory = new Map<string, Uint8Array>();

    constructor(cache: OpfsCache | null, vfi: Vfi | null, cacheKey: string | null,
                catalog: MovieCatalog | null = null) {
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
        this.catalogValue = catalog;
    }

    hasIso(): boolean { return this.vfi !== null; }

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
                return this.recoverCatalog(error, signal);
            }
            if (raw) {
                try {
                    const parsed: unknown = JSON.parse(textDecoder.decode(raw));
                    if (!validCatalog(parsed))
                        throw new Error("the cached movie index has an invalid schema");
                    signal?.throwIfAborted();
                    this.catalogValue = parsed;
                    return parsed;
                } catch (error) {
                    return this.recoverCatalog(error, signal);
                }
            }
        }
        signal?.throwIfAborted();
        if (!this.vfi)
            return null;
        this.catalogValue = await scanMovieCatalog(this.vfi, undefined, signal);
        signal?.throwIfAborted();
        await this.persistCatalog(signal);
        signal?.throwIfAborted();
        return this.catalogValue;
    }

    private async recoverCatalog(error: unknown,
                                 signal?: AbortSignal): Promise<MovieCatalog> {
        signal?.throwIfAborted();
        if (!this.vfi) {
            throw new Error(
                "the cached movie index is damaged -- reconnect the same disc to rebuild it or forget the disc cache",
                { cause: error },
            );
        }
        console.warn("Cached movie index is damaged; rebuilding it from the attached ISO", error);
        this.catalogValue = await scanMovieCatalog(this.vfi, undefined, signal);
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
            if (signal?.aborted)
                throw error;
            console.warn("OPFS movie catalog write failed; using the attached ISO", error);
            this.cache = null;
        }
    }

    async attachIso(file: File, progress?: MovieProgress,
                    signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const disc = await openDisc(new BlobSource(file));
        signal?.throwIfAborted();
        if (this.cacheKey && disc.cacheKey !== this.cacheKey)
            throw new Error("this ISO is a different disc than the cached one -- forget the disc first to switch");
        const catalog = await scanMovieCatalog(disc.vfi, progress, signal);
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
        const cached = await this.cache.read(key);
        signal?.throwIfAborted();
        return cached;
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
            console.warn("OPFS movie cache write failed; keeping this session's copy", error);
            this.cache = null;
            this.memory.set(key, bytes);
            return false;
        }
    }
    private async readDiscEntry(entry: VfiEntry, signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        if (!this.vfi)
            throw new Error("this movie is not cached -- reconnect the same disc to prepare it");
        const current = this.vfi.find(entry.path);
        if (!current) throw new Error(`${entry.path} is missing from the attached disc`);
        const bytes = await this.vfi.read(current);
        signal?.throwIfAborted();
        return bytes;
    }

    private async source(entry: MovieEntry, signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        const key = `${movieRoot(entry.name)}/${entry.movie.name}`;
        const cached = await this.cachedRead(key, signal);
        signal?.throwIfAborted();
        if (cached) return cached;
        const source = await this.readDiscEntry(entry.movie, signal);
        signal?.throwIfAborted();
        return source;
    }

    private async subtitles(entry: MovieEntry, signal?: AbortSignal): Promise<SubtitleBundle> {
        signal?.throwIfAborted();
        if (!entry.subtitleBin || !entry.subtitleSbt)
            return EMPTY_SUBTITLES;
        const root = movieRoot(entry.name);
        const binKey = `${root}/${entry.subtitleBin.name}`;
        const sbtKey = `${root}/${entry.subtitleSbt.name}`;
        signal?.throwIfAborted();
        const [cachedBin, cachedSbt] = await Promise.all([
            this.cachedRead(binKey, signal), this.cachedRead(sbtKey, signal),
        ]);
        signal?.throwIfAborted();
        const [bin, sbt] = await Promise.all([
            cachedBin ?? this.readDiscEntry(entry.subtitleBin, signal),
            cachedSbt ?? this.readDiscEntry(entry.subtitleSbt, signal),
        ]);
        signal?.throwIfAborted();
        const cues = parseFmvSubtitles(bin, sbt, entry.name);
        signal?.throwIfAborted();
        return { bin, sbt, cues };
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
        const root = movieRoot(entry.name);
        signal?.throwIfAborted();
        let sourcePersistent = await this.cacheWrite(`${root}/${entry.movie.name}`, source);
        signal?.throwIfAborted();

        if (entry.subtitleBin && subtitles.bin) {
            signal?.throwIfAborted();
            sourcePersistent = await this.cacheWrite(
                `${root}/${entry.subtitleBin.name}`, subtitles.bin) && sourcePersistent;
            signal?.throwIfAborted();
        }
        if (entry.subtitleSbt && subtitles.sbt) {
            signal?.throwIfAborted();
            sourcePersistent = await this.cacheWrite(
                `${root}/${entry.subtitleSbt.name}`, subtitles.sbt) && sourcePersistent;
            signal?.throwIfAborted();
        }
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
            await this.cache?.remove(key);
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
        const sessionCached = this.memory.has(key);
        const cached = await this.cachedRead(key, signal);
        signal?.throwIfAborted();
        if (cached) {
            progress(1, sessionCached
                ? `using session-only ${label}`
                : `using cached ${label}`);
            return cached;
        }

        progress(0.02, `reading ${label} source`);
        const [source, subtitles] = await Promise.all([
            this.source(entry, signal),
            this.subtitles(entry, signal),
        ]);
        signal?.throwIfAborted();

        progress(0.08, "persisting original movie source");
        const root = movieRoot(entry.name);
        let sourcePersistent = await this.cacheWrite(
            `${root}/${entry.movie.name}`, source);
        signal?.throwIfAborted();
        if (entry.subtitleBin && subtitles.bin) {
            sourcePersistent = await this.cacheWrite(
                `${root}/${entry.subtitleBin.name}`, subtitles.bin) && sourcePersistent;
            signal?.throwIfAborted();
        }
        if (entry.subtitleSbt && subtitles.sbt) {
            sourcePersistent = await this.cacheWrite(
                `${root}/${entry.subtitleSbt.name}`, subtitles.sbt) && sourcePersistent;
            signal?.throwIfAborted();
        }
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
        const sourceBytes = await this.totalSize(sourceKeys, signal);
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
        const bytes = await this.cache?.size(key) ?? 0;
        signal?.throwIfAborted();
        return bytes;
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
