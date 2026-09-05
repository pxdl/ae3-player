/// <reference lib="webworker" />

import type {
    DecodedMovieFrame,
    DecodeFramesRequest,
    InitializeDecoderRequest,
    MovieDecoderErrorStage,
    MovieDecoderRequest,
    MovieDecoderResponse,
    MovieDecoderStats,
    MovieFieldOrder,
    MoviePlaneLayout,
    SeekDecoderRequest,
} from "./movie-decoder-protocol.ts";
import {
    movieFrameByteLength,
    movieOutputFrameDuration,
} from "./movie-decoder-protocol.ts";
import type { Mpeg2SeekPoint } from "./vendor/extract/index.ts";

interface LibAvStream {
    index: number;
    codec_id: number;
    codecpar: number;
    time_base_num: number;
    time_base_den: number;
}

interface LibAvPacket {
    data: Uint8Array;
}

interface LibAvPackedFrame {
    data: Uint8Array;
    width: number;
    height: number;
    format: number;
}

interface LibAvInstance {
    AVERROR_EOF: number;
    EAGAIN: number;
    AVMEDIA_TYPE_VIDEO: number;
    AV_PIX_FMT_YUV420P: number;
    HEAPU8: Uint8Array;
    mkreadaheadfile(name: string, blob: Blob): Promise<void>;
    unlinkreadaheadfile(name: string): Promise<void>;
    ff_init_demuxer_file(name: string, format: string): Promise<[number, LibAvStream[]]>;
    ff_init_decoder(codecId: number, options: {
        codecpar: number;
        time_base: [number, number];
    }): Promise<[number, number, number, number]>;
    ff_init_filter_graph(description: string, input: {
        type: number;
        time_base: [number, number];
        frame_rate: number;
        pix_fmt: number;
        width: number;
        height: number;
    }, output: {
        type: number;
        pix_fmt: number;
    }): Promise<[number, number, number]>;
    ff_read_frame_multi(formatContext: number, packet: number, options: {
        limit: number;
    }): Promise<[number, Record<number, LibAvPacket[]>]>;
    ff_decode_multi(decoder: number, packet: number, frame: number,
        packets: LibAvPacket[], options: {
            fin?: boolean;
            copyoutFrame: "video_packed";
        }): Promise<LibAvPackedFrame[]>;
    ff_decode_filter_multi(decoder: number, source: number, sink: number,
        packet: number, frame: number, packets: LibAvPacket[], options: {
            fin?: boolean;
            copyoutFrame: "video_packed";
        }): Promise<LibAvPackedFrame[]>;
    avformat_close_input_js(formatContext: number): Promise<void>;
    ff_free_decoder(decoder: number, packet: number, frame: number): Promise<void>;
    avfilter_graph_free_js(graph: number): Promise<void>;
}

interface LibAvFactory {
    base: string;
    LibAV(options: { noworker: true }): Promise<LibAvInstance>;
}

interface DecoderSource {
    blob: Blob;
    width: number;
    height: number;
    duration: number;
    sourceFrames: number;
    outputFrames: number;
    frameDuration: number;
    frameRate: number;
    fieldOrder: MovieFieldOrder;
    seekPoints: readonly Mpeg2SeekPoint[];
}

class CancelledOperation extends Error {}

class StageError extends Error {
    readonly stage: MovieDecoderErrorStage;

    constructor(stage: MovieDecoderErrorStage, cause: unknown) {
        super(errorMessage(cause));
        this.stage = stage;
    }
}

const scope = self as DedicatedWorkerGlobalScope;
const INPUT_NAME = "movie.m2v";
const PACKET_READ_LIMIT = 16 * 1024;
const MAX_NO_PROGRESS_READS = 64;
const MAX_RESPONSE_FRAMES = 32;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TIMESTAMP_EPSILON = 1e-9;

let latestGeneration = -1;
let operationChain = Promise.resolve();
let libav: LibAvInstance | null = null;
let source: DecoderSource | null = null;
let mounted = false;
let eof = false;
let flushed = false;
let formatContext = 0;
let stream: LibAvStream | null = null;
let decoder = 0;
let packet = 0;
let frame = 0;
let filterGraph = 0;
let filterSource = 0;
let filterSink = 0;
let nextOutputFrame = 0;
let pendingFrames: DecodedMovieFrame[] = [];
let pendingBytes = 0;
let stats: MovieDecoderStats = emptyStats();

scope.onmessage = (event: MessageEvent<unknown>) => {
    const request = parseRequest(event.data);
    if (request.generation < latestGeneration) {
        post({
            type: "cancelled",
            requestId: request.requestId,
            generation: request.generation,
        });
        return;
    }
    latestGeneration = request.generation;
    operationChain = operationChain.then(() => dispatch(request)).catch(cause => {
        if (cause instanceof CancelledOperation) {
            post({
                type: "cancelled",
                requestId: request.requestId,
                generation: request.generation,
            });
            return;
        }
        const stage = cause instanceof StageError ? cause.stage : stageFor(request.type);
        post({
            type: "error",
            requestId: request.requestId,
            generation: request.generation,
            stage,
            message: errorMessage(cause),
        });
    });
};

async function dispatch(request: MovieDecoderRequest): Promise<void> {
    assertCurrent(request.generation);
    switch (request.type) {
        case "initialize":
            await initialize(request);
            break;
        case "prime":
        case "pull":
            await decodeFrames(request);
            break;
        case "seek":
            await seek(request);
            break;
        case "dispose":
            await dispose(request.requestId, request.generation);
            break;
    }
}

async function initialize(request: InitializeDecoderRequest): Promise<void> {
    validateInitialize(request);
    if (source !== null)
        throw new StageError("initialize", "decoder is already initialized");

    try {
        libav = await loadLibAv(request.libavUrl);
    } catch (cause) {
        throw new StageError("load", cause);
    }
    assertCurrent(request.generation);

    const frameDuration = movieOutputFrameDuration(request.fieldOrder, request.frameRate);
    const outputMultiplier = request.fieldOrder === "progressive" ? 1 : 2;
    source = {
        blob: new Blob([request.video]),
        width: request.width,
        height: request.height,
        duration: request.duration,
        sourceFrames: request.sourceFrames,
        outputFrames: request.sourceFrames * outputMultiplier,
        frameDuration,
        frameRate: request.frameRate,
        fieldOrder: request.fieldOrder,
        seekPoints: request.seekPoints,
    };
    stats = emptyStats();
    await openAt(source.seekPoints[0], request.generation);
    post({
        type: "ready",
        requestId: request.requestId,
        generation: request.generation,
        width: source.width,
        height: source.height,
        format: "I420",
        outputRate: 1 / frameDuration,
        frameDuration,
        sourceFrames: source.sourceFrames,
        outputFrames: source.outputFrames,
        firstSeekPoint: source.seekPoints[0],
    });
}

async function decodeFrames(request: DecodeFramesRequest): Promise<void> {
    const movie = requireSource();
    if (!Number.isFinite(request.untilTimestamp) || request.untilTimestamp < 0)
        throw new StageError("protocol", "untilTimestamp must be finite and non-negative");
    const maxFrames = boundedInteger(request.maxFrames, 1, MAX_RESPONSE_FRAMES, "maxFrames");
    const frameBytes = movieFrameByteLength(movie.width, movie.height);
    const maxBytes = boundedInteger(request.maxBytes, frameBytes, MAX_RESPONSE_BYTES, "maxBytes");
    const frames: DecodedMovieFrame[] = [];
    let bytes = 0;
    let noProgressReads = 0;

    while (!eof || pendingFrames.length > 0) {
        assertCurrent(request.generation);
        if (pendingFrames.length === 0) {
            if (await decodeNext(request.generation)) {
                noProgressReads = 0;
            } else if (++noProgressReads >= MAX_NO_PROGRESS_READS) {
                throw new StageError("decode", "MPEG-2 demux repeatedly made no progress");
            }
        }
        const candidate = pendingFrames[0];
        if (candidate === undefined)
            continue;
        if (candidate.timestamp > request.untilTimestamp + TIMESTAMP_EPSILON)
            break;
        if (frames.length >= maxFrames || (frames.length > 0 && bytes + candidate.data.byteLength > maxBytes))
            break;
        pendingFrames.shift();
        pendingBytes -= candidate.data.byteLength;
        frames.push(candidate);
        bytes += candidate.data.byteLength;
    }

    assertCurrent(request.generation);
    if (frames.length === 0 && eof && pendingFrames.length === 0) {
        verifyFinalFrameCount();
        post({
            type: "eof",
            requestId: request.requestId,
            generation: request.generation,
            stats: snapshotStats(),
        });
        return;
    }
    stats.outputFrames += frames.length;
    if (eof && pendingFrames.length === 0)
        verifyFinalFrameCount();
    post({
        type: "frames",
        requestId: request.requestId,
        generation: request.generation,
        frames,
        eof: eof && pendingFrames.length === 0,
        stats: snapshotStats(),
    }, frames.map(item => item.data));
}

async function seek(request: SeekDecoderRequest): Promise<void> {
    const movie = requireSource();
    if (!Number.isFinite(request.target))
        throw new StageError("protocol", "seek target must be finite");
    const target = Math.min(Math.max(request.target, 0), movie.duration);
    const sourceFrame = Math.floor(target * movie.frameRate + TIMESTAMP_EPSILON);
    let pointIndex = 0;
    for (let index = 0; index < movie.seekPoints.length; index++) {
        const candidate = movie.seekPoints[index]!;
        if (candidate.frame > sourceFrame)
            break;
        pointIndex = index;
    }
    if (movie.fieldOrder !== "progressive" && pointIndex > 0)
        pointIndex--;
    const point = movie.seekPoints[pointIndex]!;

    stats.droppedFrames += pendingFrames.length;
    pendingFrames = [];
    pendingBytes = 0;
    await closePipeline();
    assertCurrent(request.generation);
    await openAt(point, request.generation);

    while (!eof) {
        assertCurrent(request.generation);
        if (pendingFrames.length === 0)
            await decodeNext(request.generation);
        while (pendingFrames[0] !== undefined
                && pendingFrames[0].timestamp + TIMESTAMP_EPSILON < target) {
            const dropped = pendingFrames.shift();
            if (dropped !== undefined)
                pendingBytes -= dropped.data.byteLength;
            stats.droppedFrames++;
        }
        if (pendingFrames.length > 0)
            break;
    }

    const timestamp = pendingFrames[0]?.timestamp ?? movie.duration;
    post({
        type: "seeked",
        requestId: request.requestId,
        generation: request.generation,
        target,
        timestamp,
    });
}

async function openAt(point: Mpeg2SeekPoint, generation: number): Promise<void> {
    const av = requireLibAv();
    const movie = requireSource();
    await av.mkreadaheadfile(INPUT_NAME, movie.blob.slice(point.offset));
    mounted = true;
    assertCurrent(generation);
    const initialized = await av.ff_init_demuxer_file(INPUT_NAME, "mpegvideo");
    formatContext = initialized[0];
    stream = initialized[1].find(item => item.codec_id === 2) ?? null;
    if (stream === null)
        throw new StageError("initialize", "MPEG-2 video stream was not found");
    const decoderState = await av.ff_init_decoder(stream.codec_id, {
        codecpar: stream.codecpar,
        time_base: [stream.time_base_num, stream.time_base_den],
    });
    decoder = decoderState[1];
    packet = decoderState[2];
    frame = decoderState[3];
    assertCurrent(generation);

    if (movie.fieldOrder !== "progressive") {
        const parity = movie.fieldOrder === "tt" ? "tff" : "bff";
        const filter = await av.ff_init_filter_graph(
            `yadif=mode=send_field:parity=${parity}:deint=all`,
            {
                type: av.AVMEDIA_TYPE_VIDEO,
                time_base: [stream.time_base_num, stream.time_base_den],
                frame_rate: movie.frameRate,
                pix_fmt: av.AV_PIX_FMT_YUV420P,
                width: movie.width,
                height: movie.height,
            },
            { type: av.AVMEDIA_TYPE_VIDEO, pix_fmt: av.AV_PIX_FMT_YUV420P },
        );
        filterGraph = filter[0];
        filterSource = filter[1];
        filterSink = filter[2];
    }
    const outputMultiplier = movie.fieldOrder === "progressive" ? 1 : 2;
    nextOutputFrame = point.frame * outputMultiplier;
    eof = false;
    flushed = false;
}

async function decodeNext(generation: number): Promise<boolean> {
    const av = requireLibAv();
    const activeStream = requireStream();
    const started = performance.now();
    const [readCode, packetsByStream] = await av.ff_read_frame_multi(formatContext, packet, {
        limit: PACKET_READ_LIMIT,
    });
    assertCurrent(generation);
    if (readCode < 0 && readCode !== av.AVERROR_EOF && readCode !== -av.EAGAIN)
        throw new StageError("decode", `MPEG-2 demux failed (${readCode})`);
    const packets = packetsByStream[activeStream.index] ?? [];
    stats.packets += packets.length;
    let decoded = await decodePackets(packets, false);
    if (readCode === av.AVERROR_EOF && !flushed) {
        decoded = decoded.concat(await decodePackets([], true));
        flushed = true;
        eof = true;
    }
    stats.decodeWallTime += performance.now() - started;
    assertCurrent(generation);
    appendDecodedFrames(decoded);
    return eof || packets.length > 0 || decoded.length > 0;
}

async function decodePackets(packets: LibAvPacket[], finish: boolean): Promise<LibAvPackedFrame[]> {
    const av = requireLibAv();
    const options = finish
        ? { fin: true, copyoutFrame: "video_packed" as const }
        : { copyoutFrame: "video_packed" as const };
    if (filterGraph !== 0)
        return av.ff_decode_filter_multi(decoder, filterSource, filterSink, packet, frame, packets, options);
    return av.ff_decode_multi(decoder, packet, frame, packets, options);
}

function appendDecodedFrames(decoded: LibAvPackedFrame[]): void {
    const movie = requireSource();
    const expectedBytes = movieFrameByteLength(movie.width, movie.height);
    const pixelFormat = requireLibAv().AV_PIX_FMT_YUV420P;
    const yBytes = movie.width * movie.height;
    const chromaStride = movie.width / 2;
    const chromaBytes = yBytes / 4;
    const layout: readonly [MoviePlaneLayout, MoviePlaneLayout, MoviePlaneLayout] = [
        { offset: 0, stride: movie.width },
        { offset: yBytes, stride: chromaStride },
        { offset: yBytes + chromaBytes, stride: chromaStride },
    ];

    for (const item of decoded) {
        if (item.width !== movie.width || item.height !== movie.height
                || item.format !== pixelFormat
                || item.data.byteLength !== expectedBytes)
            throw new StageError("decode", `unexpected decoded frame ${item.width}x${item.height}, format ${item.format}, ${item.data.byteLength} bytes`);
        const data = exactBuffer(item.data);
        const output: DecodedMovieFrame = {
            index: nextOutputFrame,
            timestamp: nextOutputFrame * movie.frameDuration,
            duration: movie.frameDuration,
            width: movie.width,
            height: movie.height,
            format: "I420",
            data,
            layout,
        };
        nextOutputFrame++;
        pendingFrames.push(output);
        pendingBytes += data.byteLength;
    }
    stats.decodedFrames += decoded.length;
}

async function dispose(requestId: number, generation: number): Promise<void> {
    stats.droppedFrames += pendingFrames.length;
    pendingFrames = [];
    pendingBytes = 0;
    try {
        await closePipeline();
        source = null;
        libav = null;
    } catch (cause) {
        throw new StageError("dispose", cause);
    }
    post({ type: "disposed", requestId, generation });
    scope.close();
}

async function closePipeline(): Promise<void> {
    const av = libav;
    if (av === null)
        return;
    if (formatContext !== 0) {
        await av.avformat_close_input_js(formatContext);
        formatContext = 0;
    }
    if (decoder !== 0) {
        await av.ff_free_decoder(decoder, packet, frame);
        decoder = 0;
        packet = 0;
        frame = 0;
    }
    if (filterGraph !== 0) {
        await av.avfilter_graph_free_js(filterGraph);
        filterGraph = 0;
        filterSource = 0;
        filterSink = 0;
    }
    stream = null;
    if (mounted) {
        await av.unlinkreadaheadfile(INPUT_NAME);
        mounted = false;
    }
}

async function loadLibAv(url: string): Promise<LibAvInstance> {
    if (libav !== null)
        return libav;
    if (typeof url !== "string" || url.length === 0)
        throw new Error("libavUrl is required");
    const imported: unknown = await import(/* @vite-ignore */ url);
    let factory: LibAvFactory;
    if (typeof imported === "object" && imported !== null
            && "default" in imported && isLibAvFactory(imported.default))
        factory = imported.default;
    else if (isLibAvFactory(imported))
        factory = imported;
    else
        throw new Error("libav.js did not export LibAV");
    factory.base = new URL(".", url).href;
    return factory.LibAV({ noworker: true });
}

function isLibAvFactory(value: unknown): value is LibAvFactory {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
        return false;
    return "base" in value && typeof value.base === "string"
        && "LibAV" in value && typeof value.LibAV === "function";
}

function parseRequest(value: unknown): MovieDecoderRequest {
    if (typeof value !== "object" || value === null)
        throw new StageError("protocol", "decoder request must be an object");
    if (!("requestId" in value) || !Number.isSafeInteger(value.requestId)
            || !("generation" in value) || !Number.isSafeInteger(value.generation)
            || !("type" in value) || typeof value.type !== "string")
        throw new StageError("protocol", "decoder request has invalid identity fields");
    const requestId = value.requestId as number;
    const generation = value.generation as number;

    if (value.type === "initialize") {
        if (!("libavUrl" in value) || typeof value.libavUrl !== "string"
                || !("video" in value) || !(value.video instanceof ArrayBuffer)
                || !("width" in value) || typeof value.width !== "number"
                || !("height" in value) || typeof value.height !== "number"
                || !("fieldOrder" in value) || !isFieldOrder(value.fieldOrder)
                || !("frameRate" in value) || typeof value.frameRate !== "number"
                || !("duration" in value) || typeof value.duration !== "number"
                || !("sourceFrames" in value) || typeof value.sourceFrames !== "number"
                || !("seekPoints" in value))
            throw new StageError("protocol", "initialize request is malformed");
        return {
            type: "initialize",
            requestId,
            generation,
            libavUrl: value.libavUrl,
            video: value.video,
            width: value.width,
            height: value.height,
            fieldOrder: value.fieldOrder,
            frameRate: value.frameRate,
            duration: value.duration,
            sourceFrames: value.sourceFrames,
            seekPoints: parseSeekPoints(value.seekPoints),
        };
    }
    if (value.type === "prime" || value.type === "pull") {
        if (!("untilTimestamp" in value) || typeof value.untilTimestamp !== "number"
                || !("maxFrames" in value) || typeof value.maxFrames !== "number"
                || !("maxBytes" in value) || typeof value.maxBytes !== "number")
            throw new StageError("protocol", `${value.type} request is malformed`);
        return {
            type: value.type,
            requestId,
            generation,
            untilTimestamp: value.untilTimestamp,
            maxFrames: value.maxFrames,
            maxBytes: value.maxBytes,
        };
    }
    if (value.type === "seek") {
        if (!("target" in value) || typeof value.target !== "number")
            throw new StageError("protocol", "seek request is malformed");
        return { type: "seek", requestId, generation, target: value.target };
    }
    if (value.type === "dispose")
        return { type: "dispose", requestId, generation };
    throw new StageError("protocol", `unknown decoder request ${value.type}`);
}

function isFieldOrder(value: unknown): value is MovieFieldOrder {
    return value === "progressive" || value === "tt" || value === "bb";
}

function parseSeekPoints(value: unknown): Mpeg2SeekPoint[] {
    if (!Array.isArray(value))
        throw new StageError("protocol", "seekPoints must be an array");
    return value.map(item => {
        if (typeof item !== "object" || item === null
                || !("offset" in item) || typeof item.offset !== "number"
                || !("frame" in item) || typeof item.frame !== "number")
            throw new StageError("protocol", "seek point is malformed");
        return { offset: item.offset, frame: item.frame };
    });
}

function validateInitialize(request: InitializeDecoderRequest): void {
    movieFrameByteLength(request.width, request.height);
    if (request.frameRate !== 25 && request.frameRate !== 30000 / 1001)
        throw new StageError("protocol", "unsupported MPEG-2 source frame rate");
    if (!(request.video instanceof ArrayBuffer) || request.video.byteLength === 0)
        throw new StageError("protocol", "decoder source must be a non-empty ArrayBuffer");
    if (!Number.isFinite(request.duration) || request.duration <= 0)
        throw new StageError("protocol", "decoder duration must be positive");
    if (!Number.isSafeInteger(request.sourceFrames) || request.sourceFrames <= 0)
        throw new StageError("protocol", "decoder source frame count must be positive");
    if (!Array.isArray(request.seekPoints) || request.seekPoints.length === 0
            || request.seekPoints[0].offset !== 0 || request.seekPoints[0].frame !== 0)
        throw new StageError("protocol", "decoder seek index must start at byte and frame zero");
    let priorOffset = -1;
    let priorFrame = -1;
    for (const point of request.seekPoints) {
        if (!Number.isSafeInteger(point.offset) || !Number.isSafeInteger(point.frame)
                || point.offset <= priorOffset || point.frame <= priorFrame
                || point.offset >= request.video.byteLength || point.frame >= request.sourceFrames)
            throw new StageError("protocol", "decoder seek index is not strictly increasing");
        priorOffset = point.offset;
        priorFrame = point.frame;
    }
}

function verifyFinalFrameCount(): void {
    const movie = requireSource();
    if (nextOutputFrame !== movie.outputFrames)
        throw new StageError("decode", `decoded ${nextOutputFrame} frames, expected ${movie.outputFrames}`);
}

function assertCurrent(generation: number): void {
    if (generation !== latestGeneration)
        throw new CancelledOperation();
}

function requireLibAv(): LibAvInstance {
    if (libav === null)
        throw new StageError("protocol", "decoder is not initialized");
    return libav;
}

function requireSource(): DecoderSource {
    if (source === null)
        throw new StageError("protocol", "decoder source is not initialized");
    return source;
}

function requireStream(): LibAvStream {
    if (stream === null)
        throw new StageError("decode", "decoder stream is not open");
    return stream;
}

function exactBuffer(data: Uint8Array): ArrayBuffer {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
            && data.buffer instanceof ArrayBuffer)
        return data.buffer;
    return data.slice().buffer;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new StageError("protocol", `${name} must be an integer from ${minimum} to ${maximum}`);
    return value;
}

function post(response: MovieDecoderResponse, transfer: Transferable[] = []): void {
    scope.postMessage(response, transfer);
}

function emptyStats(): MovieDecoderStats {
    return {
        packets: 0,
        decodedFrames: 0,
        outputFrames: 0,
        droppedFrames: 0,
        decodeWallTime: 0,
        pendingBytes: 0,
        wasmBytes: 0,
    };
}

function snapshotStats(): MovieDecoderStats {
    return {
        ...stats,
        pendingBytes,
        wasmBytes: libav?.HEAPU8.buffer.byteLength ?? 0,
    };
}

function stageFor(type: MovieDecoderRequest["type"]): MovieDecoderErrorStage {
    if (type === "initialize")
        return "initialize";
    if (type === "seek")
        return "seek";
    if (type === "dispose")
        return "dispose";
    return "decode";
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}
