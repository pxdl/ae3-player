/* Ape Escape 3 FMV and subtitle formats. The desktop differ oracles are
 * tools/ae3tools/{strextract,sbt2srt}.py; docs/formats/FMV.md is the spec. */

import { f32, u32 } from "./bytes.ts";
import { type Vfi, type VfiEntry } from "./vfi.ts";

const SECTOR = 0x800;
const FIVE_AUDIO_TRACKS = 5;
const FIRST_GROUP_PROBE_BYTES = 80;
const MAX_FIRST_VIDEO_INSPECTION_BYTES = 0x10000;
const MAX_FMV_INSPECTION_PREFIX_BYTES = 0x70000;
const MAX_WAV_BYTES = 64 * 1024 * 1024;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const GROUP_TAG = "GroupOfDataInfo";
const VIDEO_TAG = "Mpeg2Video";
const ENCODER = new TextEncoder();
const ASCII = new TextDecoder("ascii");
const GROUP_TAG_BYTES = fixedTag(GROUP_TAG);
const VIDEO_TAG_BYTES = fixedTag(VIDEO_TAG);
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

export class FmvFormatError extends Error {
    readonly source: string;
    readonly offset: number;
    readonly detail: string;

    constructor(source: string, offset: number, detail: string) {
        super(`${source} at 0x${offset.toString(16)}: ${detail}`);
        this.name = "FmvFormatError";
        this.source = source;
        this.offset = offset;
        this.detail = detail;
    }
}

export interface FmvDiscoveryIssue {
    name: string;
    movie: VfiEntry;
    formatError: FmvFormatError;
}

export type FmvDiscovery = FmvAsset | FmvDiscoveryIssue;

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
    sampleAspect: readonly [number, number];
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

interface ContainerStart {
    groupOffset: number;
    audioTracks: 1 | 5;
    preloadStart: number;
}

interface ContainerLayout {
    header: FmvHeader;
    video: ChunkRange[];
    audio: ChunkRange[];
    groups: FmvGroup[];
    videoBytes: number;
}
interface WavLayout {
    samplesPerChannel: number;
    bodyBytes: number;
    totalBytes: number;
    riffBytes: number;
    byteRate: number;
    blockAlign: number;
}


function fail(source: string, offset: number, message: string): never {
    throw new FmvFormatError(source, offset, message);
}

function sourceFailure(source: string, offset: number, message: string): never {
    throw new Error(`${source} at 0x${offset.toString(16)}: ${message}`);
}

function requireRange(bytes: Uint8Array, offset: number, size: number,
                      source: string, label: string): void {
    const end = offset + size;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
            || !Number.isSafeInteger(end) || offset < 0 || size < 0
            || end > bytes.length)
        fail(source, Math.max(0, offset),
             `${label} range ends at 0x${end.toString(16)}, `
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

function fixedTag(tag: string): Uint8Array {
    const bytes = new Uint8Array(16);
    bytes.set(ENCODER.encode(tag));
    return bytes;
}

function matchesTag(bytes: Uint8Array, offset: number, tag: Uint8Array): boolean {
    if (offset < 0 || offset + tag.length > bytes.length) return false;
    for (let i = 0; i < tag.length; i++)
        if (bytes[offset + i] !== tag[i]) return false;
    return true;
}

function describeTag(bytes: Uint8Array, offset: number): string {
    if (offset < 0 || offset + 16 > bytes.length) return "truncated data";
    let end = offset;
    while (end < offset + 16 && bytes[end] !== 0) {
        if (bytes[end] < 0x20 || bytes[end] > 0x7e) return "non-ASCII data";
        end++;
    }
    if (end === offset) return "empty data";
    const value = ASCII.decode(bytes.subarray(offset, end));
    if (end === offset + 16) return `"${value}" without NUL padding`;
    if (!allZero(bytes, end, offset + 16)) return `"${value}" with nonzero tag padding`;
    return `"${value}"`;
}

function findTag(bytes: Uint8Array, tag: Uint8Array, start: number,
                 last = bytes.length - tag.length): number {
    const limit = Math.min(bytes.length - tag.length, last);
    outer: for (let offset = start; offset <= limit; offset++) {
        for (let i = 0; i < tag.length; i++)
            if (bytes[offset + i] !== tag[i]) continue outer;
        return offset;
    }
    return -1;
}

export function locateFmvAssets(vfi: Vfi): FmvDiscovery[] {
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
            return {
                name,
                movie,
                formatError: new FmvFormatError(
                    movie.path,
                    0,
                    `incomplete subtitle pair for ${key}`,
                ),
            };
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
    if (sampleRate !== 48000)
        fail(source, 0x20, `unsupported sample rate ${sampleRate}; expected 48000`);
    if (channels !== 2)
        fail(source, 0x24, `unsupported channel count ${channels}; expected stereo`);
    const interleaveGroupBytes = interleave * channels;
    if (!Number.isSafeInteger(interleaveGroupBytes) || interleave % 16 !== 0
            || audioBlock % interleaveGroupBytes !== 0
            || preload % interleaveGroupBytes !== 0)
        fail(source, 0x24, "invalid channel/interleave arithmetic");
    const expectedAudio = preload + (groups - 1) * audioBlock;
    if (!Number.isSafeInteger(expectedAudio) || expectedAudio > UINT32_MAX)
        fail(source, 0x34, "audio total exceeds the header's u32 range");
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
                   expectedBytes: Uint8Array, source: string):
        { range: ChunkRange; next: number; index: number } {
    requireRange(bytes, offset, 32, source, `${expected} header`);
    if (!matchesTag(bytes, offset, expectedBytes))
        fail(source, offset, `expected ${expected}, found ${describeTag(bytes, offset)}`);
    const index = u32(bytes, offset + 0x10);
    const size = u32(bytes, offset + 0x14);
    if (u32(bytes, offset + 0x18) !== 0 || u32(bytes, offset + 0x1c) !== 0)
        fail(source, offset + 0x18, "nonzero chunk reserved word");
    const start = offset + 32;
    const paddedEnd = start + Math.ceil(size / 16) * 16;
    requireRange(bytes, start, size, source, `${expected} payload`);
    requireRange(bytes, start, paddedEnd - start, source, `${expected} padded payload`);
    if (!allZero(bytes, start + size, paddedEnd))
        fail(source, start + size, "nonzero chunk padding");
    return { range: { start, size }, next: paddedEnd, index };
}

function firstGroupOffsets(header: FmvHeader): { oneTrack: number; fiveTrack: number } {
    const interleaveGroupBytes = header.interleave * header.channels;
    return {
        oneTrack: SECTOR + header.preload,
        fiveTrack: SECTOR + FIVE_AUDIO_TRACKS * (header.preload + 2 * interleaveGroupBytes),
    };
}
async function readFmvAssetRange(vfi: Vfi, movie: VfiEntry, base: number,
                                 offset: number, size: number, source: string,
                                 label: string): Promise<Uint8Array> {
    const end = offset + size;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
            || !Number.isSafeInteger(end) || offset < 0 || size < 0
            || end > movie.size)
        fail(source, Math.max(0, offset),
             `${label} ends at 0x${end.toString(16)}, `
             + `past movie EOF 0x${movie.size.toString(16)}`);
    const absolute = base + offset;
    const absoluteEnd = absolute + size;
    if (!Number.isSafeInteger(absolute) || !Number.isSafeInteger(absoluteEnd)
            || absolute < 0 || absoluteEnd > vfi.src.size)
        sourceFailure(source, offset,
                      `${label} ends past source EOF 0x${vfi.src.size.toString(16)}`);
    const data = await vfi.src.read(absolute, size);
    if (data.length !== size)
        sourceFailure(source, offset + data.length,
                      `short read (${data.length} of ${size} ${label} bytes)`);
    return data;
}


function locateContainerStart(bytes: Uint8Array, header: FmvHeader,
                              source: string): ContainerStart {
    const offsets = firstGroupOffsets(header);
    if (matchesTag(bytes, offsets.oneTrack, GROUP_TAG_BYTES))
        return { groupOffset: offsets.oneTrack, audioTracks: 1, preloadStart: SECTOR };
    if (matchesTag(bytes, offsets.fiveTrack, GROUP_TAG_BYTES)) {
        return {
            groupOffset: offsets.fiveTrack,
            audioTracks: FIVE_AUDIO_TRACKS,
            preloadStart: offsets.fiveTrack - FIVE_AUDIO_TRACKS * header.preload,
        };
    }
    fail(source, offsets.oneTrack,
         `expected first ${GROUP_TAG} at one-track offset 0x${offsets.oneTrack.toString(16)} `
         + `or five-track offset 0x${offsets.fiveTrack.toString(16)}; found `
         + `${describeTag(bytes, offsets.oneTrack)} and `
         + `${describeTag(bytes, offsets.fiveTrack)}`);
}

function validateAudioRange(bytes: Uint8Array, range: ChunkRange, header: FmvHeader,
                            source: string, label: string): void {
    const interleaveGroupBytes = header.interleave * header.channels;
    requireRange(bytes, range.start, range.size, source, label);
    if (range.size % interleaveGroupBytes !== 0)
        fail(source, range.start, `${label} is not interleave-group aligned`);
    for (let frame = range.start; frame < range.start + range.size; frame += 16) {
        const filter = bytes[frame] >> 4;
        const shift = bytes[frame] & 0x0f;
        const flags = bytes[frame + 1];
        if (filter >= ADPCM_COEFFICIENTS.length)
            fail(source, frame, `${label} uses unsupported ADPCM filter ${filter}`);
        if (shift > 12)
            fail(source, frame, `${label} uses unsupported ADPCM shift ${shift}`);
        if (flags !== 0 && flags !== 2)
            fail(source, frame + 1,
                 `${label} uses unsupported ADPCM flags 0x${flags.toString(16)}`);
    }
}

function audioPreloads(bytes: Uint8Array, header: FmvHeader, start: ContainerStart,
                       source: string): ChunkRange[] {
    requireRange(bytes, SECTOR, start.groupOffset - SECTOR, source,
                 `${start.audioTracks}-track pre-group region`);
    const ranges: ChunkRange[] = [];
    for (let track = 0; track < start.audioTracks; track++) {
        const range = {
            start: start.preloadStart + track * header.preload,
            size: header.preload,
        };
        validateAudioRange(bytes, range, header, source, `audio track ${track} preload`);
        ranges.push(range);
    }
    return ranges;
}

function inspectContainer(bytes: Uint8Array, source: string): ContainerLayout {
    const header = parseFmvHeader(bytes, source);
    const start = locateContainerStart(bytes, header, source);
    const preloads = audioPreloads(bytes, header, start, source);
    const video: ChunkRange[] = [];
    const audio: ChunkRange[] = [preloads[0]];
    const groups: FmvGroup[] = [];
    let offset = start.groupOffset;
    let fieldOffset = 0;
    let lastVideoIndex = 0;
    let videoBytes = 0;

    for (let groupIndex = 0; groupIndex < header.groups; groupIndex++) {
        const groupChunk = readChunk(
            bytes, offset, GROUP_TAG, GROUP_TAG_BYTES, source);
        if (groupChunk.index !== fieldOffset)
            fail(source, offset + 0x10,
                 `group index ${groupChunk.index} != expected field ${fieldOffset}`);
        if (groupChunk.range.size !== 16)
            fail(source, groupChunk.range.start,
                 `group payload is ${groupChunk.range.size} bytes instead of 16`);
        const groupOffset = groupChunk.range.start;
        const group: FmvGroup = {
            fields: u32(bytes, groupOffset),
            videoChunks: u32(bytes, groupOffset + 4),
            unknown: u32(bytes, groupOffset + 8),
        };
        if (group.fields === 0) fail(source, groupOffset, "group has no fields");
        if (group.videoChunks === 0)
            fail(source, groupOffset + 4, "group has no video chunks");
        if (u32(bytes, groupOffset + 12) !== 0)
            fail(source, groupOffset + 12, "nonzero group reserved word");
        const groupEnd = fieldOffset + group.fields;
        if (!Number.isSafeInteger(groupEnd) || groupEnd > header.fields)
            fail(source, groupOffset,
                 `group fields end at ${groupEnd}, past header total ${header.fields}`);
        groups.push(group);
        offset = groupChunk.next;

        for (let chunkIndex = 0; chunkIndex < group.videoChunks; chunkIndex++) {
            const chunk = readChunk(bytes, offset, VIDEO_TAG, VIDEO_TAG_BYTES, source);
            if (chunk.index < fieldOffset || chunk.index >= groupEnd)
                fail(source, offset + 0x10,
                     `video index ${chunk.index} is outside group fields `
                     + `${fieldOffset}..${groupEnd - 1}`);
            if (chunk.index < lastVideoIndex)
                fail(source, offset + 0x10,
                     `video index ${chunk.index} follows ${lastVideoIndex}`);
            if (video.length === 0 && chunk.index !== 0)
                fail(source, offset + 0x10,
                     `first video index is ${chunk.index} instead of zero`);
            lastVideoIndex = chunk.index;
            video.push(chunk.range);
            videoBytes += chunk.range.size;
            if (!Number.isSafeInteger(videoBytes))
                fail(source, offset, "video size exceeds safe integer range");
            offset = chunk.next;
        }
        fieldOffset = groupEnd;

        if (groupIndex < header.groups - 1) {
            const trackBytes = start.audioTracks * header.audioBlock;
            const firstPossible = offset + trackBytes;
            if (!Number.isSafeInteger(firstPossible))
                fail(source, offset, "audio gap exceeds safe integer range");
            requireRange(bytes, offset, trackBytes, source, "audio tracks");
            const nextGroup = findTag(
                bytes, GROUP_TAG_BYTES, firstPossible, firstPossible + SECTOR - 1);
            if (nextGroup < 0)
                fail(source, offset,
                     `missing following ${GROUP_TAG} after ${start.audioTracks} `
                     + `audio track${start.audioTracks === 1 ? "" : "s"}`);
            const audioStart = nextGroup - trackBytes;
            if (!allZero(bytes, offset, audioStart))
                fail(source, offset, "nonzero leading audio-gap padding");
            for (let track = 0; track < start.audioTracks; track++) {
                validateAudioRange(bytes, {
                    start: audioStart + track * header.audioBlock,
                    size: header.audioBlock,
                }, header, source, `audio track ${track} block`);
            }
            audio.push({ start: audioStart, size: header.audioBlock });
            offset = nextGroup;
        }
    }

    const trailing = bytes.length - offset;
    if (trailing >= SECTOR)
        fail(source, offset, `trailing padding is ${trailing} bytes, not less than a sector`);
    if (!allZero(bytes, offset, bytes.length)) fail(source, offset, "nonzero trailing data");
    if (fieldOffset !== header.fields)
        fail(source, 0x08, `group fields ${fieldOffset} != header ${header.fields}`);
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
    let aspectRatioCode: number;
    let frameRateCode: number;
    try {
        width = bits.read(12);
        height = bits.read(12);
        aspectRatioCode = bits.read(4);
        frameRateCode = bits.read(4);
    } catch (error) {
        fail(source, sequence.offset, (error as Error).message);
    }
    const frameRate = FRAME_RATES[frameRateCode!];
    if (!width! || !height! || frameRate === undefined)
        fail(source, sequence.offset, "invalid sequence dimensions or frame rate");
    if (aspectRatioCode! !== 1)
        fail(source, sequence.offset,
             `unsupported MPEG aspect-ratio code ${aspectRatioCode!}`);
    if (frameRateCode! !== 3 && frameRateCode! !== 4)
        fail(source, sequence.offset,
             `unsupported Ape Escape 3 MPEG frame-rate code ${frameRateCode!}`);

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
    const sampleAspect: readonly [number, number] =
        frameRateCode === 3 ? [4, 3] : [7, 6];
    const divisor = gcd(width! * sampleAspect[0], height! * sampleAspect[1]);
    return {
        width: width!,
        height: height!,
        frameRate,
        fieldOrder: progressive ? "progressive" : topFieldFirst ? "tt" : "bb",
        sampleAspect,
        displayAspect: [
            width! * sampleAspect[0] / divisor,
            height! * sampleAspect[1] / divisor,
        ],
    };
}

/** Inspect the header and first video chunk without reading the full movie.
 *  The caller must provide a prefix through that complete chunk. */
export function inspectFmvPrefix(bytes: Uint8Array, source = "FMV"):
        { header: FmvHeader; videoInfo: FmvVideoInfo } {
    const header = parseFmvHeader(bytes, source);
    const start = locateContainerStart(bytes, header, source);
    audioPreloads(bytes, header, start, source);
    const group = readChunk(
        bytes, start.groupOffset, GROUP_TAG, GROUP_TAG_BYTES, source);
    if (group.index !== 0)
        fail(source, start.groupOffset + 0x10,
             `first group index is ${group.index} instead of zero`);
    if (group.range.size !== 16)
        fail(source, group.range.start,
             `group payload is ${group.range.size} bytes instead of 16`);
    const fields = u32(bytes, group.range.start);
    const videoChunks = u32(bytes, group.range.start + 4);
    if (fields === 0) fail(source, group.range.start, "first group has no fields");
    if (fields > header.fields)
        fail(source, group.range.start,
             `group fields end at ${fields}, past header total ${header.fields}`);
    if (videoChunks === 0)
        fail(source, group.range.start + 4, "first group has no video");
    if (u32(bytes, group.range.start + 12) !== 0)
        fail(source, group.range.start + 12, "nonzero group reserved word");
    const video = readChunk(bytes, group.next, VIDEO_TAG, VIDEO_TAG_BYTES, source);
    if (video.index !== 0)
        fail(source, group.next + 0x10,
             `first video index is ${video.index} instead of zero`);
    return {
        header,
        videoInfo: parseMpeg2VideoInfo(
            bytes.subarray(video.range.start, video.range.start + video.range.size),
            `${source} video`),
    };
}

/** Read only the bounded bytes needed to inspect one movie in a VFI archive. */
export async function inspectFmvAsset(vfi: Vfi, movie: VfiEntry,
                                     source = movie.path):
        Promise<{ header: FmvHeader; videoInfo: FmvVideoInfo }> {
    const base = vfi.byteOffset(movie);
    const headerBytes = await readFmvAssetRange(
        vfi, movie, base, 0, SECTOR, source, "header sector");
    const header = parseFmvHeader(headerBytes, source);
    const offsets = firstGroupOffsets(header);
    const oneTrackEnd = offsets.oneTrack + FIRST_GROUP_PROBE_BYTES;
    const fiveTrackEnd = offsets.fiveTrack + FIRST_GROUP_PROBE_BYTES;
    const oneTrackFits = Number.isSafeInteger(oneTrackEnd)
        && oneTrackEnd <= movie.size;
    const fiveTrackFits = Number.isSafeInteger(fiveTrackEnd)
        && fiveTrackEnd <= movie.size;

    const oneTrackProbe = oneTrackFits
        ? await readFmvAssetRange(vfi, movie, base, offsets.oneTrack,
            FIRST_GROUP_PROBE_BYTES, source, "one-track first-group probe")
        : null;
    let fiveTrackProbe: Uint8Array | null = null;
    let start: ContainerStart | null = null;
    let groupProbe: Uint8Array | null = null;
    if (oneTrackProbe !== null && matchesTag(oneTrackProbe, 0, GROUP_TAG_BYTES)) {
        start = { groupOffset: offsets.oneTrack, audioTracks: 1, preloadStart: SECTOR };
        groupProbe = oneTrackProbe;
    } else if (fiveTrackFits) {
        fiveTrackProbe = await readFmvAssetRange(
            vfi, movie, base, offsets.fiveTrack, FIRST_GROUP_PROBE_BYTES,
            source, "five-track first-group probe");
        if (matchesTag(fiveTrackProbe, 0, GROUP_TAG_BYTES)) {
            start = {
                groupOffset: offsets.fiveTrack,
                audioTracks: FIVE_AUDIO_TRACKS,
                preloadStart: offsets.fiveTrack - FIVE_AUDIO_TRACKS * header.preload,
            };
            groupProbe = fiveTrackProbe;
        }
    }
    if (start === null || groupProbe === null) {
        const oneTrackFound = oneTrackProbe === null
            ? `range ends at 0x${oneTrackEnd.toString(16)} past movie EOF`
            : describeTag(oneTrackProbe, 0);
        const fiveTrackFound = fiveTrackProbe === null
            ? `range ends at 0x${fiveTrackEnd.toString(16)} past movie EOF`
            : describeTag(fiveTrackProbe, 0);
        fail(source, offsets.oneTrack,
             `expected first ${GROUP_TAG} at one-track offset `
             + `0x${offsets.oneTrack.toString(16)} or five-track offset `
             + `0x${offsets.fiveTrack.toString(16)}; found `
             + `${oneTrackFound} and ${fiveTrackFound}`);
    }
    if (u32(groupProbe, 0x10) !== 0)
        fail(source, start.groupOffset + 0x10,
             `first group index is ${u32(groupProbe, 0x10)} instead of zero`);
    const groupSize = u32(groupProbe, 0x14);
    if (groupSize !== 16)
        fail(source, start.groupOffset + 0x14,
             `group payload is ${groupSize} bytes instead of 16`);
    if (u32(groupProbe, 0x18) !== 0 || u32(groupProbe, 0x1c) !== 0)
        fail(source, start.groupOffset + 0x18, "nonzero chunk reserved word");
    const fields = u32(groupProbe, 0x20);
    const videoChunks = u32(groupProbe, 0x24);
    if (fields === 0) fail(source, start.groupOffset + 0x20, "first group has no fields");
    if (fields > header.fields)
        fail(source, start.groupOffset + 0x20,
             `group fields end at ${fields}, past header total ${header.fields}`);
    if (videoChunks === 0)
        fail(source, start.groupOffset + 0x24, "first group has no video");
    if (u32(groupProbe, 0x2c) !== 0)
        fail(source, start.groupOffset + 0x2c, "nonzero group reserved word");
    const videoHeaderOffset = 48;
    const videoHeader = start.groupOffset + videoHeaderOffset;
    if (!matchesTag(groupProbe, videoHeaderOffset, VIDEO_TAG_BYTES))
        fail(source, videoHeader,
             `expected ${VIDEO_TAG}, found ${describeTag(groupProbe, videoHeaderOffset)}`);
    const videoIndex = u32(groupProbe, videoHeaderOffset + 0x10);
    if (videoIndex !== 0)
        fail(source, videoHeader + 0x10,
             `first video index is ${videoIndex} instead of zero`);
    if (u32(groupProbe, videoHeaderOffset + 0x18) !== 0
            || u32(groupProbe, videoHeaderOffset + 0x1c) !== 0)
        fail(source, videoHeader + 0x18, "nonzero chunk reserved word");
    const videoSize = u32(groupProbe, videoHeaderOffset + 0x14);
    if (videoSize > MAX_FIRST_VIDEO_INSPECTION_BYTES)
        fail(source, videoHeader + 0x14,
             `first video payload is ${videoSize} bytes, exceeds inspection cap `
             + `${MAX_FIRST_VIDEO_INSPECTION_BYTES}`);

    const prefixSize = videoHeader + 32 + Math.ceil(videoSize / 16) * 16;
    if (!Number.isSafeInteger(prefixSize) || prefixSize < videoHeader
            || prefixSize > movie.size)
        fail(source, videoHeader + 0x14,
             `first video chunk ends at 0x${prefixSize.toString(16)}, `
             + `past movie EOF 0x${movie.size.toString(16)}`);
    if (prefixSize > MAX_FMV_INSPECTION_PREFIX_BYTES)
        fail(source, videoHeader + 0x14,
             `inspection prefix is ${prefixSize} bytes, exceeds cap `
             + `${MAX_FMV_INSPECTION_PREFIX_BYTES}`);
    const prefix = await readFmvAssetRange(
        vfi, movie, base, 0, prefixSize, source, "inspection prefix");
    return inspectFmvPrefix(prefix, source);
}

function wavLayout(header: FmvHeader, source: string): WavLayout {
    const adpcmBytesPerChannel = header.audioBytes / header.channels;
    if (!Number.isSafeInteger(adpcmBytesPerChannel) || adpcmBytesPerChannel % 16 !== 0)
        fail(source, 0x34, "per-channel audio is not a whole number of ADPCM frames");
    const adpcmFramesPerChannel = adpcmBytesPerChannel / 16;
    const samplesPerChannel = adpcmFramesPerChannel * 28;
    const blockAlign = header.channels * 2;
    const byteRate = header.sampleRate * blockAlign;
    const bodyBytes = samplesPerChannel * blockAlign;
    const riffBytes = 36 + bodyBytes;
    const totalBytes = 44 + bodyBytes;
    if (!Number.isSafeInteger(adpcmFramesPerChannel)
            || !Number.isSafeInteger(samplesPerChannel)
            || !Number.isSafeInteger(blockAlign)
            || !Number.isSafeInteger(byteRate)
            || !Number.isSafeInteger(bodyBytes)
            || !Number.isSafeInteger(riffBytes)
            || !Number.isSafeInteger(totalBytes))
        fail(source, 0x34, "WAV arithmetic exceeds the safe integer range");
    if (samplesPerChannel > UINT32_MAX)
        fail(source, 0x34, "per-channel sample count exceeds the u32 decoder counter");
    if (blockAlign > UINT16_MAX)
        fail(source, 0x24, "WAV block alignment exceeds the u16 field");
    if (byteRate > UINT32_MAX)
        fail(source, 0x20, "WAV byte rate exceeds the u32 field");
    if (bodyBytes % blockAlign !== 0 || bodyBytes > UINT32_MAX
            || riffBytes > UINT32_MAX)
        fail(source, 0x34, "WAV body is not representable by RIFF u32 fields");
    if (totalBytes > MAX_WAV_BYTES)
        fail(source, 0x34,
             `WAV allocation is ${totalBytes} bytes, exceeds cap ${MAX_WAV_BYTES}`);
    return {
        samplesPerChannel,
        bodyBytes,
        totalBytes,
        riffBytes,
        byteRate,
        blockAlign,
    };
}

function writeWavHeader(wav: Uint8Array, header: FmvHeader,
                        layout: WavLayout): void {
    wav.set(ENCODER.encode("RIFF"), 0);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    view.setUint32(4, layout.riffBytes, true);
    wav.set(ENCODER.encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, header.channels, true);
    view.setUint32(24, header.sampleRate, true);
    view.setUint32(28, layout.byteRate, true);
    view.setUint16(32, layout.blockAlign, true);
    view.setUint16(34, 16, true);
    wav.set(ENCODER.encode("data"), 36);
    view.setUint32(40, layout.bodyBytes, true);
}

function decodeAudio(bytes: Uint8Array, ranges: readonly ChunkRange[],
                     header: FmvHeader, source: string): Uint8Array {
    const layout = wavLayout(header, source);
    const samplesPerChannel = layout.samplesPerChannel;
    const wav = new Uint8Array(layout.totalBytes);
    writeWavHeader(wav, header, layout);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const previousSamples = new Int32Array(header.channels);
    const olderSamples = new Int32Array(header.channels);
    const sampleOffsets = new Uint32Array(header.channels);
    const interleaveGroupBytes = header.interleave * header.channels;

    for (const range of ranges) {
        if (range.size % interleaveGroupBytes !== 0)
            fail(source, range.start, "audio range is not interleave-group aligned");
        for (let interleaveGroupStart = range.start;
             interleaveGroupStart < range.start + range.size;
             interleaveGroupStart += interleaveGroupBytes) {
            for (let channel = 0; channel < header.channels; channel++) {
                const blockEnd = interleaveGroupStart + (channel + 1) * header.interleave;
                let frame = interleaveGroupStart + channel * header.interleave;
                for (; frame < blockEnd; frame += 16) {
                    const shift = bytes[frame] & 0x0f;
                    const filter = (bytes[frame] >> 4) & 0x0f;
                    const [coefficient0, coefficient1] = ADPCM_COEFFICIENTS[filter];
                    for (let i = 0; i < 14; i++) {
                        const packed = bytes[frame + 2 + i];
                        for (let nibbleIndex = 0; nibbleIndex < 2; nibbleIndex++) {
                            const nibble = nibbleIndex === 0 ? packed & 0x0f : packed >> 4;
                            let sample = nibble << 12;
                            if ((sample & 0x8000) !== 0) sample -= 0x10000;
                            sample >>= shift;
                            sample += (previousSamples[channel] * coefficient0
                                + olderSamples[channel] * coefficient1) >> 6;
                            sample = Math.max(-32768, Math.min(32767, sample));
                            const sampleIndex = sampleOffsets[channel]++;
                            view.setInt16(44 + (sampleIndex * header.channels + channel) * 2,
                                          sample, true);
                            olderSamples[channel] = previousSamples[channel];
                            previousSamples[channel] = sample;
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
        fail(source, 0,
             `${text.length} strings != ${timings.starts.length} timings`);
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
