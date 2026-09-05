import type { MovieCacheInfo, MovieEntry } from "./movies.ts";

export function formatMovieBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function movieGroupLabel(entry: MovieEntry): string {
    switch (entry.group) {
    case "opening": return "Station IDs & openings";
    case "story": return "Story scenes";
    case "gameplay": return "Gameplay reels";
    }
}

export function movieScanLabel(entry: MovieEntry, detailed: boolean): string {
    const rate = entry.video.frameRate;
    const format = (value: number): string => Number(value.toFixed(2)).toString();
    if (entry.video.fieldOrder === "progressive")
        return detailed ? `Progressive · ${format(rate)} fps` : `${format(rate)}p`;
    const topFieldFirst = entry.video.fieldOrder === "tt";
    if (detailed)
        return `${topFieldFirst ? "Top" : "Bottom"} field first · bobbed to ${format(rate * 2)} fps`;
    return `${format(rate * 2)}p · source ${topFieldFirst ? "TFF" : "BFF"}`;
}

export function movieSourceComplete(entry: MovieEntry, cache: MovieCacheInfo): boolean {
    const sourceBytes = entry.movie.size + entry.subtitleBytes;
    return cache.sourceBytes >= sourceBytes;
}
