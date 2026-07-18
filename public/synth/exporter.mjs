/* Offline WAV export -- wavdump's render mode through a SECOND synth
 * instance, never the audio path's (WEB_PORT_PLAN §1: export runs off the
 * audio thread and must not stall it; export-worker.mjs is that thread).
 *
 * Pure module: no fetch, no DOM, no Worker dependency, so the private repo's
 * exit gate drives this exact function under Node and byte-compares whole
 * files against native wavdump. It mirrors the SDK's test/render.mjs (the
 * pipeline the W2 gate proved 82/82 hash-identical): wavdump main's setup
 * order (dials, pitch irx, bank, seq, libsd, rev depth, song volume), the
 * same 4096-frame render block (the core's post-song tail countdown is
 * block-granular, so block size is part of byte identity), the same default
 * 1 s silent tail, and wav.mjs's lrintf-faithful s16 conversion. */
import { AE3Synth } from "./ae3synth.mjs";
import { RATE, wavHeader, floatToS16 } from "./wav.mjs";

const BLOCK = 4096;

/* files: {hd, bd, mid, irx?, libsd?} Uint8Arrays.
 * opts:  {songvol, revDepth?, exact, bright, loop, tail?} -- revDepth null or
 *        absent means the reverb flags stay off wavdump's command line
 *        (bgmplay export_wav passes --libsd/--rev-depth only when depth > 0).
 * onprogress?(frames) fires per rendered block. */
export async function renderWavFile(wasmSource, files, opts, onprogress) {
    if ((opts.loop ?? 0) >= 0x7f)
        throw new Error("export needs a finite loop count");
    const s = await AE3Synth.instantiate(wasmSource);
    try {
        s.setEventTiming(opts.exact ?? true);
        s.setGaussian(!(opts.bright ?? false));
        s.setLoop(opts.loop ?? 0);
        if (files.irx) s.loadPitchIrx(files.irx);
        s.loadBank(files.hd, files.bd);
        s.loadSeq(files.mid);
        if (files.libsd) s.loadReverbIrx(files.libsd);
        if (opts.revDepth != null) s.setReverbDepth(opts.revDepth);
        const vol = opts.songvol ?? 127;
        s.setSongVolume(vol, vol);

        const buf = new Float32Array(BLOCK * 2);
        const chunks = [];
        let frames = 0;
        for (;;) {
            const n = s.render(buf, BLOCK);
            if (n < 0) throw new Error("render: nothing loaded");
            if (n === 0) break;
            chunks.push(floatToS16(buf, n * 2));
            frames += n;
            onprogress?.(frames);
        }
        const tailFrames = Math.round((opts.tail ?? 1.0) * RATE);
        const dataBytes = (frames + tailFrames) * 4;
        const wav = new Uint8Array(44 + dataBytes);
        wav.set(wavHeader(dataBytes), 0);
        let off = 44;
        for (const c of chunks) {
            wav.set(new Uint8Array(c.buffer, 0, c.length * 2), off);
            off += c.length * 2;
        }
        /* tail is already zero-initialized */
        return { wav, frames };
    } finally {
        s.dispose();
    }
}
