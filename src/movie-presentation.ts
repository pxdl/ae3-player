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
    if (entry.video.fieldOrder === "progressive")
        return detailed ? "Progressive · 29.97 fps" : "29.97p";
    const topFieldFirst = entry.video.fieldOrder === "tt";
    if (detailed)
        return `${topFieldFirst ? "Top" : "Bottom"} field first · bobbed to 59.94 fps`;
    return `59.94p · source ${topFieldFirst ? "TFF" : "BFF"}`;
}

export function movieSourceComplete(entry: MovieEntry, cache: MovieCacheInfo): boolean {
    const sourceBytes = entry.movie.size
        + (entry.subtitleBin?.size ?? 0)
        + (entry.subtitleSbt?.size ?? 0);
    return cache.sourceBytes >= sourceBytes;
}
