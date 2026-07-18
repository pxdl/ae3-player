/* Reader for the game's self-describing "EDB" tables (*.exdb.exdb) -- a port
 * of the reference parser tools/ae3tools/exdb.py. 574 of these live inside
 * DATA.BIN; the one the player needs is BgmDesc (cue -> midi/vh/vb/
 * volume_scale/reverb class), which replaces the never-published TSV: song
 * list, orphan->bank pairing and authored song volumes all come from the
 * user's own disc at runtime.
 *
 * Format (little-endian, plain-text header):
 *     EDB\n
 *     stn:<SchemaName>:<nfields>:<nrecords>\n
 *     <t>:<byte offset>:<field name>\n        x nfields; t in {s,f,i}
 *     sizest:<record size>\n
 *     b:<header block size>\n                 = file offset of record 0
 *     'U' padding up to offset b, then nrecords x sizest raw records. */

import { ascii, cstr, f32, i32 } from "./bytes.ts";

export interface ExdbField {
    type: "s" | "f" | "i";
    offset: number;
    name: string;          // deduped: repeats become "name.1", "name.2", ...
}

export interface Exdb {
    name: string;
    fields: ExdbField[];
    records: Array<Record<string, string | number>>;
}

export function parseExdb(data: Uint8Array): Exdb {
    if (!(data.length >= 4 && data[0] === 0x45 && data[1] === 0x44 && data[2] === 0x42))
        throw new Error("no EDB magic");

    /* header text ends where the 'U' padding starts */
    let pad = -1;
    for (let i = data.indexOf(0x55); i >= 0; i = data.indexOf(0x55, i + 1)) {
        if (data[i + 1] === 0x55 && data[i + 2] === 0x55 && data[i + 3] === 0x55) {
            pad = i;
            break;
        }
    }
    if (pad < 0) throw new Error("EDB: no 'U' padding found");
    const lines = ascii(data.subarray(0, pad)).split("\n");

    const stn = lines.find(l => l.startsWith("stn:"));
    if (!stn) throw new Error("EDB: no stn: line");
    const stnParts = stn.split(":");
    if (stnParts.length !== 4) throw new Error(`EDB: malformed ${stn}`);
    const name = stnParts[1];
    const nfields = parseInt(stnParts[2], 10);
    const nrecords = parseInt(stnParts[3], 10);
    const size = intLine(lines, "sizest:");
    const base = intLine(lines, "b:");

    const raw: Array<{ type: "s" | "f" | "i"; offset: number; name: string }> = [];
    for (const l of lines) {
        const p = l.split(":");
        if (p.length === 3 && (p[0] === "s" || p[0] === "f" || p[0] === "i")
            && /^\d+$/.test(p[1]))
            raw.push({ type: p[0], offset: parseInt(p[1], 10), name: p[2] });
    }
    if (raw.length !== nfields)
        throw new Error(`EDB: header says ${nfields} fields, parsed ${raw.length}`);
    if (base + nrecords * size > data.length)
        throw new Error(`EDB: ${nrecords} x ${size}B records overrun the file`);

    /* a field spans up to the next-higher field offset (or the record end) */
    const offs = raw.map(f => f.offset).sort((a, b) => a - b);
    offs.push(size);
    const span = new Map<number, number>();
    for (const f of raw)
        span.set(f.offset, offs.find(x => x > f.offset)! - f.offset);

    /* duplicate field names exist in shipped schemas; suffix repeats */
    const seen = new Map<string, number>();
    const names = raw.map(f => {
        const k = seen.get(f.name) ?? 0;
        seen.set(f.name, k + 1);
        return k === 0 ? f.name : `${f.name}.${k}`;
    });

    const records: Array<Record<string, string | number>> = [];
    for (let ri = 0; ri < nrecords; ri++) {
        const ro = base + ri * size;
        const rec: Record<string, string | number> = {};
        raw.forEach((f, i) => {
            const o = ro + f.offset;
            if (f.type === "s")
                rec[names[i]] = cstr(data.subarray(o, o + span.get(f.offset)!));
            else if (f.type === "f")
                rec[names[i]] = f32(data, o);
            else
                rec[names[i]] = i32(data, o);
        });
        records.push(rec);
    }

    return {
        name,
        fields: raw.map((f, i) => ({ type: f.type, offset: f.offset, name: names[i] })),
        records,
    };
}

function intLine(lines: string[], prefix: string): number {
    const l = lines.find(x => x.startsWith(prefix));
    if (!l) throw new Error(`EDB: no ${prefix} line`);
    return parseInt(l.split(":")[1], 10);
}

/* ---- BgmDesc: the mastering / cue database ------------------------------ */

export interface BgmDescRecord {
    name: string;          // cue name (m01, ...)
    midi: string;
    vh: string;
    vb: string;
    reverb: string;        // reverb class (system, ...)
    volumeScale: number;   // f32, promoted
}

export function bgmDescRecords(db: Exdb): BgmDescRecord[] {
    if (db.name !== "BgmDesc")
        throw new Error(`expected schema BgmDesc, got ${db.name}`);
    return db.records.map(r => ({
        name: str(r, "name"), midi: str(r, "midi"),
        vh: str(r, "vh"), vb: str(r, "vb"), reverb: str(r, "reverb"),
        volumeScale: num(r, "volume_scale"),
    }));
}

function str(r: Record<string, string | number>, k: string): string {
    const v = r[k];
    if (typeof v !== "string") throw new Error(`BgmDesc: bad field ${k}`);
    return v;
}

function num(r: Record<string, string | number>, k: string): number {
    const v = r[k];
    if (typeof v !== "number") throw new Error(`BgmDesc: bad field ${k}`);
    return v;
}

/* ---- the song table, exactly as bgmplay builds it ----------------------- */

export interface BgmSong {
    name: string;          // midi basename without .mid
    mid: string;
    hd: string;
    bd: string;
    songvol: number;       // authored: trunc(127 x volume_scale), slider 1.0
    volumeScale: number;
}

/** Natural-order compare (bgmplay natcmp): digit runs compare numerically so
 *  s_9 < s_10, other characters case-insensitively. */
export function natcmp(a: string, b: string): number {
    const dig = (c: number) => c >= 0x30 && c <= 0x39;
    const low = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 32 : c);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        const ca = a.charCodeAt(i), cb = b.charCodeAt(j);
        if (dig(ca) && dig(cb)) {
            let va = 0, vb = 0;
            while (i < a.length && dig(a.charCodeAt(i)))
                va = va * 10 + (a.charCodeAt(i++) - 0x30);
            while (j < b.length && dig(b.charCodeAt(j)))
                vb = vb * 10 + (b.charCodeAt(j++) - 0x30);
            if (va !== vb) return va < vb ? -1 : 1;
        } else {
            const la = low(ca), lb = low(cb);
            if (la !== lb) return la - lb;
            i++;
            j++;
        }
    }
    return (i < a.length ? a.charCodeAt(i) : 0) - (j < b.length ? b.charCodeAt(j) : 0);
}

/** One song per distinct .mid (multiple cues share one; the first record
 *  wins), natural-sorted; songvol = trunc(127 x volume_scale) capped at 126,
 *  with the same <1 -> 44 fallback bgmplay applies. Byte-for-byte the rules
 *  of bgmplay.c load_song_table -- `bgmplay --songs` is this function's
 *  differ oracle. */
export function bgmSongTable(db: Exdb): BgmSong[] {
    const out: BgmSong[] = [];
    for (const r of bgmDescRecords(db)) {
        if (r.midi.length < 5 || !r.midi.endsWith(".mid")) continue;
        if (out.some(s => s.mid === r.midi)) continue;
        let songvol = Math.trunc(127.0 * r.volumeScale);
        if (songvol > 126) songvol = 126;
        if (songvol < 1) songvol = 44;
        out.push({
            name: r.midi.slice(0, -4), mid: r.midi, hd: r.vh, bd: r.vb,
            songvol, volumeScale: r.volumeScale,
        });
    }
    out.sort((a, b) => natcmp(a.name, b.name));
    return out;
}
