/* Canvas visualizers, ported from bgmplay.c's draw sections: the loop-unwound
 * piano roll (ghost passes for the loop body, live note highlighting from the
 * voice envelopes), the 48-slot voice grid, and the scrolling stereo waveform
 * strip with dB peak meters at its right edge.
 *
 * Everything draws in CSS pixels on devicePixelRatio-scaled backing stores,
 * sized per frame from the live layout. The waveform ring lives here (the
 * worklet ships finished 800-sample columns with each snapshot); peaks decay
 * per snapshot at bgmplay's 0.86-per-callback rate -- the ~47 Hz snapshot
 * cadence matches its 1024-sample audio callback. */

import type { Snapshot } from "./player.ts";
import type { Timeline } from "./timeline.ts";
import { RATE } from "./timeline.ts";

const NVOICES = 48;
const WCOL_N = 4096;               /* waveform history columns (bgmplay) */

/* bgmplay ch_color: 16 hues at 22.5 deg, s 0.72, v 1.0 */
const CH_RGB: Array<[number, number, number]> = [];
for (let ch = 0; ch < 16; ch++) {
    const h = ch * 22.5, s = 0.72, v = 1.0;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const hh = Math.floor(h / 60);
    let r = 0, g = 0, b = 0;
    switch (hh) {
    case 0: r = c; g = x; break;  case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;  case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;  default: r = c; b = x; break;
    }
    CH_RGB.push([Math.round((r + m) * 255), Math.round((g + m) * 255),
                 Math.round((b + m) * 255)]);
}

const FONT = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const DIM = "#787e8c";
const BAD = "#f05a50";
const GOOD = "#6edc82";

function ctx2d(cv: HTMLCanvasElement): { g: CanvasRenderingContext2D;
                                          w: number; h: number } | null {
    const r = cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    const dpr = devicePixelRatio || 1;
    const bw = Math.round(r.width * dpr), bh = Math.round(r.height * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: r.width, h: r.height };
}

export class Viz {
    zoomS = 12;                     /* piano-roll window, seconds (Z/X) */
    private readonly wcol = new Float32Array(WCOL_N * 5);
    private whead = 0;
    private readonly act = new Int32Array(16 * 128);
    private peakL = 0;              /* decayed display peaks (meters) */
    private peakR = 0;
    private lastSnap: Snapshot | null = null;
    private readonly roll: HTMLCanvasElement;
    private readonly slots: HTMLCanvasElement;
    private readonly wave: HTMLCanvasElement;

    constructor(roll: HTMLCanvasElement, slots: HTMLCanvasElement,
                wave: HTMLCanvasElement) {
        this.roll = roll;
        this.slots = slots;
        this.wave = wave;
    }

    zoomIn(): void  { this.zoomS = Math.max(3, this.zoomS * 0.75); }
    zoomOut(): void { this.zoomS = Math.min(48, this.zoomS / 0.75); }

    /** New song: bgmplay clears the waveform history on load (not on seek). */
    clearWave(): void {
        this.wcol.fill(0);
        this.whead = 0;
        this.peakL = this.peakR = 0;
    }

    /** Feed every snapshot as it arrives (player.onsnapshot), not per rAF:
     *  a slow frame or hidden tab must not drop waveform columns. */
    ingest(s: Snapshot): void {
        if (s === this.lastSnap) return;
        this.lastSnap = s;
        for (let i = 0; i + 5 <= s.wcols.length; i += 5) {
            this.wcol.set(s.wcols.subarray(i, i + 5), this.whead * 5);
            this.whead = (this.whead + 1) % WCOL_N;
        }
        this.peakL = Math.max(s.peakL, this.peakL * 0.86);
        this.peakR = Math.max(s.peakR, this.peakR * 0.86);
    }

    draw(s: Snapshot | null, tl: Timeline | null, dpos: number,
         loopOn: boolean): void {
        /* active (ch,key) -> envelope, for note highlighting */
        this.act.fill(0);
        let used = 0;
        if (s) {
            const v = s.voices;
            for (let i = 0; i < NVOICES; i++) {
                const f = v[i * 4]!;
                if (f & 1) {
                    used++;
                    const idx = (v[i * 4 + 1]! & 15) * 128 + (v[i * 4 + 2]! & 127);
                    if ((f & 2) && v[i * 4 + 3]! > this.act[idx]!)
                        this.act[idx] = v[i * 4 + 3]!;
                }
            }
        }
        this.drawRoll(tl, dpos, loopOn);
        this.drawSlots(s, used);
        this.drawWave();
    }

    private drawRoll(tl: Timeline | null, dpos: number, loopOn: boolean): void {
        const c = ctx2d(this.roll);
        if (!c) return;
        const { g, w: rw, h: rh } = c;
        g.fillStyle = "#14151b";
        g.fillRect(0, 0, rw, rh);
        if (!tl) return;
        let klo = tl.keyLo - 2, khi = tl.keyHi + 2;
        if (khi <= klo) { klo = 40; khi = 80; }
        const rowh = rh / (khi - klo + 1);
        const T = this.zoomS * RATE;
        const v0 = dpos - 0.35 * T;
        /* octave guides (C rows) */
        g.fillStyle = "#262832";
        for (let key = klo; key <= khi; key++)
            if (key % 12 === 0)
                g.fillRect(0, Math.floor((khi - key) * rowh), rw, 1);
        /* loop marker lines */
        const span = (tl.loopS1 > tl.loopS0 && tl.loopS0 >= 0)
                     ? tl.loopS1 - tl.loopS0 : 0;
        for (let k = 0; k < (loopOn && span > 0 ? 3 : 1); k++) {
            const off = k * span;
            if (tl.loopS0 >= 0) {
                const x = Math.floor((tl.loopS0 + off - v0) / T * rw);
                if (x >= 0 && x < rw) {
                    g.fillStyle = "#466e46";
                    g.fillRect(x, 0, 1, rh);
                }
            }
            if (tl.loopS1 >= 0) {
                const x = Math.floor((tl.loopS1 + off - v0) / T * rw);
                if (x >= 0 && x < rw) {
                    g.fillStyle = "#6e503c";
                    g.fillRect(x, 0, 1, rh);
                }
            }
        }
        /* notes: pass 0 verbatim; when looping, ghost passes for the body */
        const hh = Math.max(2, Math.floor(rowh) - 1);
        const npass = loopOn && span > 0 ? 3 : 1;
        for (let k = 0; k < npass; k++) {
            const off = k * span;
            for (const n of tl.notes) {
                if (k > 0 && n.t0 < tl.loopS0) continue;
                const t0 = n.t0 + off, t1 = n.t1 + off;
                if (t1 < v0 || t0 > v0 + T) continue;
                let x0 = Math.floor((t0 - v0) / T * rw);
                let x1 = Math.floor((t1 - v0) / T * rw);
                if (x0 < 0) x0 = 0;
                if (x1 > rw) x1 = rw;
                if (x1 - x0 < 2) x1 = x0 + 2;
                const y = Math.floor((khi - n.key) * rowh);
                const env = this.act[n.ch * 128 + n.key]!;
                const sounding = env > 0 && t0 <= dpos && dpos <= t1;
                const bri = sounding
                    ? 0.65 + 0.35 * Math.sqrt(env / 32767)
                    : 0.28 + 0.30 * (n.vel / 127);
                const [r, gg, b] = CH_RGB[n.ch]!;
                g.fillStyle = `rgb(${(r * bri) | 0},${(gg * bri) | 0},${(b * bri) | 0})`;
                g.fillRect(x0, y, x1 - x0, hh);
                if (sounding) {
                    g.fillStyle = "rgba(255,255,255,0.7)";
                    g.fillRect(x0, y, x1 - x0, 1);
                }
            }
        }
        /* playhead */
        g.fillStyle = "rgba(255,255,255,0.35)";
        g.fillRect(Math.floor(0.35 * rw) - 1, 0, 2, rh);
    }

    private drawSlots(s: Snapshot | null, used: number): void {
        const c = ctx2d(this.slots);
        if (!c) return;
        const { g, w, h } = c;
        g.fillStyle = "#181a21";
        g.fillRect(0, 0, w, h);
        g.font = FONT;
        g.fillStyle = DIM;
        g.textBaseline = "top";
        g.fillText(`SLOTS ${used}/48 PEAK ${s?.stats.peak_voices ?? 0}`
                   + ` DROPS ${s?.stats.notes_dropped ?? 0}`, 8, 3);
        const cw = Math.floor((w - 16) / NVOICES);
        const y = 16, bh = h - 22;
        for (let i = 0; i < NVOICES; i++) {
            const x = 8 + i * cw;
            g.fillStyle = "#22242d";
            g.fillRect(x, y, cw - 2, bh);
            if (!s) continue;
            const f = s.voices[i * 4]!;
            if (!(f & 1)) continue;
            const env = s.voices[i * 4 + 3]!;
            const lv = Math.sqrt(env / 32767);
            let [r, gg, b] = CH_RGB[s.voices[i * 4 + 1]! & 15]!;
            if (f & 4) {           /* released: bgmplay's warm fade tint */
                r = Math.min(255, r * 0.6 + 90);
                gg = gg * 0.5;
                b = b * 0.5;
            }
            const vh = Math.max(2, Math.floor(lv * bh));
            g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
            g.fillRect(x, y + bh - vh, cw - 2, vh);
        }
    }

    private drawWave(): void {
        const c = ctx2d(this.wave);
        if (!c) return;
        const { g, w, h } = c;
        g.fillStyle = "#0e0f13";
        g.fillRect(0, 0, w, h);
        const half = Math.floor(h / 2);
        const lc = Math.floor(half / 2), rc = half + Math.floor(half / 2);
        g.fillStyle = "#282c36";
        g.fillRect(0, lc, w, 1);
        g.fillRect(0, rc, w, 1);
        const sc = half / 2 - 3;
        const ww = Math.floor(w);
        for (let i = 0; i < ww; i++) {
            const idx = ((this.whead - 1 - i + 2 * WCOL_N) % WCOL_N) * 5;
            const lmin = this.wcol[idx]!, lmax = this.wcol[idx + 1]!;
            const rmin = this.wcol[idx + 2]!, rmax = this.wcol[idx + 3]!;
            const clip = this.wcol[idx + 4]!;
            if (lmin === 0 && lmax === 0 && rmin === 0 && rmax === 0 && !clip)
                continue;
            const x = ww - 1 - i;
            g.fillStyle = clip ? BAD : "#76cd82";
            let y0 = lc - Math.floor(Math.min(lmax, 1) * sc);
            let y1 = lc - Math.floor(Math.max(lmin, -1) * sc);
            g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
            y0 = rc - Math.floor(Math.min(rmax, 1) * sc);
            y1 = rc - Math.floor(Math.max(rmin, -1) * sc);
            g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
        g.font = FONT;
        g.fillStyle = DIM;
        g.textBaseline = "top";
        g.fillText("L", 8, 4);
        g.fillText("R", 8, half + 4);
        /* peak meters, right edge: 60 dB range like bgmplay */
        const mh = h - 12;
        const db = (pk: number) =>
            Math.max(0, 1 + 20 * Math.log10(Math.max(pk, 1e-4)) / 60);
        const dbl = db(this.peakL), dbr = db(this.peakR);
        g.fillStyle = "#1e2028";
        g.fillRect(w - 22, 6, 6, mh);
        g.fillRect(w - 12, 6, 6, mh);
        g.fillStyle = this.peakL > 0.999 ? BAD : GOOD;
        g.fillRect(w - 22, 6 + Math.floor(mh * (1 - dbl)), 6, Math.floor(mh * dbl));
        g.fillStyle = this.peakR > 0.999 ? BAD : GOOD;
        g.fillRect(w - 12, 6 + Math.floor(mh * (1 - dbr)), 6, Math.floor(mh * dbr));
    }
}
