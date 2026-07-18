/* Disc session: ISO -> @ae3/extract openDisc() -> assets in OPFS.
 *
 * First visit: the user points at their .iso, the BGM asset set (~50 MB:
 * banks, sequences, the two IRX donors, the mastering DB's song table) is
 * extracted CLIENT-SIDE into origin-private storage keyed per disc, and a
 * meta.json completeness marker is written LAST. Later visits resume from
 * OPFS via localStorage's last-disc pointer -- no ISO needed. "Forget my
 * disc" wipes both (WEB_PORT_PLAN §4.5).
 *
 * Without OPFS (or if the user declines persistence) the session still works,
 * reading straight from the ISO File for this visit only. */

import { openDisc, BlobSource, OpfsCache,
         type BgmSong, type VfiEntry } from "./vendor/extract/index.ts";
import type { SongAssets } from "./player.ts";

const LAST_KEY = "ae3.lastDisc";
const META = "meta.json";

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
    const last = localStorage.getItem(LAST_KEY);
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
            read: (n) => cache.read(n),
            songAssets: (song) =>
                assetsFor(session, song, meta.hasIrx, meta.hasLibsd),
            forget: async () => {
                localStorage.removeItem(LAST_KEY);
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

    const meta: Meta = {
        v: 1, serial: disc.serial, volumeId: disc.volumeId, songs: disc.songs,
        hasIrx: disc.assets.sg2iopm1 !== null,
        hasLibsd: disc.assets.libsd !== null,
    };

    let cache: OpfsCache | null = null;
    if (OpfsCache.supported()) {
        try {
            cache = await OpfsCache.open(disc.cacheKey);
            for (let i = 0; i < jobs.length; i++) {
                const [name, entry] = jobs[i]!;
                progress(i, jobs.length, name);
                if (!(await cache.has(name)))
                    await cache.write(name, await disc.vfi.read(entry));
            }
            await cache.write(META,
                new TextEncoder().encode(JSON.stringify(meta)));
            progress(jobs.length, jobs.length, "done");
            localStorage.setItem(LAST_KEY, disc.cacheKey);
        } catch (e) {
            console.warn("OPFS extraction failed; playing from the ISO", e);
            cache = null;
        }
    }

    const byName = new Map(jobs.map(([n, e]) => [n, e]));
    const session: DiscSession = {
        songs: disc.songs,
        serial: disc.serial,
        volumeId: disc.volumeId,
        cached: cache !== null,
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
            localStorage.removeItem(LAST_KEY);
            await cache?.forget();
        },
    };
    return session;
}
