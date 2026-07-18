/* Little-endian scalar reads and the exact string semantics of the Python
 * oracles (tools/ae3tools). Decoding mirrors Python's .decode("ascii",
 * "replace") -- every byte >= 0x80 becomes U+FFFD -- so listings produced from
 * the same bytes compare identical across both extractors. */

export const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);

export const u32 = (b: Uint8Array, o: number): number =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const i32 = (b: Uint8Array, o: number): number =>
    b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

export const f32 = (b: Uint8Array, o: number): number =>
    new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(o, true);

export function ascii(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i++)
        s += b[i] < 0x80 ? String.fromCharCode(b[i]) : "�";
    return s;
}

/** NUL-terminated string from a fixed-size field; the whole field if no NUL
 *  (vfiparse._cstr). */
export function cstr(b: Uint8Array): string {
    const z = b.indexOf(0);
    return ascii(z >= 0 ? b.subarray(0, z) : b);
}

/** NUL-terminated string at an offset into a string pool; EMPTY if
 *  unterminated (vfiextract._cstr -- the two oracles genuinely differ here). */
export function cstrAt(b: Uint8Array, off: number): string {
    const z = b.indexOf(0, off);
    return z >= 0 ? ascii(b.subarray(off, z)) : "";
}
