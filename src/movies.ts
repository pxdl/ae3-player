import {
    BlobSource, OpfsCache, openDisc, locateFmvAssets, inspectFmvAsset, demuxFmv,
    parseFmvSubtitles, subtitlesToSrt, subtitlesToVtt,
    type FmvAsset, type FmvDemux, type FmvHeader, type FmvVideoInfo,
    type SubtitleCue, type Vfi, type VfiEntry,
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
    playbackBytes: number;
    captionBytes: number;
    exportBytes: number;
    totalBytes: number;
}

interface SubtitleBundle {
    bin: Uint8Array | null;
    sbt: Uint8Array | null;
    cues: SubtitleCue[];
}

export type MovieExportKind = "original" | "masters" | MovieOutputFormat;

export interface MovieExport {
    filename: string;
    bytes: Uint8Array;
    mime: string;
}

export interface PreparedMovie {
    mp4: Uint8Array;
    vtt: string | null;
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

async function subtitleData(vfi: Vfi, asset: FmvAsset): Promise<SubtitleBundle> {
    if (!asset.subtitleBin || !asset.subtitleSbt)
        return { cues: [], bin: null, sbt: null };
    const [bin, sbt] = await Promise.all([
        vfi.read(asset.subtitleBin), vfi.read(asset.subtitleSbt),
    ]);
    return {
        cues: parseFmvSubtitles(bin, sbt, asset.name),
        bin,
        sbt,
    };
}

export async function scanMovieCatalog(vfi: Vfi,
                                       progress?: MovieProgress): Promise<MovieCatalog> {
    const assets = locateFmvAssets(vfi);
    const entries: MovieEntry[] = [];
    for (let index = 0; index < assets.length; index++) {
        const asset = assets[index]!;
        progress?.(index / assets.length, `scanning ${asset.name}`);
        const [{ header, videoInfo }, subtitles] = await Promise.all([
            inspectFmvAsset(vfi, asset.movie),
            subtitleData(vfi, asset),
        ]);
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

    async catalog(): Promise<MovieCatalog | null> {
        if (this.catalogValue) return this.catalogValue;
        if (this.cache) {
            const raw = await this.cache.read(META);
            if (raw) {
                try {
                    const parsed: unknown = JSON.parse(textDecoder.decode(raw));
                    if (validCatalog(parsed)) {
                        this.catalogValue = parsed;
                        return parsed;
                    }
                } catch {
                    // A malformed marker is treated as absent; reattaching the disc rebuilds it.
                }
            }
        }
        if (!this.vfi) return null;
        this.catalogValue = await scanMovieCatalog(this.vfi);
        await this.persistCatalog();
        return this.catalogValue;
    }

    async persistCatalog(): Promise<void> {
        if (!this.cache || !this.catalogValue) return;
        try {
            await this.cache.write(META,
                textEncoder.encode(JSON.stringify(this.catalogValue)));
        } catch (error) {
            console.warn("OPFS movie catalog write failed; using the attached ISO", error);
            this.cache = null;
        }
    }

    async attachIso(file: File, progress?: MovieProgress): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        if (this.cacheKey && disc.cacheKey !== this.cacheKey)
            throw new Error("this ISO is a different disc than the cached one -- forget the disc first to switch");
        this.vfi = disc.vfi;
        this.catalogValue = await scanMovieCatalog(disc.vfi, progress);
        await this.persistCatalog();
    }

    private async entry(name: string): Promise<MovieEntry> {
        const catalog = await this.catalog();
        const entry = catalog?.entries.find(candidate => candidate.name === name);
        if (!entry) throw new Error(`movie ${name} is not in this disc catalog`);
        return entry;
    }

    private async cachedRead(key: string): Promise<Uint8Array | null> {
        const memory = this.memory.get(key);
        if (memory) return memory;
        return this.cache?.read(key) ?? null;
    }

    private async cacheWrite(key: string, bytes: Uint8Array): Promise<void> {
        if (!this.cache) {
            this.memory.set(key, bytes);
            return;
        }
        try {
            await this.cache.write(key, bytes);
        } catch (error) {
            console.warn("OPFS movie cache write failed; keeping this session's copy", error);
            this.cache = null;
            this.memory.set(key, bytes);
        }
    }
    private async readDiscEntry(entry: VfiEntry): Promise<Uint8Array> {
        if (!this.vfi)
            throw new Error("this movie is not cached -- reconnect the same disc to prepare it");
        const current = this.vfi.find(entry.path);
        if (!current) throw new Error(`${entry.path} is missing from the attached disc`);
        return this.vfi.read(current);
    }

    private async source(entry: MovieEntry): Promise<Uint8Array> {
        const key = `${movieRoot(entry.name)}/${entry.movie.name}`;
        return await this.cachedRead(key) ?? await this.readDiscEntry(entry.movie);
    }

    private async subtitles(entry: MovieEntry): Promise<SubtitleBundle> {
        if (!entry.subtitleBin || !entry.subtitleSbt)
            return { bin: null, sbt: null, cues: [] };
        const root = movieRoot(entry.name);
        const binKey = `${root}/${entry.subtitleBin.name}`;
        const sbtKey = `${root}/${entry.subtitleSbt.name}`;
        const [cachedBin, cachedSbt] = await Promise.all([
            this.cachedRead(binKey), this.cachedRead(sbtKey),
        ]);
        const [bin, sbt] = await Promise.all([
            cachedBin ?? this.readDiscEntry(entry.subtitleBin),
            cachedSbt ?? this.readDiscEntry(entry.subtitleSbt),
        ]);
        return { bin, sbt, cues: parseFmvSubtitles(bin, sbt, entry.name) };
    }

    private async demux(entry: MovieEntry, progress: MovieProgress): Promise<{
        demuxed: FmvDemux; subtitles: SubtitleBundle;
    }> {
        progress(0.02, "reading selected movie");
        const [source, subtitles] = await Promise.all([
            this.source(entry), this.subtitles(entry),
        ]);
        progress(0.08, "validating and demuxing");
        const demuxed = demuxFmv(source, entry.name);
        const root = movieRoot(entry.name);
        await this.cacheWrite(`${root}/${entry.movie.name}`, source);
        if (entry.subtitleBin && subtitles.bin)
            await this.cacheWrite(`${root}/${entry.subtitleBin.name}`, subtitles.bin);
        if (entry.subtitleSbt && subtitles.sbt)
            await this.cacheWrite(`${root}/${entry.subtitleSbt.name}`, subtitles.sbt);
        return { demuxed, subtitles };
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
        const embeddedCaptions = format !== "webm" && captions;
        const key = format === "mp4" && !embeddedCaptions
            ? `${movieRoot(entry.name)}/playback.mp4`
            : exportKey(entry.name, format, embeddedCaptions);
        const cached = await this.cachedRead(key);
        if (cached) {
            progress(1, "using cached conversion");
            return cached;
        }
        const { demuxed, subtitles } = await this.demux(entry, progress);
        // Deliberate lazy boundary: this chunk pulls in the 30 MiB GPL FFmpeg core.
        const converter = await import("./movie-converter.ts");
        const converted = await converter.convertMovie(
            this.conversionInput(demuxed, subtitles.cues, captions), format,
            (value, stage) => progress(0.1 + value * 0.9, stage), signal);
        await this.cacheWrite(key, converted);
        return converted;
    }

    async prepare(name: string, progress: MovieProgress,
                  signal?: AbortSignal): Promise<PreparedMovie> {
        const entry = await this.entry(name);
        const mp4 = await this.convert(entry, "mp4", false, progress, signal);
        let vtt: string | null = null;
        if (entry.subtitleCues > 0) {
            const key = `${movieRoot(name)}/captions.vtt`;
            const cached = await this.cachedRead(key);
            if (cached) vtt = textDecoder.decode(cached);
            else {
                const subtitle = await this.subtitles(entry);
                const bytes = subtitlesToVtt(subtitle.cues);
                vtt = textDecoder.decode(bytes);
                await this.cacheWrite(key, bytes);
            }
        }
        return { mp4, vtt, cache: await this.cacheInfo(name) };
    }

    async cacheInfo(name: string): Promise<MovieCacheInfo> {
        const root = movieRoot(name);
        const entry = await this.entry(name);
        const sourceNames = [entry.movie.name, entry.subtitleBin?.name, entry.subtitleSbt?.name]
            .filter((value): value is string => !!value);
        const sourceBytes = await this.totalSize(sourceNames.map(value => `${root}/${value}`));
        const playbackBytes = await this.size(`${root}/playback.mp4`);
        const captionBytes = await this.size(`${root}/captions.vtt`);
        const exports = MOVIE_OUTPUT_FORMATS.flatMap(format =>
            [false, true].map(captions => exportKey(name, format, captions)));
        const exportBytes = await this.totalSize(exports);
        return {
            sourceBytes,
            playbackBytes,
            captionBytes,
            exportBytes,
            totalBytes: sourceBytes + playbackBytes + captionBytes + exportBytes,
        };
    }

    private async size(key: string): Promise<number> {
        const memory = this.memory.get(key);
        if (memory) return memory.byteLength;
        return await this.cache?.size(key) ?? 0;
    }

    private async totalSize(keys: readonly string[]): Promise<number> {
        const values = await Promise.all(keys.map(key => this.size(key)));
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
        const entry = await this.entry(name);
        if (kind === "original") {
            const [source, subtitles] = await Promise.all([
                this.source(entry), this.subtitles(entry),
            ]);
            const files: Array<[string, Uint8Array]> = [[entry.movie.name, source]];
            if (entry.subtitleBin && subtitles.bin) files.push([entry.subtitleBin.name, subtitles.bin]);
            if (entry.subtitleSbt && subtitles.sbt) files.push([entry.subtitleSbt.name, subtitles.sbt]);
            progress(1, "original archive ready");
            return { filename: `${name}-original.zip`, bytes: storeZip(files), mime: "application/zip" };
        }
        if (kind === "masters") {
            const { demuxed, subtitles } = await this.demux(entry, progress);
            const files: Array<[string, Uint8Array]> = [
                [`${name}.m2v`, demuxed.video], [`${name}.wav`, demuxed.wav],
            ];
            if (subtitles.cues.length)
                files.push([`${name}.srt`, subtitlesToSrt(subtitles.cues)]);
            progress(1, "master archive ready");
            return { filename: `${name}-masters.zip`, bytes: storeZip(files), mime: "application/zip" };
        }
        const converted = await this.convert(entry, kind, captions, progress, signal);
        if (kind === "webm" && entry.subtitleCues > 0) {
            const subtitles = await this.subtitles(entry);
            const vtt = subtitlesToVtt(subtitles.cues);
            return {
                filename: `${name}-webm.zip`,
                bytes: storeZip([[`${name}.webm`, converted], [`${name}.vtt`, vtt]]),
                mime: "application/zip",
            };
        }
        return {
            filename: `${name}.${kind}`,
            bytes: converted,
            mime: movieMime(kind),
        };
    }
}
