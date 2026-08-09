import { u16 } from "./bytes.ts";

export const IPC_HEADER_SIZE = 0x10;
const IPU_FRAME_END_SIZE = 4;

export interface IpcInfo {
    version: number;
    format: number;
    width: number;
    height: number;
    control: number;
    ipuFlags: number;
    decodeCommand: number;
    qwordCount: number;
    payloadOffset: number;
    payloadSize: number;
    frameDataSize: number;
    paddingSize: number;
}

function isFrameEnd(data: Uint8Array, offset: number): boolean {
    return data[offset] === 0 && data[offset + 1] === 0
        && data[offset + 2] === 1 && data[offset + 3] === 0xb0;
}

/** Validate an AE3 IPC wrapper and return its IPU frame metadata. */
export function inspectIpc(data: Uint8Array, path = "IPC"): IpcInfo {
    if (data.length < IPC_HEADER_SIZE || data[0] !== 0x69 || data[1] !== 0x70
        || data[2] !== 0x63 || data[3] !== 0)
        throw new Error(`${path}: not an IPC image`);

    const version = u16(data, 4);
    const format = u16(data, 6);
    const width = u16(data, 8);
    const height = u16(data, 10);
    const control = u16(data, 12);
    const qwordCount = u16(data, 14);
    const payloadSize = qwordCount * 16;
    const expectedSize = IPC_HEADER_SIZE + payloadSize;
    if (data.length !== expectedSize)
        throw new Error(`${path}: IPC size ${data.length} does not match qword count ${qwordCount} (${expectedSize})`);
    if (!width || !height)
        throw new Error(`${path}: IPC has invalid dimensions ${width}x${height}`);

    let delimiterOffset = -1;
    let delimiters = 0;
    for (let offset = IPC_HEADER_SIZE;
         offset + IPU_FRAME_END_SIZE <= data.length; offset++) {
        if (!isFrameEnd(data, offset)) continue;
        delimiterOffset = offset;
        delimiters++;
    }
    if (delimiters !== 1)
        throw new Error(`${path}: IPC contains ${delimiters} IPU frame delimiters`);

    const frameEnd = delimiterOffset + IPU_FRAME_END_SIZE;
    for (let offset = frameEnd; offset < data.length; offset++) {
        if (data[offset] !== 0)
            throw new Error(`${path}: IPC has nonzero data after its frame delimiter`);
    }

    return {
        version,
        format,
        width,
        height,
        control,
        ipuFlags: control & 0xff,
        decodeCommand: version === 0
            ? 0x10 : ((format >>> 8) & 0xf0) | (format & 0x0f),
        qwordCount,
        payloadOffset: IPC_HEADER_SIZE,
        payloadSize,
        frameDataSize: frameEnd - IPC_HEADER_SIZE,
        paddingSize: data.length - frameEnd,
    };
}

/**
 * Convert one IPC to the conventional one-frame `ipum` wrapper. AE3 stores the
 * IPU control byte at IPC offset 0x0c, not at the start of its macroblock data;
 * the bridge inserts that byte and removes IPC's qword-allocation padding.
 */
export function ipcToIpum(data: Uint8Array, path = "IPC"): Uint8Array {
    const info = inspectIpc(data, path);
    const out = new Uint8Array(IPC_HEADER_SIZE + 1 + info.frameDataSize);
    out.set([0x69, 0x70, 0x75, 0x6d]); // "ipum"
    const view = new DataView(out.buffer);
    view.setUint32(4, out.length, true);
    view.setUint16(8, info.width, true);
    view.setUint16(10, info.height, true);
    view.setUint32(12, 1, true);
    out[IPC_HEADER_SIZE] = info.ipuFlags;
    out.set(data.subarray(info.payloadOffset,
                          info.payloadOffset + info.frameDataSize),
            IPC_HEADER_SIZE + 1);
    return out;
}
