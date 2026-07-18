/* `.sz` = [u32 decompressed_size][raw deflate][Adler-32 of the payload, BE]
 * -- i.e. a zlib stream with its 2-byte header stripped (verified corpus-wide:
 * 1706/1706 entries in the US DATA.BIN carry the exact Adler-32 trailer and
 * inflate to their exact declared size).
 *
 * The trailer matters here: Python's zlib.decompress(-15) ignores trailing
 * bytes, but the WHATWG DecompressionStream("deflate-raw") rejects them as
 * junk. So reconstruct the zlib framing -- prepend a valid 2-byte header and
 * inflate as "deflate" -- which also makes the browser verify the checksum
 * natively. Zero library code either way. */

import { u32 } from "./bytes.ts";

export async function inflateSz(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 10)   // header + shortest deflate stream + trailer
        throw new Error(`.sz too short (${data.length} bytes)`);
    const declared = u32(data, 0);
    const zstream = new Uint8Array(2 + data.length - 4);
    zstream[0] = 0x78;              // CMF: deflate, 32K window
    zstream[1] = 0x9c;              // FLG: check bits valid, no dictionary
    zstream.set(data.subarray(4), 2);
    const stream = new Blob([zstream as BlobPart]).stream()
        .pipeThrough(new DecompressionStream("deflate"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    if (out.length !== declared)
        throw new Error(`.sz inflated to ${out.length} bytes, declared ${declared}`);
    return out;
}
