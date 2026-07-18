/* Minimal ISO9660 reader -- just enough to find DATA.BIN and SYSTEM.CNF on a
 * plain 2048-byte-sector PS2 disc image. Raw/2352 dumps, CHD/CSO/bin+cue are
 * out of scope by decision (plan §9.6); they fail the PVD check with a clear
 * error. DATA.BIN (2.1 GB) fits a single extent; multi-extent files are not
 * handled. */

import { type ByteSource, SubSource } from "./source.ts";
import { ascii, u16, u32 } from "./bytes.ts";

export const ISO_SECTOR = 2048;

export interface IsoDirent {
    name: string;          // identifier, ";1" version suffix stripped
    lba: number;
    size: number;
    isDir: boolean;
}

export class Iso9660 {
    readonly src: ByteSource;
    readonly volumeId: string;
    readonly root: IsoDirent;

    private constructor(src: ByteSource, volumeId: string, root: IsoDirent) {
        this.src = src;
        this.volumeId = volumeId;
        this.root = root;
    }

    static async open(src: ByteSource): Promise<Iso9660> {
        for (let sector = 16; sector < 32; sector++) {
            const d = await src.read(sector * ISO_SECTOR, ISO_SECTOR);
            if (d.length < ISO_SECTOR || ascii(d.subarray(1, 6)) !== "CD001")
                break;
            const type = d[0];
            if (type === 255) break;                      // set terminator
            if (type !== 1) continue;                     // boot/supplementary
            const lbs = u16(d, 128);
            if (lbs !== ISO_SECTOR)
                throw new Error(`unsupported ISO9660 logical block size ${lbs}`);
            const root = parseDirent(d, 156);
            if (!root || !root.ent.isDir)
                throw new Error("bad root directory record in PVD");
            return new Iso9660(src, ascii(d.subarray(40, 72)).trimEnd(), root.ent);
        }
        throw new Error("no ISO9660 primary volume descriptor "
                        + "(a plain .iso is required; CHD/CSO/bin+cue are not supported)");
    }

    async readDir(dir?: IsoDirent): Promise<IsoDirent[]> {
        const d = dir ?? this.root;
        const data = await this.src.read(d.lba * ISO_SECTOR, d.size);
        const out: IsoDirent[] = [];
        let off = 0;
        while (off < data.length) {
            if (data[off] === 0) {
                /* records never span a sector; a zero length byte means
                 * padding to the next sector boundary */
                off = (Math.floor(off / ISO_SECTOR) + 1) * ISO_SECTOR;
                continue;
            }
            const r = parseDirent(data, off);
            if (!r) break;
            if (r.ent.name !== "\u0000" && r.ent.name !== "\u0001")  // "." / ".."
                out.push(r.ent);
            off += r.len;
        }
        return out;
    }

    /** Case-insensitive lookup in the root directory. */
    async findRoot(name: string): Promise<IsoDirent | null> {
        const want = name.toUpperCase();
        for (const e of await this.readDir())
            if (e.name.toUpperCase() === want) return e;
        return null;
    }

    /** A ByteSource windowed onto one file's extent. */
    window(e: IsoDirent): ByteSource {
        return new SubSource(this.src, e.lba * ISO_SECTOR, e.size);
    }
}

function parseDirent(d: Uint8Array, off: number): { ent: IsoDirent; len: number } | null {
    const len = d[off];
    if (!len || off + len > d.length) return null;
    const nameLen = d[off + 32];
    let name = ascii(d.subarray(off + 33, off + 33 + nameLen));
    const semi = name.indexOf(";");
    if (semi >= 0) name = name.slice(0, semi);
    return {
        ent: {
            name,
            lba: u32(d, off + 2),
            size: u32(d, off + 10),
            isDir: (d[off + 25] & 2) !== 0,
        },
        len,
    };
}

/** "BOOT2 = cdrom0:\SCUS_975.01;1" -> "SCUS_975.01" (null if absent). */
export function systemCnfSerial(text: string): string | null {
    const m = /BOOT2\s*=\s*cdrom0:\\?([^;\r\n]+)/.exec(text);
    return m ? m[1].trim() : null;
}
