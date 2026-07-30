/* Store-only ZIP writer (no compression, no dependency). Needed because a
 * single click may only trigger one download: Chrome's multiple-downloads
 * policy silently blocks the second same-gesture download, so multi-file
 * exports (the .hd/.bd bank pair, the future sample kit) ship as one zip.
 * Output is deterministic -- fixed 1980-01-01 timestamps -- so exports can
 * be byte-compared in gates. */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(b: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++)
        c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Pack `entries` (ASCII names) into a store-only zip. */
export function storeZip(entries: [name: string, data: Uint8Array][]): Uint8Array {
    const enc = new TextEncoder();
    const files = entries.map(([name, data]) =>
        ({ name: enc.encode(name), data, crc: crc32(data), offset: 0 }));

    const localSize = files.reduce((s, f) => s + 30 + f.name.length + f.data.length, 0);
    const centralSize = files.reduce((s, f) => s + 46 + f.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const v = new DataView(out.buffer);
    let p = 0;

    /* common fields of local header + central entry: version 2.0, no flags,
     * method 0 (store), DOS timestamp 1980-01-01 00:00:00 */
    const common = (f: typeof files[0]) => {
        v.setUint16(p, 20, true); p += 2;               /* version needed */
        v.setUint16(p, 0, true); p += 2;                /* flags */
        v.setUint16(p, 0, true); p += 2;                /* method: store */
        v.setUint16(p, 0, true); p += 2;                /* mod time */
        v.setUint16(p, 0x21, true); p += 2;             /* mod date */
        v.setUint32(p, f.crc, true); p += 4;
        v.setUint32(p, f.data.length, true); p += 4;    /* compressed */
        v.setUint32(p, f.data.length, true); p += 4;    /* uncompressed */
        v.setUint16(p, f.name.length, true); p += 2;
        v.setUint16(p, 0, true); p += 2;                /* extra len */
    };

    for (const f of files) {
        f.offset = p;
        v.setUint32(p, 0x04034b50, true); p += 4;       /* local header */
        common(f);
        out.set(f.name, p); p += f.name.length;
        out.set(f.data, p); p += f.data.length;
    }

    const centralStart = p;
    for (const f of files) {
        v.setUint32(p, 0x02014b50, true); p += 4;       /* central entry */
        v.setUint16(p, 20, true); p += 2;               /* version made by */
        common(f);
        v.setUint16(p, 0, true); p += 2;                /* comment len */
        v.setUint16(p, 0, true); p += 2;                /* disk number */
        v.setUint16(p, 0, true); p += 2;                /* internal attrs */
        v.setUint32(p, 0, true); p += 4;                /* external attrs */
        v.setUint32(p, f.offset, true); p += 4;
        out.set(f.name, p); p += f.name.length;
    }

    v.setUint32(p, 0x06054b50, true); p += 4;           /* end of central dir */
    v.setUint16(p, 0, true); p += 2;                    /* disk number */
    v.setUint16(p, 0, true); p += 2;                    /* central dir disk */
    v.setUint16(p, files.length, true); p += 2;
    v.setUint16(p, files.length, true); p += 2;
    v.setUint32(p, centralSize, true); p += 4;
    v.setUint32(p, centralStart, true); p += 4;
    v.setUint16(p, 0, true); p += 2;                    /* comment len */
    return out;
}

/** Build a store-only ZIP as Blob parts, avoiding a second archive-sized copy.
 *  Intended for large exports whose already-compressed payloads dominate RAM. */
export function storeZipBlob(entries: [name: string, data: Uint8Array][]): Blob {
    if (entries.length > 0xffff)
        throw new Error(`ZIP has ${entries.length} files; ZIP32 supports at most 65535`);
    const enc = new TextEncoder();
    const parts: BlobPart[] = [];
    const files: Array<{
        name: Uint8Array;
        size: number;
        crc: number;
        offset: number;
    }> = [];
    let offset = 0;
    for (const [path, data] of entries) {
        if (data.length > 0xffffffff)
            throw new Error(`${path}: file is too large for ZIP32`);
        const name = enc.encode(path);
        const header = new Uint8Array(30 + name.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0x0800, true);                // UTF-8 names
        view.setUint16(12, 0x21, true);                // 1980-01-01
        const crc = crc32(data);
        view.setUint32(14, crc, true);
        view.setUint32(18, data.length, true);
        view.setUint32(22, data.length, true);
        view.setUint16(26, name.length, true);
        header.set(name, 30);
        files.push({ name, size: data.length, crc, offset });
        parts.push(header, data as BlobPart);
        offset += header.length + data.length;
        if (offset > 0xffffffff)
            throw new Error("ZIP payload exceeds the 4 GiB ZIP32 limit");
    }

    const centralStart = offset;
    for (const file of files) {
        const entry = new Uint8Array(46 + file.name.length);
        const view = new DataView(entry.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0x0800, true);
        view.setUint16(14, 0x21, true);
        view.setUint32(16, file.crc, true);
        view.setUint32(20, file.size, true);
        view.setUint32(24, file.size, true);
        view.setUint16(28, file.name.length, true);
        view.setUint32(42, file.offset, true);
        entry.set(file.name, 46);
        parts.push(entry);
        offset += entry.length;
    }
    const centralSize = offset - centralStart;
    if (centralSize > 0xffffffff)
        throw new Error("ZIP directory exceeds the ZIP32 limit");
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralStart, true);
    parts.push(end);
    return new Blob(parts, { type: "application/zip" });
}
