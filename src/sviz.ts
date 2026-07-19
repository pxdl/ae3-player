/* Stream stage: waveform lane(s) + spectrogram for the loaded stream, the
 * authored trailing-pad region shaded on both, playhead, click-to-seek
 * (wired by main.ts). Everything derives from the decoded PCM already in
 * hand -- no second decode.
 *
 * Rendering is two-phase: the expensive image (per-column waveform peaks,
 * FFT spectrogram) is drawn ONCE per (stream, trim, size) into offscreen
 * canvases; the rAF tick only blits and draws the playhead. */

import type { DecodedStream } from "./streams.ts";

const ACCENT = "#ffc440";
const WAVE = "#8b93a7";
const PAD_FILL = "rgba(255, 196, 64, 0.10)";
const PAD_EDGE = "rgba(255, 196, 64, 0.5)";
const LANE_GAP = 2;                 /* px between stereo lanes */

const FFT_N = 1024;
const SPEC_BINS = 256;              /* of FFT_N/2, averaged 2:1 */
const DB_FLOOR = -80;

/* Iterative radix-2 FFT, in place. Small and dependency-free -- the corpus
 * spectrogram needs nothing fancier. */
function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {        /* bit reversal */
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j]!, re[i]!];
            [im[i], im[j]] = [im[j]!, im[i]!];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = i + k + len / 2;
                const tr = re[b]! * cr - im[b]! * ci;
                const ti = re[b]! * ci + im[b]! * cr;
                re[b] = re[a]! - tr; im[b] = im[a]! - ti;
                re[a] = re[a]! + tr; im[a] = im[a]! + ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

const HANN = new Float64Array(FFT_N);
for (let i = 0; i < FFT_N; i++)
    HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));

/* dark -> amber -> white, t in [0,1] */
function heat(t: number): [number, number, number] {
    if (t < 0.55) {
        const u = t / 0.55;
        return [Math.round(0x18 + (0xff - 0x18) * u * 0.85),
                Math.round(0x1a + (0xc4 - 0x1a) * u * 0.75),
                Math.round(0x21 + (0x40 - 0x21) * u * 0.4)];
    }
    const u = (t - 0.55) / 0.45;
    return [Math.round(0xd9 + (0xff - 0xd9) * u),
            Math.round(0x93 + (0xff - 0x93) * u),
            Math.round(0x36 + (0xff - 0x36) * u)];
}

export class StreamViz {
    private wave: HTMLCanvasElement;
    private spec: HTMLCanvasElement;
    private offWave: HTMLCanvasElement;
    private offSpec: HTMLCanvasElement;
    private stream: DecodedStream | null = null;
    private samples = 0;            /* view length per channel (trim applied) */
    private padFrac = 0;            /* shaded tail fraction; 0 when trimmed */
    private rendered = false;

    constructor(wave: HTMLCanvasElement, spec: HTMLCanvasElement) {
        this.wave = wave;
        this.spec = spec;
        this.offWave = document.createElement("canvas");
        this.offSpec = document.createElement("canvas");
        window.addEventListener("resize", () => { this.rendered = false; });
    }

    /** Set (or clear) the stream; view length follows the trim dial. */
    set(stream: DecodedStream | null, trim: boolean): void {
        this.stream = stream;
        if (stream) {
            const pad = stream.padFrames * 28;
            this.samples = trim ? stream.samplesPerChannel - pad
                                : stream.samplesPerChannel;
            this.padFrac = trim || stream.samplesPerChannel === 0 ? 0
                : pad / stream.samplesPerChannel;
        }
        this.rendered = false;
    }

    /** rAF hook: (re)render offscreen if needed, blit, draw the playhead. */
    draw(posFrac: number): void {
        const wctx = this.wave.getContext("2d")!;
        const sctx = this.spec.getContext("2d")!;
        const dpr = window.devicePixelRatio || 1;
        const ww = Math.round(this.wave.clientWidth * dpr);
        const wh = Math.round(this.wave.clientHeight * dpr);
        const sw = Math.round(this.spec.clientWidth * dpr);
        const sh = Math.round(this.spec.clientHeight * dpr);
        if (ww === 0 || wh === 0) return;       /* hidden: nothing to do */
        if (this.wave.width !== ww || this.wave.height !== wh) {
            this.wave.width = ww; this.wave.height = wh;
            this.rendered = false;
        }
        if (this.spec.width !== sw || this.spec.height !== sh) {
            this.spec.width = sw; this.spec.height = sh;
            this.rendered = false;
        }
        if (!this.rendered) {
            this.renderWave(ww, wh);
            this.renderSpec(sw, sh);
            this.rendered = true;
        }
        wctx.clearRect(0, 0, ww, wh);
        wctx.drawImage(this.offWave, 0, 0);
        sctx.clearRect(0, 0, sw, sh);
        sctx.drawImage(this.offSpec, 0, 0);
        if (this.stream) {
            const x = Math.round(posFrac * ww);
            wctx.fillStyle = ACCENT;
            wctx.fillRect(x - 1, 0, 2, wh);
            const sx = Math.round(posFrac * sw);
            sctx.fillStyle = ACCENT;
            sctx.fillRect(sx - 1, 0, 2, sh);
        }
    }

    private shadePad(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        if (this.padFrac <= 0) return;
        const x = Math.round((1 - this.padFrac) * w);
        ctx.fillStyle = PAD_FILL;
        ctx.fillRect(x, 0, w - x, h);
        ctx.fillStyle = PAD_EDGE;
        ctx.fillRect(x, 0, 1, h);
    }

    private renderWave(w: number, h: number): void {
        this.offWave.width = w; this.offWave.height = h;
        const ctx = this.offWave.getContext("2d")!;
        ctx.clearRect(0, 0, w, h);
        const s = this.stream;
        if (!s || this.samples === 0) return;
        const ch = s.header.channels;
        const laneH = (h - LANE_GAP * (ch - 1)) / ch;
        ctx.fillStyle = WAVE;
        for (let c = 0; c < ch; c++) {
            const top = c * (laneH + LANE_GAP);
            const mid = top + laneH / 2;
            for (let x = 0; x < w; x++) {
                const a = Math.floor(x / w * this.samples);
                const b = Math.max(a + 1, Math.floor((x + 1) / w * this.samples));
                let lo = 0, hi = 0;
                for (let i = a; i < b; i++) {
                    const v = s.pcm[i * ch + c]!;
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
                const y0 = mid - hi / 32768 * (laneH / 2);
                const y1 = mid - lo / 32768 * (laneH / 2);
                ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
            }
        }
        this.shadePad(ctx, w, h);
    }

    private renderSpec(w: number, h: number): void {
        this.offSpec.width = w; this.offSpec.height = h;
        const ctx = this.offSpec.getContext("2d")!;
        ctx.clearRect(0, 0, w, h);
        const s = this.stream;
        if (!s || this.samples === 0) return;
        const ch = s.header.channels;
        const n = this.samples;
        const cols = Math.min(w, 2048);
        const img = new ImageData(cols, SPEC_BINS);
        const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
        const hop = Math.max(1, (n - FFT_N) / Math.max(1, cols - 1));
        for (let x = 0; x < cols; x++) {
            const start = Math.min(Math.max(0, n - FFT_N),
                                   Math.floor(x * hop));
            for (let i = 0; i < FFT_N; i++) {
                const k = start + i;
                let v = 0;
                if (k < n) {
                    /* mono mix for stereo -- one lane tells the story */
                    for (let c = 0; c < ch; c++) v += s.pcm[k * ch + c]!;
                    v /= ch * 32768;
                }
                re[i] = v * HANN[i]!;
                im[i] = 0;
            }
            fft(re, im);
            for (let b = 0; b < SPEC_BINS; b++) {
                /* average bin pairs of the FFT_N/2 spectrum */
                const b0 = b * 2, b1 = b * 2 + 1;
                const m = (Math.hypot(re[b0]!, im[b0]!)
                         + Math.hypot(re[b1]!, im[b1]!)) / 2 / (FFT_N / 4);
                const db = 20 * Math.log10(m + 1e-9);
                const t = Math.min(1, Math.max(0, (db - DB_FLOOR) / -DB_FLOOR));
                const [r, g, bl] = heat(t);
                /* bin 0 at the bottom */
                const p = ((SPEC_BINS - 1 - b) * cols + x) * 4;
                img.data[p] = r; img.data[p + 1] = g;
                img.data[p + 2] = bl; img.data[p + 3] = 255;
            }
        }
        const tmp = document.createElement("canvas");
        tmp.width = cols; tmp.height = SPEC_BINS;
        tmp.getContext("2d")!.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, 0, 0, cols, SPEC_BINS, 0, 0, w, h);
        this.shadePad(ctx, w, h);
    }
}
