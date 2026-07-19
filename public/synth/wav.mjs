/* WAV framing byte-identical to harness/wavdump.c: 44-byte canonical header,
 * s16 stereo 48 kHz, silent tail appended after the song. The hash gates
 * compare whole files, so every byte here mirrors the C writer.
 *
 * Lives in js/ (not test/) because it ships: the web player's export path
 * encodes with exactly this framing so exported WAVs hash-match wavdump. */

export const RATE = 48000;

/* Defaults are the synth render's framing (stereo 48 kHz); EXST stream
 * exports pass the stream header's channels/rate and stay byte-identical to
 * exstdump / `ae3 exst --decode` likewise. */
export function wavHeader(dataBytes, channels = 2, rate = RATE) {
    const h = new DataView(new ArrayBuffer(44));
    const tag = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, "RIFF");  h.setUint32(4, 36 + dataBytes, true);
    tag(8, "WAVEfmt ");
    h.setUint32(16, 16, true);                   /* fmt chunk length */
    h.setUint16(20, 1, true);                    /* PCM */
    h.setUint16(22, channels, true);
    h.setUint32(24, rate, true);
    h.setUint32(28, rate * channels * 2, true);  /* byte rate */
    h.setUint16(32, channels * 2, true);         /* block align */
    h.setUint16(34, 16, true);                   /* bits */
    tag(36, "data"); h.setUint32(40, dataBytes, true);
    return new Uint8Array(h.buffer);
}

/* Mirror wavdump's conversion: clamp, then lrintf(v * 32768.0f). The dry path's
 * floats sit exactly on the s16/32768 grid (integer bus / 32768), but reverb
 * renders emit (float)(l * 32766/32768) from the double return sum -- genuinely
 * fractional, so the rounding rule is load-bearing. lrintf under the default
 * FE_TONEAREST is round-half-to-EVEN; Math.round is half-up and differs on ties
 * (incl. every negative half), hence the explicit implementation. The *32768
 * itself is exact in float and double alike (pure exponent shift), so C's
 * float multiply and this double multiply see the identical value. */
export function floatToS16(f32, nsamples) {
    const out = new Int16Array(nsamples);
    for (let i = 0; i < nsamples; i++) {
        const v = f32[i] * 32768;
        if (v > 32767) { out[i] = 32767; continue; }
        if (v < -32768) { out[i] = -32768; continue; }
        const f = Math.floor(v), d = v - f;
        out[i] = d < 0.5 ? f
               : d > 0.5 ? f + 1
               : f % 2 === 0 ? f : f + 1;
    }
    return out;
}
