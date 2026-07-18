/* Sample-kit build -- every unique waveform in the song's bank decoded to a
 * mono 16-bit WAV through the SDK's bank-introspection API (the note-on
 * path's streaming ADPCM decoder, held bit-exact against the offline oracle
 * by the corpus gates). This is the honest replacement for a soundfont
 * export: the game has no soundfonts, and SF2 cannot express the SPU2's
 * envelopes or pan law -- so the kit ships the waveforms themselves, with
 * loop points and pitch carried as a standard `smpl` chunk.
 *
 * Pure module (no fetch, no DOM, no Worker dependency) so the private repo's
 * exit gate drives this exact function under Node and byte-compares each
 * WAV's PCM against the oracle's decode of the same waveform. */
import { AE3Synth } from "./ae3synth.mjs";

/* The banks' native rate: a tone struck at its root key plays 44100 Hz
 * content on the SPU2's 48 kHz clock (BGM.md §6 -- do NOT "fix" to 48000,
 * that detunes everything by 147 cents). */
const SAMPLE_HZ = 44100;

const pad = (v, n) => String(v).padStart(n, "0");

/* Mono 16-bit WAV with a `smpl` chunk. The sample's true pitch is
 * root - tune/16 semitones (pitch-register index = (note-root)*16 + tune, in
 * 1/16-semitone steps; index 0 = native rate, so the native-rate key solves
 * to root - tune/16) -- encoded as MIDIUnityNote + the positive
 * MIDIPitchFraction (1/2^32 semitone units). Loop end is inclusive. */
function waveWav(w, pcm) {
    const dataBytes = pcm.length * 2;
    const looped = w.loop_start >= 0;
    const smplBytes = 36 + (looped ? 24 : 0);
    const out = new Uint8Array(12 + 24 + (8 + smplBytes) + 8 + dataBytes);
    const v = new DataView(out.buffer);
    const tag = (p, s) => { for (let i = 0; i < 4; i++) out[p + i] = s.charCodeAt(i); };
    let p = 0;

    tag(p, "RIFF"); v.setUint32(p + 4, out.length - 8, true); tag(p + 8, "WAVE");
    p += 12;
    tag(p, "fmt "); v.setUint32(p + 4, 16, true);
    v.setUint16(p + 8, 1, true);                     /* PCM */
    v.setUint16(p + 10, 1, true);                    /* mono */
    v.setUint32(p + 12, SAMPLE_HZ, true);
    v.setUint32(p + 16, SAMPLE_HZ * 2, true);
    v.setUint16(p + 20, 2, true);                    /* block align */
    v.setUint16(p + 22, 16, true);                   /* bits */
    p += 24;

    const pitch = w.root - w.tune / 16;              /* the key of native rate */
    let unity = Math.floor(pitch);
    let frac = Math.round((pitch - unity) * 2 ** 32);
    if (frac === 2 ** 32) { unity++; frac = 0; }
    tag(p, "smpl"); v.setUint32(p + 4, smplBytes, true);
    v.setUint32(p + 8, 0, true);                     /* manufacturer */
    v.setUint32(p + 12, 0, true);                    /* product */
    v.setUint32(p + 16, Math.floor(1e9 / SAMPLE_HZ), true);   /* ns/sample */
    v.setUint32(p + 20, unity, true);
    v.setUint32(p + 24, frac, true);
    v.setUint32(p + 28, 0, true);                    /* SMPTE format */
    v.setUint32(p + 32, 0, true);                    /* SMPTE offset */
    v.setUint32(p + 36, looped ? 1 : 0, true);
    v.setUint32(p + 40, 0, true);                    /* sampler data */
    p += 8 + 36;
    if (looped) {
        v.setUint32(p, 0, true);                     /* cue point id */
        v.setUint32(p + 4, 0, true);                 /* type: forward */
        v.setUint32(p + 8, w.loop_start, true);
        v.setUint32(p + 12, pcm.length - 1, true);   /* end, inclusive */
        v.setUint32(p + 16, 0, true);                /* fraction */
        v.setUint32(p + 20, 0, true);                /* play count: forever */
        p += 24;
    }

    tag(p, "data"); v.setUint32(p + 4, dataBytes, true);
    p += 8;
    out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), p);
    return out;
}

/* files: {hd, bd} Uint8Arrays. -> [{name, wav}] in bank layout order, named
 * by sample address (the oracle's s{addr:05} convention) + first-referencing
 * program and root key for DAW-side grouping. */
export async function buildSampleKit(wasmSource, files) {
    const s = await AE3Synth.instantiate(wasmSource);
    try {
        s.loadBank(files.hd, files.bd);
        const out = [];
        const n = s.bankWaveforms();
        for (let i = 0; i < n; i++) {
            const w = s.bankWaveform(i);
            const pcm = s.bankWaveformPcm(i);
            out.push({
                name: `s${pad(w.addr, 5)}_p${pad(w.prog, 2)}_r${pad(w.root, 3)}.wav`,
                wav: waveWav(w, pcm),
            });
        }
        return out;
    } finally {
        s.dispose();
    }
}
