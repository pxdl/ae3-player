/* The normative asset set from docs/formats/EXTRACTION.md, located inside a
 * parsed VFI region-tolerantly: the US disc keeps everything under debug/us/,
 * other regions likely move that prefix, so assets are matched by path
 * suffix and the result reports what was actually found. */

import { type ByteSource, BytesSource, SubSource } from "./source.ts";
import { Iso9660, systemCnfSerial } from "./iso9660.ts";
import { Vfi, type VfiEntry, VFI_SECTOR } from "./vfi.ts";
import { inflateSz } from "./sz.ts";
import { unpackPck, memberBytes } from "./pck.ts";
import { parseExdb, bgmSongTable, type Exdb, type BgmSong } from "./exdb.ts";
import { ascii } from "./bytes.ts";

export interface BgmAssetSet {
    bgmDir: string;                    // e.g. "debug/us/sound/bgm"
    hd: VfiEntry[];                    // 62 bank headers on the US disc
    bd: VfiEntry[];                    // 62 bank bodies
    mid: VfiEntry[];                   // 68 sequences
    exdbSoundPck: VfiEntry;            // */static/exdb_sound.pck.sz -> bgm_desc
    soundConfigPck: VfiEntry | null;   // */startup/exdb_common.pck.sz (M8+, cue layer)
    sg2iopm1: VfiEntry | null;         // irx/*/sg2iopm1.irx -- pitch table donor
    libsd: VfiEntry | null;            // irx/*/libsd.irx    -- reverb preset donor
}

export function locateBgmAssets(vfi: Vfi): BgmAssetSet {
    const bgm = vfi.entries.filter(e =>
        /(^|\/)sound\/bgm\/[^/]+\.(hd|bd|mid)$/.test(e.path));
    if (bgm.length === 0)
        throw new Error("no sound/bgm assets found in DATA.BIN");
    /* if several region prefixes ever coexist, take the best-populated one */
    const byDir = new Map<string, VfiEntry[]>();
    for (const e of bgm) {
        const dir = e.path.slice(0, e.path.lastIndexOf("/"));
        (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(e);
    }
    const [bgmDir, inDir] = [...byDir.entries()]
        .sort((a, b) => b[1].length - a[1].length)[0];

    const exdbSoundPck = vfi.entries.find(e =>
        e.path.endsWith("/static/exdb_sound.pck.sz")) ?? null;
    if (!exdbSoundPck)
        throw new Error("static/exdb_sound.pck.sz not found in DATA.BIN");

    return {
        bgmDir,
        hd: inDir.filter(e => e.path.endsWith(".hd")),
        bd: inDir.filter(e => e.path.endsWith(".bd")),
        mid: inDir.filter(e => e.path.endsWith(".mid")),
        exdbSoundPck,
        soundConfigPck: vfi.entries.find(e =>
            e.path.endsWith("/startup/exdb_common.pck.sz")) ?? null,
        sg2iopm1: vfi.entries.find(e =>
            /(^|\/)irx\/[^/]+\/sg2iopm1\.irx$/.test(e.path)) ?? null,
        libsd: vfi.entries.find(e =>
            /(^|\/)irx\/[^/]+\/libsd\.irx$/.test(e.path)) ?? null,
    };
}

/** Pull one named member out of a .pck.sz entry. */
export async function readPckMember(vfi: Vfi, e: VfiEntry,
                                    member: string): Promise<Uint8Array> {
    const blob = await inflateSz(await vfi.read(e));
    const members = unpackPck(blob);
    if (!members) throw new Error(`${e.path}: not a PCK after inflate`);
    const m = members.find(m => m.name === member);
    if (!m) throw new Error(`${e.path}: no member named ${member}`);
    return memberBytes(blob, m);
}

/** exdb_sound.pck.sz -> PCK -> bgm_desc.exdb -> parsed BgmDesc table. */
export async function loadBgmDesc(vfi: Vfi, assets: BgmAssetSet): Promise<Exdb> {
    const db = parseExdb(await readPckMember(vfi, assets.exdbSoundPck, "bgm_desc.exdb"));
    if (db.name !== "BgmDesc")
        throw new Error(`bgm_desc.exdb: expected schema BgmDesc, got ${db.name}`);
    return db;
}

/* ---- magic sniffing (vfiextract MAGICS; order matters: the I3D_ sub-tags
 * before the bare prefix, which only catches new sub-tags) ---------------- */
const MAGICS: Array<[string, string]> = [
    ["MThd", "midi"], ["\x7fELF", "irx"], ["SShd", "sndbank"], ["EXST", "stream"],
    ["VFI\0", "vfi"], ["TIM2", "texture"], ["PCK\0", "pck"],
    ["I3D_BIN\0", "model"], ["I3D_I3M\0", "anim"], ["I3D_I3C\0", "collision"],
    ["I3D_", "i3d_unknown"],
];

export function sniff(b: Uint8Array): string {
    const head = ascii(b.subarray(0, 8));
    for (const [magic, kind] of MAGICS)
        if (head.startsWith(magic)) return kind;
    return "?";
}

/* ---- the one-call entry point ------------------------------------------- */

export interface Ae3Disc {
    iso: Iso9660;
    serial: string | null;     // from SYSTEM.CNF BOOT2 (SCUS_975.01 on US)
    volumeId: string;
    dataBin: ByteSource;
    vfi: Vfi;
    assets: BgmAssetSet;
    bgmDesc: Exdb;
    songs: BgmSong[];
    cacheKey: string;          // serial + DATA.BIN size + table-region hash
}

/** ISO -> ISO9660 -> DATA.BIN -> VFI -> located assets + parsed BgmDesc.
 *  Everything runs on the caller's machine; nothing is uploaded anywhere. */
export async function openDisc(src: ByteSource): Promise<Ae3Disc> {
    const iso = await Iso9660.open(src);

    let serial: string | null = null;
    const cnf = await iso.findRoot("SYSTEM.CNF");
    if (cnf) serial = systemCnfSerial(ascii(await iso.window(cnf).read(0, cnf.size)));

    const ent = await iso.findRoot("DATA.BIN");
    if (!ent)
        throw new Error("DATA.BIN not found on this disc (not Ape Escape 3?)");
    const dataBin = iso.window(ent);

    const vfi = await Vfi.open(dataBin);
    const assets = locateBgmAssets(vfi);
    const bgmDesc = await loadBgmDesc(vfi, assets);

    /* cache key: identifies the disc without hashing 2.1 GB -- the VFI table
     * region (all entry names/offsets/sizes, 129 KB) stands in for content */
    const table = await dataBin.read(0, Math.min(vfi.dataOff * VFI_SECTOR, dataBin.size));
    const digest = await crypto.subtle.digest("SHA-256",
        table.slice().buffer as ArrayBuffer);
    const hex = [...new Uint8Array(digest)].slice(0, 8)
        .map(x => x.toString(16).padStart(2, "0")).join("");
    const cacheKey = `${serial ?? "unknown"}-${dataBin.size}-${hex}`;

    return { iso, serial, volumeId: iso.volumeId, dataBin, vfi, assets,
             bgmDesc, songs: bgmSongTable(bgmDesc), cacheKey };
}

/* re-exported so a consumer holding an Ae3Disc can window raw entries */
export { BytesSource, SubSource };
