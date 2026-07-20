/* Embedded-SE bank inspection. Shape comes from the public synth API; request
 * timing comes from the same EE-proven bytecode grammar used by the synth. */
import { AE3Synth } from "./ae3synth.mjs";

const SE_TICKS_PER_SECOND = 480;

const EXACT_FRAMES_PER_TICK = 100;
const CONSOLE_TICK_FRAMES = 800;
const MEASURE_BLOCK = 65536;
const MEASURE_LIMIT = 15 * 60 * 48000;

function u16(d, at) {
    if (at < 0 || at + 2 > d.byteLength) throw new Error("truncated SE table");
    return d.getUint16(at, true);
}

function i16(d, at) {
    if (at < 0 || at + 2 > d.byteLength) throw new Error("truncated SE table");
    return d.getInt16(at, true);
}

function i32(d, at) {
    if (at < 0 || at + 4 > d.byteLength) throw new Error("truncated SE header");
    return d.getInt32(at, true);
}

function jam(d, at) {
    const count = i16(d, at) + 1;
    if (count < 1 || at + 2 + count * 2 > d.byteLength)
        throw new Error("invalid SE offset table");
    return Array.from({ length: count }, (_, i) => u16(d, at + 2 + i * 2));
}

function vlq(bytes, cursor, end) {
    let value = 0;
    for (let n = 0; n < 5 && cursor < end; n++) {
        const byte = bytes[cursor++];
        value = value * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return [value, cursor];
    }
    throw new Error("invalid SE delay");
}

function decodeStream(bytes, start, limit) {
    const raw = [];
    let cursor = start;
    let running = 0;
    while (cursor < limit) {
        const offset = cursor - start;
        let status = bytes[cursor];
        if (status & 0x80) {
            cursor++;
            if (status === 0xff) {
                if (bytes[cursor] !== 0x2f || bytes[cursor + 1] !== 0)
                    throw new Error("invalid SE terminator");
                raw.push({ offset, kind: "end", delay: 0 });
                break;
            }
            running = status;
        } else {
            status = running;
        }

        let event;
        if (status === 0xa0) {
            if (cursor + 3 > limit) throw new Error("truncated SE note");
            const key = bytes[cursor++], velocity = bytes[cursor++];
            const program = bytes[cursor++];
            event = {
                offset, kind: velocity ? "note" : "off",
                key, velocity, program,
            };
        } else if (status === 0xb0) {
            if (cursor >= limit) throw new Error("truncated SE control");
            const command = bytes[cursor++];
            const count = command === 7 || command === 10 || command === 0x41 ? 4 : 3;
            if (cursor + count > limit) throw new Error("truncated SE control");
            const args = Array.from(bytes.subarray(cursor, cursor + count));
            cursor += count;
            event = { offset, kind: command === 0x60 ? "loop" : "control", command, args };
        } else {
            throw new Error(`unsupported SE status 0x${status.toString(16)}`);
        }

        const [delay, next] = vlq(bytes, cursor, limit);
        event.delay = delay;
        raw.push(event);
        cursor = next;
    }
    if (!raw.length || raw.at(-1).kind !== "end")
        throw new Error("unterminated SE request");
    return raw;
}

/* Exact SPU2 ADSR step accounting from the shared core's voice.c. A loop/noise
 * source ends when its decreasing sustain reaches ENVX<2; rising sustain holds. */
const envelopeCache = new Map();

function envelopeFrames(adsr1, adsr2) {
    const key = adsr1 << 16 | adsr2;
    if (envelopeCache.has(key)) return envelopeCache.get(key);

    const run = (params, initial, target) => {
        let level = initial;
        let cycles = 0;
        const done = () => params.rising ? level >= target : level <= target;
        while (!done()) {
            let wait = 2 ** Math.max(0, params.shift - 11);
            if (params.exp && params.rising && level > 0x6000) wait *= 4;
            cycles += wait;
            let step = params.step * 2 ** Math.max(0, 11 - params.shift);
            if (params.exp && !params.rising) {
                step = Math.floor(step * level / 0x8000);
                if (step === 0) step = -1;
            }
            level = Math.max(0, Math.min(0x7fff, level + step));
        }
        return { level, cycles };
    };

    const attack = run({
        shift: adsr1 >> 10 & 0x1f,
        step: 7 - (adsr1 >> 8 & 3),
        exp: !!(adsr1 & 0x8000),
        rising: true,
    }, 0, 0x7fff);
    const sustainLevel = Math.min(0x7fff, ((adsr1 & 0x0f) + 1) * 0x800);
    const decay = run({
        shift: adsr1 >> 4 & 0x0f,
        step: -8,
        exp: true,
        rising: false,
    }, attack.level, sustainLevel);
    let frames;
    if (!(adsr2 & 0x4000)) {
        frames = Infinity;
    } else {
        const sustain = run({
            shift: adsr2 >> 8 & 0x1f,
            step: -8 + (adsr2 >> 6 & 3),
            exp: !!(adsr2 & 0x8000),
            rising: false,
        }, decay.level, 1);
        frames = attack.cycles + decay.cycles + sustain.cycles;
    }
    envelopeCache.set(key, frames);
    return frames;
}

function requestInfo(raw, programs) {
    const byOffset = new Map(raw.map((event, index) => [event.offset, index]));
    const firstTime = new Map();
    const events = [];
    const active = [];
    let tick = 0;
    let exactFrame = 0;
    let consoleFrame = 0;
    let cursor = 0;
    let jumpCount = 0;
    let notes = 0;
    let controls = 0;
    let finiteLoop = null;

    const result = (loop) => {
        const loopVoices = active.filter((voice) => voice.tone.sampleLoop);
        const sustainedVoices =
            loopVoices.filter((voice) => voice.tone.indefinite).length;
        const sourceEndExactFrame = loopVoices.reduce(
            (end, voice) => Math.max(
                end, voice.startExactFrame + voice.tone.envelopeFrames),
            exactFrame);
        const sourceEndConsoleFrame = loopVoices.reduce(
            (end, voice) => Math.max(
                end, voice.startConsoleFrame + voice.tone.envelopeFrames),
            consoleFrame);
        return {
            durationTicks: tick,
            exactFrames: exactFrame,
            consoleFrames: consoleFrame,
            notes,
            controls,
            activeVoices: active.length,
            loopingVoices: loopVoices.length,
            sustainedVoices,
            sustained: sustainedVoices > 0,
            sourceEndExactFrame,
            sourceEndConsoleFrame,
            loop,
            events,
        };
    };

    for (let steps = 0; steps < 10000; steps++) {
        const event = raw[cursor];
        firstTime.set(event.offset, firstTime.get(event.offset) ?? {
            tick, exactFrame, consoleFrame,
        });
        if (event.kind === "end")
            return result(finiteLoop);

        const shown = { ...event, tick, exactFrame, consoleFrame };
        delete shown.delay;
        if (event.kind === "note") {
            const program = programs[event.program];
            const tone = program?.tones[event.key - program.key0];
            if (tone) {
                Object.assign(shown, tone);
                if (tone.cutGroup)
                    for (let i = active.length - 1; i >= 0; i--)
                        if (active[i].tone.cutGroup === tone.cutGroup)
                            active.splice(i, 1);
                active.push({
                    program: event.program, key: event.key, tone,
                    startExactFrame: exactFrame,
                    startConsoleFrame: consoleFrame,
                });
            }
        } else if (event.kind === "off") {
            for (let i = active.length - 1; i >= 0; i--)
                if (active[i].program === event.program && active[i].key === event.key)
                    active.splice(i, 1);
        }
        events.push(shown);
        if (event.kind === "note" || event.kind === "off") notes++;
        else controls++;

        tick += event.delay;
        exactFrame += event.delay * EXACT_FRAMES_PER_TICK;
        consoleFrame += Math.ceil(event.delay / 8) * CONSOLE_TICK_FRAMES;

        if (event.kind === "loop") {
            const target = event.args[0] | event.args[1] << 8;
            const count = event.args[2];
            const targetIndex = byOffset.get(target);
            if (targetIndex === undefined)
                throw new Error("SE jump is not on an event boundary");
            const start = firstTime.get(target);
            if (!start)
                throw new Error(`forward ${count ? "finite" : "infinite"} SE jump`);
            const loop = {
                startTick: start.tick,
                endTick: tick,
                cycleTicks: tick - start.tick,
                startExactFrame: start.exactFrame,
                endExactFrame: exactFrame,
                cycleExactFrames: exactFrame - start.exactFrame,
                startConsoleFrame: start.consoleFrame,
                endConsoleFrame: consoleFrame,
                cycleConsoleFrames: consoleFrame - start.consoleFrame,
                count,
            };
            if (count === 0)
                return result(loop);
            finiteLoop ??= loop;
            if (jumpCount !== count) {
                jumpCount++;
                cursor = targetIndex;
                continue;
            }
            jumpCount = 0;
        }
        cursor++;
    }
    throw new Error("SE request exceeded the control-flow guard");
}

function programDetails(hd, bd) {
    const d = new DataView(hd.buffer, hd.byteOffset, hd.byteLength);
    const base = i32(d, 0x24);
    if (base < 0 || base >= hd.length)
        throw new Error("invalid SE program chunk");
    const offsets = jam(d, base);
    const waveCache = new Map();

    const waveform = (addr) => {
        if (waveCache.has(addr)) return waveCache.get(addr);
        const start = addr * 8;
        let value = { source: "invalid sample", sampleLoop: false, sampleFrames: 0 };
        for (let at = start, frames = 1; at + 16 <= bd.length; at += 16, frames++) {
            const flags = bd[at + 1];
            if (flags & 1) {
                const sampleLoop = !!(flags & 2);
                value = {
                    source: sampleLoop ? "looped sample" : "one-shot sample",
                    sampleLoop,
                    sampleFrames: frames * 28,
                };
                break;
            }
        }
        waveCache.set(addr, value);
        return value;
    };

    return offsets.map((offset) => {
        if (offset === 0xffff) return null;
        const at = base + offset;
        if (at + 8 > hd.length) throw new Error("truncated SE program");
        const key0 = hd[at + 6], key1 = hd[at + 7];
        const count = key1 - key0 + 1;
        if (count < 1 || at + 8 + count * 16 > hd.length)
            throw new Error("truncated SE tone table");
        const tones = Array.from({ length: count }, (_, index) => {
            const toneAt = at + 8 + index * 16;
            const flags = hd[toneAt + 15];
            const noise = !!(flags & 0x02);
            const silent = !noise && u16(d, toneAt + 4) === 0xffff;
            const sample = noise
                ? { source: "SPU2 noise", sampleLoop: true, sampleFrames: 0 }
                : silent
                    ? { source: "silent tone", sampleLoop: false, sampleFrames: 0 }
                    : waveform(u16(d, toneAt + 4));
            const adsr1 = u16(d, toneAt + 6);
            const adsr2 = u16(d, toneAt + 8);
            const envFrames = envelopeFrames(adsr1, adsr2);
            return {
                ...sample,
                root: hd[toneAt + 2],
                cutGroup: hd[toneAt],
                reverb: !!(flags & 0x80),
                noise,
                adsr1,
                adsr2,
                envelopeFrames: envFrames,
                indefinite: !silent && sample.sampleLoop && !Number.isFinite(envFrames),
            };
        });
        return { key0, key1, tones };
    });
}

function requestDetails(hd, bd, requestCounts) {
    const d = new DataView(hd.buffer, hd.byteOffset, hd.byteLength);
    if (hd.length < 0x30 || String.fromCharCode(...hd.subarray(0x0c, 0x10)) !== "SShd")
        throw new Error("not an SShd bank");
    const seseq = i32(d, 0x1c);
    const limit = i32(d, 0x20);
    if (seseq < 0 || limit <= seseq || limit > hd.length)
        throw new Error("invalid SE sequence chunk");

    const programs = programDetails(hd, bd);
    const outer = jam(d, seseq);
    return outer.map((innerOffset, bank) => {
        if (innerOffset === 0xffff || requestCounts[bank] === 0) return [];
        const streams = jam(d, seseq + innerOffset);
        return streams.map((streamOffset) => {
            if (streamOffset === 0xffff) return null;
            const raw = decodeStream(hd, seseq + streamOffset, limit);
            return requestInfo(raw, programs);
        });
    });
}

/** Return request counts plus timing/control metadata by outer bank index. */
export async function inspectSeBank(wasmSource, files) {
    const synth = await AE3Synth.instantiate(wasmSource);
    try {
        synth.loadBank(files.hd, files.bd);
        const banks = synth.seBanks();
        const requests = new Uint16Array(banks);
        for (let bank = 0; bank < banks; bank++)
            requests[bank] = synth.seRequests(bank);
        return {
            requests,
            details: requestDetails(files.hd, files.bd, requests),
            ticksPerSecond: SE_TICKS_PER_SECOND,
        };
    } finally {
        synth.dispose();
    }
}

/** Render a selected request headlessly to get its real audible completion
 * frame, including sample length, ADSR and the hardware reverb tail. Requests
 * with a provably non-decaying loop/noise voice return sustained=true. */
export async function measureSePlayback(wasmSource, files, opts) {
    const synth = await AE3Synth.instantiate(wasmSource);
    try {
        if (files.irx) synth.loadPitchIrx(files.irx);
        synth.loadBank(files.hd, files.bd);
        const banks = synth.seBanks();
        const requests = new Uint16Array(banks);
        for (let bank = 0; bank < banks; bank++)
            requests[bank] = synth.seRequests(bank);
        const info = requestDetails(files.hd, files.bd, requests)
            [opts.bank]?.[opts.request];
        if (!info) throw new Error("SE request is absent");
        if (info.sustained)
            return { frames: null, sustained: true, estimated: false };
        const sourceEnd = opts.exact
            ? info.sourceEndExactFrame
            : info.sourceEndConsoleFrame;
        if (sourceEnd > MEASURE_LIMIT)
            return { frames: sourceEnd, sustained: false, estimated: true };

        synth.loadSe(opts.bank, opts.request);
        synth.setLoop(0);
        synth.setEventTiming(opts.exact ?? true);
        if (files.libsd) synth.loadReverbIrx(files.libsd);
        synth.setReverbDepth(opts.revDepth ?? 30);

        const buffer = new Float32Array(MEASURE_BLOCK * 2);
        let frames = 0;
        while (frames < MEASURE_LIMIT) {
            const n = synth.render(buffer, MEASURE_BLOCK);
            if (n < 0) throw new Error("render: nothing loaded");
            if (n === 0)
                return { frames, sustained: false, estimated: false };
            frames += n;
        }
        throw new Error("SE duration exceeded the 15-minute analysis guard");
    } finally {
        synth.dispose();
    }
}
