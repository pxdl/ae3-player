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
import { ImageFormatError } from "./image-format.ts";

const DEFLATE_FORMAT_FAILURE =
    /\b(?:adler|checksum|unexpected end|invalid|incorrect) (?:deflate|compressed|stored|fixed|dynamic|huffman|header|distance|literal|length|block|code|data)\b|\b(?:deflate|compressed) data (?:error|invalid|truncated)\b/i;

function fail(source: string, detail: string): never {
    throw new ImageFormatError(source, 0, detail, "SZ");
}

function isDeflateFormatFailure(error: unknown): boolean {
    if (error instanceof RangeError) return false;
    const value = typeof error === "object" && error !== null
        ? error as { name?: unknown; message?: unknown; code?: unknown }
        : null;
    const name = String(value?.name ?? "");
    if (name === "AbortError" || name === "QuotaExceededError"
            || name === "NotReadableError")
        return false;
    if (error instanceof TypeError || value?.code === "Z_DATA_ERROR")
        return true;
    const message = error instanceof Error ? error.message : String(error);
    return DEFLATE_FORMAT_FAILURE.test(message);
}

export async function inflateSz(data: Uint8Array, source = "SZ"): Promise<Uint8Array> {
    if (data.length < 10)   // header + shortest deflate stream + trailer
        fail(source, `.sz too short (${data.length} bytes)`);
    const declared = u32(data, 0);
    const zstream = new Uint8Array(2 + data.length - 4);
    zstream[0] = 0x78;              // CMF: deflate, 32K window
    zstream[1] = 0x9c;              // FLG: check bits valid, no dictionary
    zstream.set(data.subarray(4), 2);
    const decompressor = new DecompressionStream("deflate");
    const stream = new Blob([zstream as BlobPart]).stream()
        .pipeThrough(decompressor);
    try {
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (out.length !== declared)
            fail(source, `.sz inflated to ${out.length} bytes, declared ${declared}`);
        return out;
    } catch (error) {
        if (error instanceof ImageFormatError) throw error;
        if (isDeflateFormatFailure(error))
            fail(source, ".sz contains an invalid deflate stream");
        throw error;
    }
}
