/* EXST (.x) stream decode -- the STREAMS tab's decode path, over the SDK's
 * AE3Exst binding (core/exst.c through the wasm; docs/formats/EXST.md).
 *
 * Decodes the ACTUAL whole-sector payload, never the header's length field
 * (16 shipped files overstate it -- spec §4); trimPad drops the trailing
 * flag-2 silent-pad run, shortened equally across channels, exactly like
 * `ae3 exst --trim-pad`. The WAV framing matches `ae3 exst --decode` byte
 * for byte.
 *
 * Pure module (no fetch, no DOM, no Worker dependency) so the private
 * repo's exit gate drives these exact functions under Node and
 * byte-compares against the oracle's WAVs over the whole corpus. */
import { AE3Exst } from "./ae3synth.mjs";
import { wavHeader } from "./wav.mjs";

let decoder = null;      /* one instance per scope; reused across files */

/* files come in as {header, sectors, padFrames, samplesPerChannel, pcm};
 * pcm is an exact-length copy (safe to transfer). */
export async function decodeStream(wasmSource, fileBytes, { trimPad = false } = {}) {
    decoder ??= await AE3Exst.instantiate(wasmSource);
    const r = decoder.decodeFile(fileBytes, { trimPad });
    return { ...r, pcm: r.pcm.slice() };
}

/* Frame decoded PCM as the canonical 44-byte-header WAV. */
export function streamWav(header, pcm) {
    const out = new Uint8Array(44 + pcm.byteLength);
    out.set(wavHeader(pcm.byteLength, header.channels, header.rate), 0);
    out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
    return out;
}

/* Parse just the 0x78-byte header (catalog building at extraction time). */
export async function streamHeader(wasmSource, headerBytes) {
    decoder ??= await AE3Exst.instantiate(wasmSource);
    return decoder.parseHeader(headerBytes);
}
