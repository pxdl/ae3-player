import { ascii, u32 } from "./bytes.ts";
import { inflateSz } from "./sz.ts";

export const PACKFILE_HEADER_SIZE = 0x40;
export const PACKFILE_MEMBER_HEADER_SIZE = 0x30;

export interface PackfileMember {
    slotIndex: number;
    index: number;
    kind: string;
    name: string;
    headerOffset: number;
    payloadOffset: number;
    size: number;
    reservedZero: boolean;
}

export interface PackfileSlot {
    index: number;
    sourceOffset: number;
    storedSize: number;
    compressedSize: number | null;
    storagePaddingZero: boolean;
    data: Uint8Array;
    usedSize: number;
    markerOffset: number;
    paddingOffset: number;
    paddingSize: number;
    paddingZero: boolean;
    members: PackfileMember[];
}

export interface Packfile {
    slotCount: number;
    slotSize: number;
    compressedSlotStride: number;
    storedSlotSize: number;
    compressed: boolean;
    reservedZero: boolean;
    slots: PackfileSlot[];
}

function requireRange(offset: number, length: number, limit: number,
                      label: string): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || offset + length > limit)
        throw new Error(`${label} exceeds its packfile slot`);
}

function allZero(data: Uint8Array, start: number, end: number): boolean {
    for (let offset = start; offset < end; offset++)
        if (data[offset] !== 0) return false;
    return true;
}

function fixedAscii(data: Uint8Array, offset: number, length: number,
                    label: string): string {
    const end = data.indexOf(0, offset);
    if (end < offset || end >= offset + length)
        throw new Error(`${label} is not NUL-terminated`);
    for (let cursor = offset; cursor < end; cursor++) {
        if (data[cursor]! >= 0x80)
            throw new Error(`${label} is not ASCII`);
    }
    return ascii(data.subarray(offset, end));
}

function isEndMarker(data: Uint8Array, offset: number): boolean {
    return data[offset] === 0x65 && data[offset + 1] === 0x6e
        && data[offset + 2] === 0x64 && data[offset + 3] === 0;
}

async function decodeSlot(stored: Uint8Array, slotSize: number,
                          compressed: boolean, label: string): Promise<{
    data: Uint8Array;
    compressedSize: number | null;
    storagePaddingZero: boolean;
}> {
    if (!compressed)
        return { data: stored, compressedSize: null, storagePaddingZero: true };
    if (stored.length < 0x1a)
        throw new Error(`${label}: compressed slot is too short`);

    const footerOffset = stored.length - 0x10;
    const compressedSize = u32(stored, footerOffset);
    if (compressedSize < 10 || compressedSize > footerOffset)
        throw new Error(`${label}: invalid compressed size ${compressedSize}`);
    const data = await inflateSz(stored.subarray(0, compressedSize));
    if (data.length > slotSize)
        throw new Error(`${label}: inflated to ${data.length} bytes, exceeding slot size ${slotSize}`);
    return {
        data,
        compressedSize,
        storagePaddingZero: allZero(stored, compressedSize, footerOffset)
            && allZero(stored, footerOffset + 4, stored.length),
    };
}

function parseSlot(data: Uint8Array, slotIndex: number, path: string):
        Omit<PackfileSlot, "index" | "sourceOffset" | "storedSize"
            | "compressedSize" | "storagePaddingZero" | "data"> {
    const members: PackfileMember[] = [];
    let offset = 0;
    while (true) {
        requireRange(offset, 4, data.length,
                     `${path}: slot ${slotIndex} end marker`);
        if (isEndMarker(data, offset)) break;
        requireRange(offset, PACKFILE_MEMBER_HEADER_SIZE, data.length,
                     `${path}: slot ${slotIndex} member ${members.length} header`);
        const size = u32(data, offset + 4);
        const payloadOffset = offset + PACKFILE_MEMBER_HEADER_SIZE;
        requireRange(payloadOffset, size, data.length,
                     `${path}: slot ${slotIndex} member ${members.length} payload`);
        members.push({
            slotIndex,
            index: members.length,
            kind: fixedAscii(data, offset, 4,
                `${path}: slot ${slotIndex} member ${members.length} kind`),
            name: fixedAscii(data, offset + 0x10, 0x20,
                `${path}: slot ${slotIndex} member ${members.length} name`),
            headerOffset: offset,
            payloadOffset,
            size,
            reservedZero: allZero(data, offset + 8, offset + 0x10),
        });
        offset = payloadOffset + size;
    }

    const markerOffset = offset;
    const paddingOffset = markerOffset + 4;
    return {
        usedSize: paddingOffset,
        markerOffset,
        paddingOffset,
        paddingSize: data.length - paddingOffset,
        paddingZero: allZero(data, paddingOffset, data.length),
        members,
    };
}

/**
 * Parse an AE3 `packfile`. A nonzero header field at 0x18 selects fixed-size
 * compressed slots: each slot is an SZ stream whose exact byte length is stored
 * in its final 16-byte footer. A zero field stores member streams directly.
 */
export async function parsePackfile(data: Uint8Array,
                                    path = "packfile"): Promise<Packfile> {
    if (data.length < PACKFILE_HEADER_SIZE
        || ascii(data.subarray(0, 8)) !== "packfile")
        throw new Error(`${path}: not a packfile`);

    const slotCount = u32(data, 0x10);
    const slotSize = u32(data, 0x14);
    const compressedSlotStride = u32(data, 0x18);
    const storedSlotSize = compressedSlotStride || slotSize;
    const compressed = compressedSlotStride !== 0;
    if (slotCount > 0 && (slotSize < 4 || storedSlotSize < 4))
        throw new Error(`${path}: invalid slot sizes ${slotSize}/${storedSlotSize}`);
    const expectedSize = PACKFILE_HEADER_SIZE + slotCount * storedSlotSize;
    if (!Number.isSafeInteger(expectedSize) || expectedSize !== data.length)
        throw new Error(`${path}: size ${data.length} does not match ${slotCount} slots of ${storedSlotSize} bytes`);

    const slots: PackfileSlot[] = [];
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
        const sourceOffset = PACKFILE_HEADER_SIZE + slotIndex * storedSlotSize;
        const stored = data.subarray(sourceOffset, sourceOffset + storedSlotSize);
        const decoded = await decodeSlot(
            stored,
            slotSize,
            compressed,
            `${path}: slot ${slotIndex}`,
        );
        slots.push({
            index: slotIndex,
            sourceOffset,
            storedSize: storedSlotSize,
            compressedSize: decoded.compressedSize,
            storagePaddingZero: decoded.storagePaddingZero,
            data: decoded.data,
            ...parseSlot(decoded.data, slotIndex, path),
        });
    }

    return {
        slotCount,
        slotSize,
        compressedSlotStride,
        storedSlotSize,
        compressed,
        reservedZero: allZero(data, 8, 0x10)
            && allZero(data, 0x1c, PACKFILE_HEADER_SIZE),
        slots,
    };
}

/** Return a zero-copy view of one parsed member payload. */
export function packfileMemberBytes(packfile: Packfile,
                                    member: PackfileMember): Uint8Array {
    const slot = packfile.slots[member.slotIndex];
    const end = member.payloadOffset + member.size;
    if (!slot || !Number.isSafeInteger(end) || member.payloadOffset < 0
        || member.size < 0 || end > slot.data.length)
        throw new Error("packfile member exceeds parsed slot data");
    return slot.data.subarray(member.payloadOffset, end);
}
