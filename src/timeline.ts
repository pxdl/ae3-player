/* Single-pass song timeline, ported from bgmplay.c (build_timeline_locked /
 * tmap_sample / display_pos) against the same public introspection surface:
 * the parsed event list arrives from the worklet packed as
 * [tick, kind, status, a, b, uspqn] x n (see engine.mjs load()).
 *
 * displayPos() maps the synth's absolute render position back onto this
 * single-pass timeline with loops unwound through the sequencer's own
 * effective-tick clock (ae3synth.h ae3_clock). */

export const RATE = 48000;

/* AE3_EV_* -- ABI constants from ae3synth.h, fixed with the wasm build. */
export const EV_CH = 0, EV_TEMPO = 1, EV_END = 2,
             EV_LOOP_START = 3, EV_LOOP_END = 4;

export interface TempoSeg { tick: number; sample: number; spt: number; }

/* one piano-roll note span (bgmplay vnote_t), timeline samples */
export interface VNote { t0: number; t1: number; ch: number; key: number; vel: number; }

export interface Timeline {
    ppqn: number;
    tmap: TempoSeg[];
    lenSamp: number;           /* single-pass length, samples */
    loopS0: number;            /* loop start/end, samples; -1 = no marker */
    loopS1: number;
    keyLo: number;             /* note range for the piano roll */
    keyHi: number;
    notes: VNote[];
}

export interface DisplayClock {   /* snapshot of ae3_clock */
    seg_tick: number;
    seg_sample: number;
    spt: number;
    tick_offset: number;
}

export function buildTimeline(ev: Uint32Array, ppqn: number): Timeline {
    const tmap: TempoSeg[] = [];
    let spt = RATE * 500000.0 / (1e6 * ppqn);   /* MIDI default 120 BPM */
    let segS = 0, segT = 0;
    tmap.push({ tick: 0, sample: 0, spt });
    let lenSamp = 0, loopS0 = -1, loopS1 = -1;
    let keyLo = 127, keyHi = 0, last = 0;
    const notes: VNote[] = [];
    const open: number[] = [];      /* indices of unclosed notes, oldest first */

    for (let i = 0; i + 6 <= ev.length; i += 6) {
        const tick = ev[i]!, kind = ev[i + 1]!;
        const status = ev[i + 2]!, a = ev[i + 3]!, b = ev[i + 4]!;
        const ts = segS + (tick - segT) * spt;
        if (ts > last) last = ts;
        switch (kind) {
        case EV_TEMPO:
            segS = ts; segT = tick;
            spt = RATE * ev[i + 5]! / (1e6 * ppqn);
            tmap.push({ tick, sample: ts, spt });
            break;
        case EV_LOOP_START: loopS0 = ts; break;
        case EV_LOOP_END:   loopS1 = ts; break;
        case EV_END:        lenSamp = ts; break;
        case EV_CH: {
            const hi = status & 0xf0, ch = status & 0x0f;
            if (hi === 0x90 && b > 0) {
                if (a < keyLo) keyLo = a;
                if (a > keyHi) keyHi = a;
                open.push(notes.length);
                notes.push({ t0: ts, t1: -1, ch, key: a, vel: b });
            } else if (hi === 0x80 || (hi === 0x90 && b === 0)) {
                for (let k = 0; k < open.length; k++) {   /* oldest match first */
                    const v = notes[open[k]!]!;
                    if (v.ch === ch && v.key === a) {
                        v.t1 = ts;
                        open.splice(k, 1);
                        break;
                    }
                }
            }
            break;
        }
        }
    }
    if (lenSamp <= 0) lenSamp = last;
    for (const i of open) notes[i]!.t1 = lenSamp;
    if (keyLo > keyHi) { keyLo = 48; keyHi = 72; }
    return { ppqn, tmap, lenSamp, loopS0, loopS1, keyLo, keyHi, notes };
}

/** Sample position of an ORIGINAL-timeline tick, through the tempo map. */
export function tmapSample(tl: Timeline, otick: number): number {
    let i = tl.tmap.length - 1;
    while (i > 0 && tl.tmap[i]!.tick > otick) i--;
    const s = tl.tmap[i]!;
    return s.sample + (otick - s.tick) * s.spt;
}

/** Absolute render position -> single-pass timeline sample (loops unwound). */
export function displayPos(tl: Timeline, pos: number, ck: DisplayClock): number {
    if (ck.tick_offset === 0 || ck.spt <= 0) return pos;
    const eff = ck.seg_tick + (pos - ck.seg_sample) / ck.spt;
    return tmapSample(tl, eff - ck.tick_offset);
}

/** Live BPM from the snapshot clock (ae3synth.h: 60*RATE/(spt*ppqn)). */
export function bpmOf(tl: Timeline, ck: DisplayClock): number {
    return ck.spt > 0 ? 60 * RATE / (ck.spt * tl.ppqn) : 0;
}
