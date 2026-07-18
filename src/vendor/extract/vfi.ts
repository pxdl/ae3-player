/* DATA.BIN (VFI) container reader -- a TypeScript port of the reference
 * parser tools/ae3tools/vfiparse.py; docs/formats/DATA_BIN.md is the spec.
 * Layout was established twice independently (the game's own MIPS reader +
 * aluigi's BMS) and verified empirically; keep the walk semantics identical
 * to the Python oracle -- the private differ compares the two byte-for-byte.
 *
 * The entire table region (everything before DATA_OFF; 129 KB in DATA.BIN) is
 * read in one shot and parsed in memory; file payloads stream on demand. */

import { type ByteSource } from "./source.ts";
import { cstr, u16, u32 } from "./bytes.ts";

export const VFI_MAGIC = 0x00494656;   // 'VFI\0'
export const VFI_SECTOR = 0x800;

export interface VfiEntry {
    entryOff: number;
    entrySize: number;
    parentOff: number;
    sector: number;        // byte offset = sector * VFI_SECTOR
    size: number;
    name: string;
    path: string;          // full path, folder chain prepended
}

export class Vfi {
    readonly src: ByteSource;
    readonly version: number;
    readonly dataOff: number;
    readonly files: number;
    readonly folders: number;
    readonly infoOff: number;
    readonly infoEnd: number;
    readonly foldersOff: number;
    readonly entries: VfiEntry[];

    private constructor(src: ByteSource, version: number, dataOff: number,
                        files: number, folders: number, infoOff: number,
                        infoEnd: number, foldersOff: number, entries: VfiEntry[]) {
        this.src = src;
        this.version = version;
        this.dataOff = dataOff;
        this.files = files;
        this.folders = folders;
        this.infoOff = infoOff;
        this.infoEnd = infoEnd;
        this.foldersOff = foldersOff;
        this.entries = entries;
    }

    static async open(src: ByteSource): Promise<Vfi> {
        const hdr = await src.read(0, 0x20);
        if (hdr.length < 0x20 || u32(hdr, 0) !== VFI_MAGIC)
            throw new Error(`bad VFI magic 0x${u32(hdr, 0).toString(16)} `
                            + "(not an Ape Escape 3 DATA.BIN?)");
        const version = u32(hdr, 4);
        const dataOff = u32(hdr, 8);
        /* every table lives before the data region */
        const t = await src.read(0, Math.min(dataOff * VFI_SECTOR, src.size));
        const files = u16(t, 0x10);
        const folders = u16(t, 0x12);
        const infoOff = u32(t, 0x14);
        const infoEnd = u32(t, 0x1c);

        /* walk FILES variable-length records from INFO_OFF */
        const raw: Omit<VfiEntry, "path">[] = [];
        let off = infoOff;
        for (let i = 0; i < files; i++) {
            if (off + 12 > t.length) break;
            const entrySize = u16(t, off);
            const parentOff = u16(t, off + 2);
            if (entrySize < 12) break;
            raw.push({
                entryOff: off, entrySize, parentOff,
                sector: u32(t, off + 4), size: u32(t, off + 8),
                name: cstr(t.subarray(off + 12, off + entrySize)),
            });
            off += entrySize;
        }
        const foldersOff = off;    // end of the file entry table

        /* folder record: [u16 ENTRY_SIZE][u16 NEXT_OFF][u16 PARENT_OFF][u16 dummy][str PATH] */
        const fcache = new Map<number, readonly [string, number]>();
        const folder = (parentOff: number): readonly [string, number] => {
            const hit = fcache.get(parentOff);
            if (hit) return hit;
            const o = foldersOff + parentOff;
            let res: readonly [string, number] = ["", 0];
            if (o + 8 <= t.length) {
                const entrySize = u16(t, o);
                const up = u16(t, o + 4);
                if (entrySize >= 8)
                    res = [cstr(t.subarray(o + 8, o + entrySize)), up];
            }
            fcache.set(parentOff, res);
            return res;
        };

        const entries: VfiEntry[] = raw.map(e => {
            let path = e.name;
            let p = e.parentOff;
            for (let guard = 0; p !== 0 && guard < 64; guard++) {
                const [dir, up] = folder(p);
                if (!dir) break;
                path = `${dir}/${path}`;
                p = up;
            }
            return { ...e, path };
        });

        return new Vfi(src, version, dataOff, files, folders,
                       infoOff, infoEnd, foldersOff, entries);
    }

    byteOffset(e: VfiEntry): number { return e.sector * VFI_SECTOR; }

    async read(e: VfiEntry): Promise<Uint8Array> {
        const d = await this.src.read(this.byteOffset(e), e.size);
        if (d.length !== e.size)
            throw new Error(`${e.path}: short read (${d.length} of ${e.size} bytes)`);
        return d;
    }

    find(path: string): VfiEntry | null {
        return this.entries.find(e => e.path === path) ?? null;
    }
}
