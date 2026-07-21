import {
    BlobSource, OpfsCache, openDisc, locateFmvAssets, inspectFmvAsset, demuxFmv,
    indexMpeg2SeekPoints, parseFmvSubtitles, subtitlesToSrt, subtitlesToVtt,
    type FmvAsset, type FmvDemux, type FmvHeader, type FmvVideoInfo,
    type Mpeg2SeekIndex, type SubtitleCue, type Vfi, type VfiEntry,
} from "./vendor/extract/index.ts";
import { storeZip } from "./zip.ts";
import type { MovieConversionInput, MovieOutputFormat } from "./movie-converter.ts";

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
const MOVIE_OUTPUT_FORMATS: readonly MovieOutputFormat[] = ["mkv", "mp4", "webm"];

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

export type MovieExportKind = "original" | "masters" | MovieOutputFormat;

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

function exportKey(name: string, format: MovieOutputFormat, captions: boolean): string {
    return `${movieRoot(name)}/export-${format}-${captions ? "captions" : "plain"}.${format}`;
}

function movieMime(format: MovieOutputFormat): string {
    switch (format) {
    case "mkv": return "video/x-matroska";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    }
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

    private async removeLegacyWatch(name: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const key = `${movieRoot(name)}/playback.mp4`;
        this.memory.delete(key);
        await this.cache?.remove(key);
        signal?.throwIfAborted();
    }

    private conversionInput(demuxed: FmvDemux, cues: readonly SubtitleCue[],
                            captions: boolean): MovieConversionInput {
        return {
            video: demuxed.video,
            wav: demuxed.wav,
            videoInfo: demuxed.videoInfo,
            subtitleSrt: cues.length ? subtitlesToSrt(cues) : undefined,
            embedCaptions: captions && cues.length > 0,
        };
    }

    private async convert(entry: MovieEntry, format: MovieOutputFormat,
                          captions: boolean, progress: MovieProgress,
                          signal?: AbortSignal): Promise<Uint8Array> {
        signal?.throwIfAborted();
        const embeddedCaptions = format !== "webm" && captions;
        const key = exportKey(entry.name, format, embeddedCaptions);
        const sessionCached = this.memory.has(key);
        signal?.throwIfAborted();
        const cached = await this.cachedRead(key, signal);
        signal?.throwIfAborted();
        if (cached) {
            progress(1, sessionCached
                ? "using session-only conversion"
                : "using cached conversion");
            return cached;
        }
        signal?.throwIfAborted();
        const { demuxed, subtitles } = await this.demux(entry, progress, signal);
        signal?.throwIfAborted();
        // The import keeps converter code out of playback; conversion then loads the 32.2 MiB GPL core.
        progress(0.1, "loading conversion engine");
        signal?.throwIfAborted();
        const converter = await import("./movie-converter.ts");
        signal?.throwIfAborted();
        const converted = await converter.convertMovie(
            this.conversionInput(demuxed, subtitles.cues, captions), format,
            (value, stage) => progress(0.1 + value * 0.9, stage), signal);
        signal?.throwIfAborted();
        const persistent = await this.cacheWrite(key, converted);
        signal?.throwIfAborted();
        if (!persistent)
            progress(1, "conversion ready; export cache is session-only");
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
        await this.removeLegacyWatch(entry.name, signal);
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
        const exportKeys: string[] = [];
        for (const format of MOVIE_OUTPUT_FORMATS) {
            exportKeys.push(
                exportKey(name, format, false),
                exportKey(name, format, true),
            );
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
        const converted = await this.convert(
            entry, kind, captions, progress, signal);
        signal?.throwIfAborted();
        if (kind === "webm" && entry.subtitleCues > 0) {
            signal?.throwIfAborted();
            const subtitles = await this.subtitles(entry, signal);
            signal?.throwIfAborted();
            const vtt = subtitlesToVtt(subtitles.cues);
            signal?.throwIfAborted();
            const bytes = storeZip([[`${name}.webm`, converted], [`${name}.vtt`, vtt]]);
            signal?.throwIfAborted();
            return {
                filename: `${name}-webm.zip`,
                bytes,
                mime: "application/zip",
            };
        }
        signal?.throwIfAborted();
        return {
            filename: `${name}.${kind}`,
            bytes: converted,
            mime: movieMime(kind),
        };
    }
}
