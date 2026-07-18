/* PCK sub-container reader -- ported from tools/ae3tools/vfiextract.py;
 * docs/formats/DATA_BIN.md §3 is the spec.
 *
 * Every member carries an ATTRIBUTE string (second offset into the same
 * string pool as the name) whose first word is the declared type. The
 * declared type is authoritative -- 6574 members have no recognisable magic --
 * and member names are NOT unique (579 name+type collisions with different
 * bytes), so consumers must key on the member table, not on filenames. */

import { cstrAt, u32 } from "./bytes.ts";

export interface PckMember {
    index: number;
    name: string;      // raw member name: not unique, may start with '/'
    attrs: string;     // raw attribute string; first word = declared type
    offset: number;
    size: number;
}

/** Member table, or null if the blob is not a PCK. */
export function unpackPck(data: Uint8Array): PckMember[] | null {
    if (!(data.length >= 4 && data[0] === 0x50 && data[1] === 0x43
          && data[2] === 0x4b && data[3] === 0))
        return null;
    if (data.length < 12)
        throw new Error("PCK truncated before its header");
    const infoOff = u32(data, 4);
    const files = u32(data, 8);
    const out: PckMember[] = [];
    for (let i = 0; i < files; i++) {
        const o = infoOff + i * 16;
        if (o + 16 > data.length) break;
        out.push({
            index: i,
            name: cstrAt(data, u32(data, o)),
            attrs: cstrAt(data, u32(data, o + 4)),
            offset: u32(data, o + 8),
            size: u32(data, o + 12),
        });
    }
    return out;
}

export function memberBytes(data: Uint8Array, m: PckMember): Uint8Array {
    return data.subarray(m.offset, m.offset + m.size);
}

/* Declared type -> written extension. Pure renames justified by the members'
 * magic (every "i3r" is an I3D_BIN, both "i3c_s" and "i3c" are I3D_I3C); the
 * raw token is never lost -- it stays in `attrs`. */
const TYPE_EXT: Record<string, string> = { i3r: "i3d", i3c_s: "i3c" };

/** First word of the attribute string = the declared type, mapped through
 *  TYPE_EXT; "bin" when the string is empty. */
export function typeOf(attrs: string): string {
    const toks = attrs.split(/\s+/).filter(s => s.length > 0);
    const t = toks.length > 0 ? toks[0] : "bin";
    return TYPE_EXT[t] ?? t;
}

/** The key=value tail of the attribute string; bare words map to true. */
export function attrsOf(attrs: string): Record<string, string | true> {
    const out: Record<string, string | true> = {};
    for (const t of attrs.split(/\s+/).filter(s => s.length > 0).slice(1)) {
        const eq = t.indexOf("=");
        if (eq >= 0) out[t.slice(0, eq)] = t.slice(eq + 1);
        else out[t] = true;
    }
    return out;
}

/** A member name reduced to a single contained filename (vfiextract
 *  safe_member): names are data, not paths -- 11 in DATA.BIN start with '/'
 *  and would escape a naive join. Strip separators, take the basename. */
export function safeMember(name: string): string {
    let n = name.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const slash = n.lastIndexOf("/");
    if (slash >= 0) n = n.slice(slash + 1);
    return n || "_unnamed";
}

/** The extractor's on-disk naming rule, mirrored from vfiextract.py so the
 *  TS and Python extraction trees are file-for-file identical:
 *  `<stem>.<ext>`; on a collision within the pck, `<stem>.<index %03d>.<ext>`. */
export function pckFileNames(members: PckMember[]): string[] {
    const used = new Set<string>();
    return members.map(m => {
        const stem = safeMember(m.name);
        const ext = typeOf(m.attrs);
        let fname = `${stem}.${ext}`;
        if (used.has(fname))
            fname = `${stem}.${String(m.index).padStart(3, "0")}.${ext}`;
        used.add(fname);
        return fname;
    });
}
