/* Disc session: ISO -> @ae3/extract openDisc() -> assets in OPFS.
 *
 * First visit: the user points at their .iso, the BGM asset set (~50 MB:
 * banks, sequences, the two IRX donors, the mastering DB's song table) is
 * extracted CLIENT-SIDE into origin-private storage keyed per disc, and a
 * meta.json completeness marker is written LAST. Later visits resume from
 * OPFS via localStorage's last-disc pointer -- no ISO needed. "Forget my disc"
 * wipes both.
 *
 * Without OPFS (or if the user declines persistence) the session still works,
 * reading straight from the ISO File for this visit only. */

import { openDisc, BlobSource, OpfsCache,
         type BgmSong, type VfiEntry } from "./vendor/extract/index.ts";
import { StreamStore } from "./streams.ts";
import { SeStore } from "./se.ts";
import { MovieStore } from "./movies.ts";
import { ImageStore } from "./images.ts";
import { ModelStore } from "./models.ts";
import type { SongAssets } from "./player.ts";

export const LAST_DISC_KEY = "ae3.lastDisc";
const META = "meta.json";

/** The disc every gate runs against; anything else is best-effort (§4.6). */
export const US_SERIAL = "SCUS_975.01";

/** Human-readable form of open/read failures for the picker + status line. */
export function friendlyError(e: unknown): string {
    if (e instanceof DOMException
        && (e.name === "NotReadableError" || e.name === "NotFoundError"))
        return "the ISO file could not be read -- if it is on a removable "
             + "drive or was moved, reconnect it and choose it again";
    const msg = e instanceof Error ? e.message : String(e);
    if (/short read/.test(msg))
        return `${msg} -- the image ends too early; the ISO file looks `
             + "truncated or partially copied";
    if (/ in DATA\.BIN/.test(msg))
        return `${msg} -- the disc was read but its layout is unrecognized `
             + "(non-US discs are untested; please report your disc serial)";
    return msg;
}

interface Meta {
    v: 1;
    serial: string | null;
    volumeId: string;
    songs: BgmSong[];
    hasIrx: boolean;
    hasLibsd: boolean;
}

export interface DiscSession {
    songs: BgmSong[];
    serial: string | null;
    volumeId: string;
    cached: boolean;                       /* true = OPFS-backed, ISO-free */
    streams: StreamStore;                  /* sound/stream phase (STREAMS tab) */
    se: SeStore;                            /* lazy sound/se phase (SE tab) */
    movies: MovieStore;                    /* lazy per-movie FMV phase */
    images: ImageStore;                    /* lazy TIM2 image/sprite phase */
    models: ModelStore;                        /* lazy I3D model/animation/collision phase */
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

/** Resume the previous disc from OPFS; null = nothing cached (show picker). */
export async function resumeSession(): Promise<DiscSession | null> {
    const last = localStorage.getItem(LAST_DISC_KEY);
    if (!last || !OpfsCache.supported()) return null;
    try {
        const cache = await OpfsCache.open(last);
        const metaRaw = await cache.read(META);
        if (!metaRaw) return null;
        const meta = JSON.parse(new TextDecoder().decode(metaRaw)) as Meta;
        if (meta.v !== 1 || !Array.isArray(meta.songs)) return null;
        const session: DiscSession = {
            songs: meta.songs,
            serial: meta.serial,
            volumeId: meta.volumeId,
            cached: true,
            streams: new StreamStore(cache, null, last),
            se: new SeStore(cache, null, last),
            movies: new MovieStore(cache, null, last),
            images: new ImageStore(cache, null, last),
            models: new ModelStore(cache, null, last),
            read: (n) => cache.read(n),
            songAssets: (song) =>
                assetsFor(session, song, meta.hasIrx, meta.hasLibsd),
            forget: async () => {
                localStorage.removeItem(LAST_DISC_KEY);
                await cache.forget();
            },
        };
        return session;
    } catch {
        return null;    /* stale/corrupt cache: fall back to the picker */
    }
}

export type Progress = (done: number, total: number, name: string) => void;

/** Open an ISO, extract the BGM asset set into OPFS (with progress), return
 *  the session. Extraction failures fall back to reading from the File. */
export async function openIso(file: File, progress: Progress): Promise<DiscSession> {
    const disc = await openDisc(new BlobSource(file));
    const cacheName = (e: VfiEntry) => `bgm/${e.path.slice(e.path.lastIndexOf("/") + 1)}`;
    const jobs: Array<[string, VfiEntry]> = [
        ...disc.assets.hd.map((e): [string, VfiEntry] => [cacheName(e), e]),
        ...disc.assets.bd.map((e): [string, VfiEntry] => [cacheName(e), e]),
        ...disc.assets.mid.map((e): [string, VfiEntry] => [cacheName(e), e]),
    ];
    if (disc.assets.sg2iopm1) jobs.push(["irx/sg2iopm1.irx", disc.assets.sg2iopm1]);
    if (disc.assets.libsd) jobs.push(["irx/libsd.irx", disc.assets.libsd]);

    /* Keep the viewer data-free while still letting its visual language come
     * from the game: cache three small UI packages verbatim from the user's
     * disc. The viewer decodes selected TIM2 members at runtime. Missing
     * packages are soft for untested regions and old OPFS sessions. */
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

    const meta: Meta = {
        v: 1, serial: disc.serial, volumeId: disc.volumeId, songs: disc.songs,
        hasIrx: disc.assets.sg2iopm1 !== null,
        hasLibsd: disc.assets.libsd !== null,
    };

    /* Cache (OPFS) failures are soft -- the session falls back to reading the
     * ISO File directly. ISO READ failures are hard: they abort the open with
     * the real error (unplugged drive, truncated image), and the partial
     * cache is safe to leave behind -- meta.json lands LAST, so an incomplete
     * extraction never resumes as a session, and the next attempt's has()
     * check skips everything already extracted. */
    let cache: OpfsCache | null = null;
    if (OpfsCache.supported()) {
        try {
            cache = await OpfsCache.open(disc.cacheKey);
        } catch (e) {
            console.warn("OPFS unavailable; playing from the ISO", e);
        }
    }
    for (let i = 0; i < jobs.length && cache; i++) {
        const [name, entry] = jobs[i]!;
        progress(i, jobs.length, name);
        try {
            if (await cache.has(name)) continue;
        } catch (e) {
            console.warn("OPFS failed; playing from the ISO", e);
            cache = null;
            break;
        }
        const data = await disc.vfi.read(entry);        /* hard failure */
        try {
            await cache.write(name, data);
        } catch (e) {
            console.warn("OPFS write failed; playing from the ISO", e);
            cache = null;
        }
    }
    if (cache) {
        try {
            await cache.write(META,
                new TextEncoder().encode(JSON.stringify(meta)));
            localStorage.setItem(LAST_DISC_KEY, disc.cacheKey);
            progress(jobs.length, jobs.length, "done");
        } catch (e) {
            console.warn("OPFS write failed; playing from the ISO", e);
            cache = null;
        }
    }

    const byName = new Map(jobs.map(([n, e]) => [n, e]));
    const session: DiscSession = {
        songs: disc.songs,
        serial: disc.serial,
        volumeId: disc.volumeId,
        cached: cache !== null,
        streams: new StreamStore(cache, disc.vfi, disc.cacheKey),
        se: new SeStore(cache, disc.vfi, disc.cacheKey),
        movies: new MovieStore(cache, disc.vfi, disc.cacheKey),
        images: new ImageStore(cache, disc.vfi, disc.cacheKey),
        models: new ModelStore(cache, disc.vfi, disc.cacheKey),
        read: async (n) => {
            if (cache) {
                const b = await cache.read(n);
                if (b) return b;
            }
            const e = byName.get(n);
            return e ? disc.vfi.read(e) : null;
        },
        songAssets: (song) =>
            assetsFor(session, song, meta.hasIrx, meta.hasLibsd),
        forget: async () => {
            localStorage.removeItem(LAST_DISC_KEY);
            await cache?.forget();
        },
    };
    await session.movies.catalog();
    return session;
}
