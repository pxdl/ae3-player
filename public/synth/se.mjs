/* Embedded-SE bank inspection. Shape comes from the public synth API; request
 * timing comes from the same EE-proven bytecode grammar used by the synth. */
import { AE3Synth } from "./ae3synth.mjs";

const SE_TICKS_PER_SECOND = 480;

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

function requestInfo(raw) {
    const byOffset = new Map(raw.map((event, index) => [event.offset, index]));
    const firstTick = new Map();
    const events = [];
    let tick = 0;
    let cursor = 0;
    let jumpCount = 0;
    let notes = 0;
    let controls = 0;
    let finiteLoop = null;

    for (let steps = 0; steps < 10000; steps++) {
        const event = raw[cursor];
        firstTick.set(event.offset, firstTick.get(event.offset) ?? tick);
        if (event.kind === "end") {
            return { durationTicks: tick, notes, controls, loop: finiteLoop, events };
        }

        const shown = { ...event, tick };
        delete shown.delay;
        events.push(shown);
        if (event.kind === "note" || event.kind === "off") notes++;
        else controls++;
        tick += event.delay;

        if (event.kind === "loop") {
            const target = event.args[0] | event.args[1] << 8;
            const count = event.args[2];
            const targetIndex = byOffset.get(target);
            if (targetIndex === undefined) throw new Error("SE jump is not on an event boundary");
            if (count === 0) {
                const startTick = firstTick.get(target);
                if (startTick === undefined) throw new Error("forward infinite SE jump");
                return {
                    durationTicks: tick, notes, controls,
                    loop: {
                        startTick, endTick: tick, cycleTicks: tick - startTick,
                        count: 0,
                    },
                    events,
                };
            }
            if (!finiteLoop) {
                const startTick = firstTick.get(target);
                if (startTick === undefined) throw new Error("forward finite SE jump");
                finiteLoop = {
                    startTick, endTick: tick, cycleTicks: tick - startTick, count,
                };
            }
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

function requestDetails(hd, requestCounts) {
    const d = new DataView(hd.buffer, hd.byteOffset, hd.byteLength);
    if (hd.length < 0x30 || String.fromCharCode(...hd.subarray(0x0c, 0x10)) !== "SShd")
        throw new Error("not an SShd bank");
    const seseq = i32(d, 0x1c);
    const limit = i32(d, 0x20);
    if (seseq < 0 || limit <= seseq || limit > hd.length)
        throw new Error("invalid SE sequence chunk");

    const outer = jam(d, seseq);
    return outer.map((innerOffset, bank) => {
        if (innerOffset === 0xffff || requestCounts[bank] === 0) return [];
        const streams = jam(d, seseq + innerOffset);
        return streams.map((streamOffset) => {
            if (streamOffset === 0xffff) return null;
            const raw = decodeStream(hd, seseq + streamOffset, limit);
            return requestInfo(raw);
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
            details: requestDetails(files.hd, requests),
            ticksPerSecond: SE_TICKS_PER_SECOND,
        };
    } finally {
        synth.dispose();
    }
}
