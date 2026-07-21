/* Ape Escape 3 FMV and subtitle formats. The desktop differ oracles are
 * tools/ae3tools/{strextract,sbt2srt}.py; docs/formats/FMV.md is the spec. */

import { f32, u32 } from "./bytes.ts";
import { type Vfi, type VfiEntry } from "./vfi.ts";

const SECTOR = 0x800;
const GROUP_TAG = "GroupOfDataInfo";
const VIDEO_TAG = "Mpeg2Video";
const GROUP_TAG_BYTES = new TextEncoder().encode(`${GROUP_TAG}\0`);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FRAME_RATES: Readonly<Record<number, number>> = {
    1: 24000 / 1001,
    2: 24,
    3: 25,
    4: 30000 / 1001,
    5: 30,
    6: 50,
    7: 60000 / 1001,
    8: 60,
};
const ADPCM_COEFFICIENTS: readonly (readonly [number, number])[] = [
    [0, 0], [60, 0], [115, -52], [98, -55], [122, -60],
];

export interface FmvAsset {
    name: string;
    movie: VfiEntry;
    subtitleBin: VfiEntry | null;
    subtitleSbt: VfiEntry | null;
}

export interface FmvHeader {
    fields: number;
    fieldRate: number;
    groups: number;
    sampleRate: number;
    channels: number;
    interleave: number;
    audioBlock: number;
    preload: number;
    audioBytes: number;
}

export interface FmvVideoInfo {
    width: number;
    height: number;
    frameRate: number;
    fieldOrder: "progressive" | "tt" | "bb";
    sampleAspect: readonly [7, 6];
    displayAspect: readonly [number, number];
}

export interface Mpeg2SeekPoint {
    offset: number;
    frame: number;
}

export interface Mpeg2SeekIndex {
    frames: number;
    points: readonly Mpeg2SeekPoint[];
}

export interface FmvGroup {
    fields: number;
    videoChunks: number;
    unknown: number;
}

export interface FmvDemux {
    header: FmvHeader;
    video: Uint8Array;
    wav: Uint8Array;
    groups: readonly FmvGroup[];
    videoInfo: FmvVideoInfo;
}

export interface SubtitleCue {
    index: number;
    start: number;
    end: number;
    text: string;
}

interface ChunkRange {
    start: number;
    size: number;
}

interface ContainerLayout {
    header: FmvHeader;
    video: ChunkRange[];
    audio: ChunkRange[];
    groups: FmvGroup[];
    videoBytes: number;
}

function fail(source: string, offset: number, message: string): never {
    throw new Error(`${source} at 0x${offset.toString(16)}: ${message}`);
}

function requireRange(bytes: Uint8Array, offset: number, size: number,
                      source: string, label: string): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
            || offset < 0 || size < 0 || offset + size > bytes.length)
        fail(source, Math.max(0, offset),
             `${label} range ends at 0x${(offset + size).toString(16)}, `
             + `past EOF 0x${bytes.length.toString(16)}`);
}

function allZero(bytes: Uint8Array, start: number, end: number): boolean {
    for (let i = start; i < end; i++)
        if (bytes[i] !== 0) return false;
    return true;
}

function gcd(a: number, b: number): number {
    while (b !== 0) [a, b] = [b, a % b];
    return a;
}

function tagAt(bytes: Uint8Array, offset: number): string {
    let end = offset;
    while (end < offset + 16 && bytes[end] !== 0) end++;
    return new TextDecoder("ascii").decode(bytes.subarray(offset, end));
}

function findTag(bytes: Uint8Array, tag: Uint8Array, start: number): number {
    const limit = bytes.length - tag.length;
    outer: for (let offset = start; offset <= limit; offset++) {
        for (let i = 0; i < tag.length; i++)
            if (bytes[offset + i] !== tag[i]) continue outer;
        return offset;
    }
    return -1;
}

export function locateFmvAssets(vfi: Vfi): FmvAsset[] {
    const movies = vfi.entries.filter(entry =>
        /(^|\/)movie\/[^/]+\.str$/i.test(entry.path));
    if (movies.length === 0) throw new Error("no movie/*.str assets found in DATA.BIN");

    const byDirectory = new Map<string, VfiEntry[]>();
    for (const movie of movies) {
        const directory = movie.path.slice(0, movie.path.lastIndexOf("/"));
        const entries = byDirectory.get(directory);
        if (entries) entries.push(movie);
        else byDirectory.set(directory, [movie]);
    }
    const [directory, selected] = [...byDirectory.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    const inDirectory = new Map(vfi.entries
        .filter(entry => entry.path.startsWith(`${directory}/`)
            && !entry.path.slice(directory.length + 1).includes("/"))
        .map(entry => [entry.name.toLowerCase(), entry]));

    return selected.map(movie => {
        const name = movie.name.replace(/\.str$/i, "");
        const match = /^new_(scene\d\d)$/i.exec(name);
        if (!match) return { name, movie, subtitleBin: null, subtitleSbt: null };
        const key = match[1].toLowerCase();
        const subtitleBin = inDirectory.get(`${key}.bin`) ?? null;
        const subtitleSbt = inDirectory.get(`${key}.sbt`) ?? null;
        if ((subtitleBin === null) !== (subtitleSbt === null))
            throw new Error(`${movie.path}: incomplete subtitle pair for ${key}`);
        return { name, movie, subtitleBin, subtitleSbt };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function parseFmvHeader(bytes: Uint8Array, source = "FMV"): FmvHeader {
    requireRange(bytes, 0, SECTOR, source, "header sector");
    if (bytes[0] !== 0x73 || bytes[1] !== 0x74 || bytes[2] !== 0x72 || bytes[3] !== 0)
        fail(source, 0, "bad str magic");
    if (!allZero(bytes, 0x38, SECTOR)) fail(source, 0x38, "nonzero header padding");

    const fields = u32(bytes, 0x08);
    const rawFieldRate = u32(bytes, 0x0c);
    const groups = u32(bytes, 0x10);
    const sampleRate = u32(bytes, 0x20);
    const channels = u32(bytes, 0x24);
    const interleave = u32(bytes, 0x28);
    const audioBlock = u32(bytes, 0x2c);
    const preload = u32(bytes, 0x30);
    const audioBytes = u32(bytes, 0x34);
    if ([fields, rawFieldRate, groups, sampleRate, channels, interleave,
         audioBlock, preload, audioBytes].some(value => value === 0))
        fail(source, 0x08, "zero required header value");
    const channelGroup = interleave * channels;
    if (!Number.isSafeInteger(channelGroup) || interleave % 16 !== 0
            || audioBlock % channelGroup !== 0 || preload % channelGroup !== 0)
        fail(source, 0x24, "invalid channel/interleave arithmetic");
    const expectedAudio = preload + (groups - 1) * audioBlock;
    if (audioBytes !== expectedAudio)
        fail(source, 0x34, `audio total ${audioBytes} != ${expectedAudio}`);
    return {
        fields,
        fieldRate: rawFieldRate / 100,
        groups,
        sampleRate,
        channels,
        interleave,
        audioBlock,
        preload,
        audioBytes,
    };
}

function readChunk(bytes: Uint8Array, offset: number, expected: string,
                   source: string): { range: ChunkRange; next: number } {
    requireRange(bytes, offset, 32, source, `${expected} header`);
    const actual = tagAt(bytes, offset);
    if (actual !== expected) fail(source, offset, `expected ${expected}, found ${actual || "empty"}`);
    const size = u32(bytes, offset + 0x14);
    if (u32(bytes, offset + 0x18) !== 0 || u32(bytes, offset + 0x1c) !== 0)
        fail(source, offset + 0x18, "nonzero chunk reserved word");
    const start = offset + 32;
    const paddedEnd = start + ((size + 15) & ~15);
    requireRange(bytes, start, size, source, `${expected} payload`);
    requireRange(bytes, start, paddedEnd - start, source, `${expected} padded payload`);
    if (!allZero(bytes, start + size, paddedEnd))
        fail(source, start + size, "nonzero chunk padding");
    return { range: { start, size }, next: paddedEnd };
}

function inspectContainer(bytes: Uint8Array, source: string): ContainerLayout {
    const header = parseFmvHeader(bytes, source);
    requireRange(bytes, SECTOR, header.preload, source, "audio preload");
    const video: ChunkRange[] = [];
    const audio: ChunkRange[] = [{ start: SECTOR, size: header.preload }];
    const groups: FmvGroup[] = [];
    let offset = SECTOR + header.preload;
    let videoBytes = 0;

    for (let groupIndex = 0; groupIndex < header.groups; groupIndex++) {
        const groupChunk = readChunk(bytes, offset, GROUP_TAG, source);
        if (groupChunk.range.size !== 16)
            fail(source, groupChunk.range.start,
                 `group payload is ${groupChunk.range.size} bytes instead of 16`);
        const groupOffset = groupChunk.range.start;
        const group: FmvGroup = {
            fields: u32(bytes, groupOffset),
            videoChunks: u32(bytes, groupOffset + 4),
            unknown: u32(bytes, groupOffset + 8),
        };
        if (u32(bytes, groupOffset + 12) !== 0)
            fail(source, groupOffset + 12, "nonzero group reserved word");
        groups.push(group);
        offset = groupChunk.next;

        for (let chunkIndex = 0; chunkIndex < group.videoChunks; chunkIndex++) {
            const chunk = readChunk(bytes, offset, VIDEO_TAG, source);
            video.push(chunk.range);
            videoBytes += chunk.range.size;
            if (!Number.isSafeInteger(videoBytes))
                fail(source, offset, "video size exceeds safe integer range");
            offset = chunk.next;
        }

        if (groupIndex < header.groups - 1) {
            const nextGroup = findTag(bytes, GROUP_TAG_BYTES, offset);
            if (nextGroup < 0) fail(source, offset, "missing following GroupOfDataInfo");
            const gapSize = nextGroup - offset;
            if (gapSize < header.audioBlock)
                fail(source, offset, `audio gap ${gapSize} is smaller than ${header.audioBlock}`);
            const audioStart = nextGroup - header.audioBlock;
            if (!allZero(bytes, offset, audioStart))
                fail(source, offset, "nonzero leading audio-gap padding");
            audio.push({ start: audioStart, size: header.audioBlock });
            offset = nextGroup;
        }
    }

    if (!allZero(bytes, offset, bytes.length)) fail(source, offset, "nonzero trailing data");
    const fields = groups.reduce((sum, group) => sum + group.fields, 0);
    if (fields !== header.fields)
        fail(source, 0x08, `group fields ${fields} != header ${header.fields}`);
    const audioBytes = audio.reduce((sum, range) => sum + range.size, 0);
    if (audioBytes !== header.audioBytes)
        fail(source, 0x34, `walked ${audioBytes} audio bytes, header declares ${header.audioBytes}`);
    return { header, video, audio, groups, videoBytes };
}

class BitReader {
    private bit = 0;
    private readonly bytes: Uint8Array;
    constructor(bytes: Uint8Array) { this.bytes = bytes; }
    read(count: number): number {
        if (count < 0 || this.bit + count > this.bytes.length * 8)
            throw new Error("truncated MPEG bit field");
        let value = 0;
        for (let i = 0; i < count; i++) {
            const bit = (this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1;
            value = value * 2 + bit;
            this.bit++;
        }
        return value;
    }
}

function startCodes(video: Uint8Array): { code: number; payload: Uint8Array; offset: number }[] {
    const codes = [];
    for (let offset = 0; offset + 4 <= video.length; offset++) {
        if (video[offset] !== 0 || video[offset + 1] !== 0 || video[offset + 2] !== 1)
            continue;
        let end = offset + 4;
        while (end + 3 < video.length
                && !(video[end] === 0 && video[end + 1] === 0 && video[end + 2] === 1)) end++;
        codes.push({ code: video[offset + 3], payload: video.subarray(offset + 4, end), offset });
        offset = end - 1;
    }
    return codes;
}

export function indexMpeg2SeekPoints(video: Uint8Array,
                                     source = "MPEG-2"): Mpeg2SeekIndex {
    const points: Mpeg2SeekPoint[] = [];
    let sequenceOffset = -1;
    let gopOffset = -1;
    let frames = 0;
    for (const item of startCodes(video)) {
        if (item.code === 0xb3) {
            sequenceOffset = item.offset;
            gopOffset = -1;
            continue;
        }
        if (item.code === 0xb8) {
            gopOffset = item.offset;
            continue;
        }
        if (item.code !== 0x00) continue;

        const bits = new BitReader(item.payload);
        let temporalReference: number;
        let pictureType: number;
        try {
            temporalReference = bits.read(10);
            pictureType = bits.read(3);
        } catch (error) {
            fail(source, item.offset, (error as Error).message);
        }
        if (pictureType! < 1 || pictureType! > 3)
            fail(source, item.offset, `unsupported MPEG picture type ${pictureType!}`);
        if (pictureType === 1 && sequenceOffset >= 0 && gopOffset > sequenceOffset) {
            if (temporalReference! !== 0)
                fail(source, item.offset,
                     `indexed I-picture temporal reference ${temporalReference!} is not zero`);
            points.push({ offset: sequenceOffset, frame: frames });
            sequenceOffset = -1;
            gopOffset = -1;
        }
        frames++;
    }
    if (frames === 0) fail(source, 0, "missing MPEG picture headers");
    if (points.length === 0 || points[0].frame !== 0)
        fail(source, 0, "missing initial sequence/GOP/I-picture seek anchor");
    return { frames, points };
}

export function parseMpeg2VideoInfo(video: Uint8Array, source = "MPEG-2"): FmvVideoInfo {
    const codes = startCodes(video);
    const sequence = codes.find(item => item.code === 0xb3);
    if (!sequence) fail(source, 0, "missing sequence header");
    let bits = new BitReader(sequence.payload);
    let width: number;
    let height: number;
    let frameRateCode: number;
    try {
        width = bits.read(12);
        height = bits.read(12);
        bits.read(4);
        frameRateCode = bits.read(4);
    } catch (error) {
        fail(source, sequence.offset, (error as Error).message);
    }
    const frameRate = FRAME_RATES[frameRateCode!];
    if (!width! || !height! || frameRate === undefined)
        fail(source, sequence.offset, "invalid sequence dimensions or frame rate");

    let progressiveSequence: boolean | null = null;
    let progressiveFrame: boolean | null = null;
    let topFieldFirst: boolean | null = null;
    for (const item of codes) {
        if (item.code !== 0xb5 || item.payload.length === 0) continue;
        bits = new BitReader(item.payload);
        let extension: number;
        try { extension = bits.read(4); }
        catch { fail(source, item.offset, "truncated extension identifier"); }
        if (extension! === 1 && progressiveSequence === null) {
            try {
                bits.read(8);
                progressiveSequence = bits.read(1) === 1;
                bits.read(2);
                width! += bits.read(2) << 12;
                height! += bits.read(2) << 12;
            } catch { fail(source, item.offset, "truncated sequence extension"); }
        } else if (extension! === 8 && progressiveFrame === null) {
            try {
                bits.read(16);
                bits.read(2);
                bits.read(2);
                topFieldFirst = bits.read(1) === 1;
                bits.read(7);
                progressiveFrame = bits.read(1) === 1;
            } catch { fail(source, item.offset, "truncated picture coding extension"); }
        }
        if (progressiveSequence === true
                || (progressiveSequence === false && progressiveFrame !== null))
            break;
    }
    if (progressiveSequence === null) fail(source, sequence.offset, "missing sequence extension");
    if (!progressiveSequence && (topFieldFirst === null || progressiveFrame === null))
        fail(source, sequence.offset, "missing picture coding extension field metadata");
    const progressive = progressiveSequence || progressiveFrame === true;

    const divisor = gcd(width! * 7, height! * 6);
    return {
        width: width!,
        height: height!,
        frameRate,
        fieldOrder: progressive ? "progressive" : topFieldFirst ? "tt" : "bb",
        sampleAspect: [7, 6],
        displayAspect: [width! * 7 / divisor, height! * 6 / divisor],
    };
}

/** Inspect the header and first video chunk without reading the full movie.
 *  The caller must provide a prefix through that complete chunk. */
export function inspectFmvPrefix(bytes: Uint8Array, source = "FMV"):
        { header: FmvHeader; videoInfo: FmvVideoInfo } {
    const header = parseFmvHeader(bytes, source);
    requireRange(bytes, SECTOR, header.preload, source, "audio preload");
    const group = readChunk(bytes, SECTOR + header.preload, GROUP_TAG, source);
    if (group.range.size !== 16)
        fail(source, group.range.start,
             `group payload is ${group.range.size} bytes instead of 16`);
    const videoChunks = u32(bytes, group.range.start + 4);
    if (videoChunks === 0) fail(source, group.range.start + 4, "first group has no video");
    const video = readChunk(bytes, group.next, VIDEO_TAG, source).range;
    return {
        header,
        videoInfo: parseMpeg2VideoInfo(
            bytes.subarray(video.start, video.start + video.size), `${source} video`),
    };
}

/** Read only the bytes needed to inspect one movie in a VFI archive. */
export async function inspectFmvAsset(vfi: Vfi, movie: VfiEntry,
                                     source = movie.path):
        Promise<{ header: FmvHeader; videoInfo: FmvVideoInfo }> {
    const base = vfi.byteOffset(movie);
    const headerBytes = await vfi.src.read(base, SECTOR);
    const header = parseFmvHeader(headerBytes, source);
    const groupOffset = SECTOR + header.preload;
    const skeleton = await vfi.src.read(base + groupOffset, 80);
    requireRange(skeleton, 0, 80, source, "first group and video headers");
    const videoSize = u32(skeleton, 48 + 0x14);
    const prefixSize = groupOffset + 48 + 32 + Math.ceil(videoSize / 16) * 16;
    if (!Number.isSafeInteger(prefixSize)
            || prefixSize < groupOffset || prefixSize > movie.size)
        fail(source, groupOffset + 48 + 0x14,
             `first video chunk ends at 0x${prefixSize.toString(16)}, `
             + `past movie EOF 0x${movie.size.toString(16)}`);
    const prefix = await vfi.src.read(base, prefixSize);
    if (prefix.length !== prefixSize)
        fail(source, prefix.length,
             `short read (${prefix.length} of ${prefixSize} inspection bytes)`);
    return inspectFmvPrefix(prefix, source);
}

function writeWavHeader(wav: Uint8Array, channels: number, sampleRate: number,
                        bodyBytes: number): void {
    wav.set(new TextEncoder().encode("RIFF"), 0);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    view.setUint32(4, 36 + bodyBytes, true);
    wav.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    wav.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, bodyBytes, true);
}

function decodeAudio(bytes: Uint8Array, ranges: readonly ChunkRange[],
                     header: FmvHeader, source: string): Uint8Array {
    const bytesPerChannel = header.audioBytes / header.channels;
    if (bytesPerChannel % 16 !== 0)
        fail(source, 0x34, "per-channel audio is not a whole number of ADPCM frames");
    const samplesPerChannel = bytesPerChannel / 16 * 28;
    const bodyBytes = samplesPerChannel * header.channels * 2;
    const wav = new Uint8Array(44 + bodyBytes);
    writeWavHeader(wav, header.channels, header.sampleRate, bodyBytes);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const histories = Array.from({ length: header.channels }, () => [0, 0]);
    const sampleOffsets = new Uint32Array(header.channels);
    const channelGroup = header.interleave * header.channels;

    for (const range of ranges) {
        if (range.size % channelGroup !== 0)
            fail(source, range.start, "audio range is not interleave-group aligned");
        for (let group = range.start; group < range.start + range.size; group += channelGroup) {
            for (let channel = 0; channel < header.channels; channel++) {
                const blockEnd = group + (channel + 1) * header.interleave;
                let frame = group + channel * header.interleave;
                for (; frame < blockEnd; frame += 16) {
                    let shift = bytes[frame] & 0x0f;
                    let filter = (bytes[frame] >> 4) & 0x0f;
                    if (shift > 12) shift = 9;
                    if (filter > 4) filter = 0;
                    const [coefficient0, coefficient1] = ADPCM_COEFFICIENTS[filter];
                    for (let i = 0; i < 14; i++) {
                        const packed = bytes[frame + 2 + i];
                        for (const nibble of [packed & 0x0f, packed >> 4]) {
                            let sample = nibble << 12;
                            if ((sample & 0x8000) !== 0) sample -= 0x10000;
                            sample >>= shift;
                            sample += (histories[channel][0] * coefficient0
                                + histories[channel][1] * coefficient1) >> 6;
                            sample = Math.max(-32768, Math.min(32767, sample));
                            const sampleIndex = sampleOffsets[channel]++;
                            view.setInt16(44 + (sampleIndex * header.channels + channel) * 2,
                                          sample, true);
                            histories[channel][1] = histories[channel][0];
                            histories[channel][0] = sample;
                        }
                    }
                }
            }
        }
    }
    for (let channel = 0; channel < header.channels; channel++)
        if (sampleOffsets[channel] !== samplesPerChannel)
            fail(source, 0x34, `decoded ${sampleOffsets[channel]} channel-${channel} samples, `
                 + `expected ${samplesPerChannel}`);
    return wav;
}

export function demuxFmv(bytes: Uint8Array, source = "FMV"): FmvDemux {
    const layout = inspectContainer(bytes, source);
    const video = new Uint8Array(layout.videoBytes);
    let write = 0;
    for (const range of layout.video) {
        video.set(bytes.subarray(range.start, range.start + range.size), write);
        write += range.size;
    }
    return {
        header: layout.header,
        video,
        wav: decodeAudio(bytes, layout.audio, layout.header, source),
        groups: layout.groups,
        videoInfo: parseMpeg2VideoInfo(video, `${source} video`),
    };
}

function parseSubtitleTimings(bytes: Uint8Array, source: string):
        { starts: number[]; ends: number[]; total: number } {
    requireRange(bytes, 0, 0x10, source, "sbt header");
    if (bytes[0] !== 0x73 || bytes[1] !== 0x62 || bytes[2] !== 0x74 || bytes[3] !== 0)
        fail(source, 0, "bad sbt magic");
    const count = u32(bytes, 4);
    const expectedSize = 0x10 + count * 0x10;
    if (bytes.length !== expectedSize)
        fail(source, 4, `size ${bytes.length} != 0x10 + ${count}*0x10`);
    const first = f32(bytes, 8);
    const total = f32(bytes, 12);
    if (!Number.isFinite(first) || !Number.isFinite(total) || first < 0 || total < first)
        fail(source, 8, `invalid timing range ${first}..${total}`);
    const starts: number[] = [];
    const ends: number[] = [];
    let previousStart = -1;
    for (let i = 0; i < count; i++) {
        const offset = 0x10 + i * 0x10;
        const index = u32(bytes, offset);
        const reserved = u32(bytes, offset + 4);
        const start = f32(bytes, offset + 8);
        const end = f32(bytes, offset + 12);
        if (index !== i) fail(source, offset, `cue ${i} has index ${index}`);
        if (reserved !== 0) fail(source, offset + 4, "nonzero cue reserved word");
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0
                || start > end || end > total || start < previousStart)
            fail(source, offset + 8, `cue ${i} has invalid range ${start}..${end}`);
        starts.push(start);
        ends.push(end);
        previousStart = start;
    }
    if (count > 0 && first !== starts[0]) fail(source, 8, "first timestamp mismatch");
    if (count > 0 && total !== ends[count - 1]) fail(source, 12, "total duration mismatch");
    return { starts, ends, total };
}

function parseSubtitleText(bytes: Uint8Array, source: string): string[] {
    requireRange(bytes, 0, 0x28, source, "bin header");
    if (u32(bytes, 0) !== 0x72312487) fail(source, 0, "bad bin magic");
    const count = u32(bytes, 4);
    const offsets = [0x08, 0x10, 0x18, 0x20].map(offset => {
        if (u32(bytes, offset + 4) !== 0)
            fail(source, offset + 4, "nonzero section-offset reserved word");
        return u32(bytes, offset);
    });
    const [names, index, records, text] = offsets;
    if (!(0x28 <= names && names <= index && index <= records
            && records <= text && text <= bytes.length))
        fail(source, 8, `invalid section order ${offsets.map(value => `0x${value.toString(16)}`).join(", ")}`);
    requireRange(bytes, names, count * 0x28, source, "name table");
    requireRange(bytes, index, count * 8, source, "index table");
    requireRange(bytes, records, count * 0x18, source, "record table");

    const values: string[] = [];
    for (let i = 0; i < count; i++) {
        const offset = u32(bytes, records + i * 0x18 + 0x14);
        const start = text + offset;
        requireRange(bytes, start, 1, source, `string ${i}`);
        const end = bytes.indexOf(0, start);
        if (end < 0) fail(source, start, `string ${i} is not NUL-terminated`);
        let value: string;
        try { value = UTF8.decode(bytes.subarray(start, end)); }
        catch { fail(source, start, `string ${i} is not strict UTF-8`); }
        const lines = value!.split("\n").filter(line => line.trim().length > 0);
        const textValue = lines.join("\n");
        if (textValue.length === 0) fail(source, start, `string ${i} contains no dialogue`);
        values.push(textValue);
    }
    return values;
}

export function parseFmvSubtitles(bin: Uint8Array, sbt: Uint8Array,
                                  source = "FMV subtitles"): SubtitleCue[] {
    const timings = parseSubtitleTimings(sbt, `${source} .sbt`);
    const text = parseSubtitleText(bin, `${source} .bin`);
    if (text.length !== timings.starts.length)
        throw new Error(`${source}: ${text.length} strings != ${timings.starts.length} timings`);
    return text.map((value, i) => ({
        index: i + 1,
        start: timings.starts[i],
        end: timings.ends[i],
        text: value,
    }));
}

function timestamp(seconds: number, separator: "," | "."): string {
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const wholeSeconds = Math.floor(milliseconds % 60_000 / 1000);
    const fraction = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:`
        + `${String(wholeSeconds).padStart(2, "0")}${separator}${String(fraction).padStart(3, "0")}`;
}

export function subtitlesToSrt(cues: readonly SubtitleCue[]): Uint8Array {
    const text = cues.map(cue => `${cue.index}\n${timestamp(cue.start, ",")} --> `
        + `${timestamp(cue.end, ",")}\n${cue.text}\n`).join("\n");
    return new TextEncoder().encode(text);
}

export function subtitlesToVtt(cues: readonly SubtitleCue[]): Uint8Array {
    const body = cues.map(cue => `${cue.index}\n${timestamp(cue.start, ".")} --> `
        + `${timestamp(cue.end, ".")}\n${cue.text}\n`).join("\n");
    return new TextEncoder().encode(`WEBVTT\n\n${body}`);
}
