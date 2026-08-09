/// <reference lib="webworker" />

import { ipcToIpum } from "./vendor/extract/index.ts";
import type {
    StagePreviewDecodeError,
    StagePreviewDecodeRequest,
    StagePreviewDecoderResponse,
} from "./stage-preview-decoder-protocol.ts";

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
    AV_PIX_FMT_YUV420P: number;
    mkreadaheadfile(name: string, blob: Blob): Promise<void>;
    unlinkreadaheadfile(name: string): Promise<void>;
    ff_init_demuxer_file(name: string, format: string): Promise<[number, LibAvStream[]]>;
    ff_init_decoder(codecId: number, options: {
        codecpar: number;
        time_base: [number, number];
    }): Promise<[number, number, number, number]>;
    ff_read_frame_multi(formatContext: number, packet: number, options: {
        limit: number;
    }): Promise<[number, Record<number, LibAvPacket[]>]>;
    ff_decode_multi(decoder: number, packet: number, frame: number,
        packets: LibAvPacket[], options: {
            fin?: boolean;
            copyoutFrame: "video_packed";
        }): Promise<LibAvPackedFrame[]>;
    avformat_close_input_js(formatContext: number): Promise<void>;
    ff_free_decoder(decoder: number, packet: number, frame: number): Promise<void>;
}

interface LibAvFactory {
    base: string;
    LibAV(options: { noworker: true }): Promise<LibAvInstance>;
}

type DecodeStage = StagePreviewDecodeError["stage"];

class CancelledDecode extends Error {}

class DecodeError extends Error {
    readonly stage: DecodeStage;

    constructor(stage: DecodeStage, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.stage = stage;
    }
}

const scope = self as DedicatedWorkerGlobalScope;
const INPUT_NAME = "stage-preview.ipu";
const PACKET_READ_LIMIT = 64 * 1024;
const MAX_NO_PROGRESS_READS = 16;

let latestGeneration = 0;
let operationChain = Promise.resolve();
let libavPromise: Promise<LibAvInstance> | null = null;
let loadedLibavUrl: string | null = null;

scope.onmessage = (event: MessageEvent<unknown>) => {
    let request: StagePreviewDecodeRequest;
    try {
        request = parseRequest(event.data);
    } catch (cause) {
        const value = typeof event.data === "object" && event.data !== null
            ? event.data as { requestId?: unknown; generation?: unknown }
            : {};
        post({
            type: "error",
            requestId: Number.isSafeInteger(value.requestId) ? value.requestId as number : 0,
            generation: Number.isSafeInteger(value.generation) ? value.generation as number : 0,
            stage: "protocol",
            message: cause instanceof Error ? cause.message : String(cause),
        });
        return;
    }
    latestGeneration = Math.max(latestGeneration, request.generation);
    operationChain = operationChain.then(async () => {
        if (request.generation < latestGeneration) {
            post({
                type: "cancelled",
                requestId: request.requestId,
                generation: request.generation,
            });
            return;
        }
        try {
            await decode(request);
        } catch (cause) {
            if (cause instanceof CancelledDecode) {
                post({
                    type: "cancelled",
                    requestId: request.requestId,
                    generation: request.generation,
                });
                return;
            }
            post({
                type: "error",
                requestId: request.requestId,
                generation: request.generation,
                stage: cause instanceof DecodeError ? cause.stage : "decode",
                message: cause instanceof Error ? cause.message : String(cause),
            });
        }
    });
};

async function decode(request: StagePreviewDecodeRequest): Promise<void> {
    let ipum: Uint8Array;
    try {
        ipum = ipcToIpum(new Uint8Array(request.ipc), request.path);
    } catch (cause) {
        throw new DecodeError("convert", cause);
    }
    assertCurrent(request.generation);

    let av: LibAvInstance;
    try {
        av = await loadLibAv(request.libavUrl);
    } catch (cause) {
        throw new DecodeError("load", cause);
    }
    assertCurrent(request.generation);

    let formatContext = 0;
    let decoder = 0;
    let packet = 0;
    let frame = 0;
    let mounted = false;
    try {
        await av.mkreadaheadfile(INPUT_NAME, new Blob([ipum.buffer as ArrayBuffer]));
        mounted = true;
        assertCurrent(request.generation);
        const initialized = await av.ff_init_demuxer_file(INPUT_NAME, "ipu");
        formatContext = initialized[0];
        const stream = initialized[1].find(candidate => candidate.codec_id !== 0);
        if (!stream)
            throw new DecodeError("decode", "IPU video stream was not found");
        const decoderState = await av.ff_init_decoder(stream.codec_id, {
            codecpar: stream.codecpar,
            time_base: [stream.time_base_num, stream.time_base_den],
        });
        decoder = decoderState[1];
        packet = decoderState[2];
        frame = decoderState[3];
        assertCurrent(request.generation);

        const decoded: LibAvPackedFrame[] = [];
        let noProgressReads = 0;
        while (true) {
            const [readCode, packetsByStream] = await av.ff_read_frame_multi(
                formatContext,
                packet,
                { limit: PACKET_READ_LIMIT },
            );
            assertCurrent(request.generation);
            if (readCode < 0 && readCode !== av.AVERROR_EOF && readCode !== -av.EAGAIN)
                throw new DecodeError("decode", `IPU demux failed (${readCode})`);
            const packets = packetsByStream[stream.index] ?? [];
            const atEnd = readCode === av.AVERROR_EOF;
            const frames = await av.ff_decode_multi(decoder, packet, frame, packets,
                atEnd
                    ? { fin: true, copyoutFrame: "video_packed" }
                    : { copyoutFrame: "video_packed" });
            decoded.push(...frames);
            if (atEnd) break;
            if (packets.length > 0 || frames.length > 0) {
                noProgressReads = 0;
            } else if (++noProgressReads >= MAX_NO_PROGRESS_READS) {
                throw new DecodeError("decode", "IPU demux repeatedly made no progress");
            }
        }

        if (decoded.length !== 1)
            throw new DecodeError("decode", `IPU produced ${decoded.length} frames; expected 1`);
        const source = decoded[0]!;
        if (source.width !== 256 || source.height !== 256
            || source.format !== av.AV_PIX_FMT_YUV420P
            || source.data.byteLength !== 256 * 256 * 3 / 2)
            throw new DecodeError("decode", `unexpected IPU frame ${source.width}x${source.height}, format ${source.format}, ${source.data.byteLength} bytes`);
        const rgba = ae3ColumnMajorI420ToRgba(source.data, source.width, source.height);
        const rgbaBuffer = rgba.buffer as ArrayBuffer;
        assertCurrent(request.generation);
        post({
            type: "decoded",
            requestId: request.requestId,
            generation: request.generation,
            width: 256,
            height: 256,
            rgba: rgbaBuffer,
        }, [rgbaBuffer]);
    } finally {
        if (formatContext !== 0)
            await av.avformat_close_input_js(formatContext);
        if (decoder !== 0)
            await av.ff_free_decoder(decoder, packet, frame);
        if (mounted)
            await av.unlinkreadaheadfile(INPUT_NAME);
    }
}

/**
 * FFmpeg's IPU decoder writes stream macroblocks in raster order. AE3 authored
 * them in IPUenc mode 2 order, so each decoded macroblock is copied from its
 * raster slot to the matching column-major slot while YUV420P becomes RGBA.
 */
function ae3ColumnMajorI420ToRgba(data: Uint8Array, width: number,
                                  height: number): Uint8ClampedArray {
    const expected = width * height * 3 / 2;
    if ((width & 15) !== 0 || (height & 15) !== 0 || data.length !== expected)
        throw new DecodeError("decode", `invalid AE3 I420 frame ${width}x${height}, ${data.length} bytes`);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const macroblockWidth = width / 16;
    const macroblockHeight = height / 16;
    const chromaWidth = width / 2;
    const blueOffset = width * height;
    const redOffset = blueOffset + width * height / 4;

    for (let index = 0; index < macroblockWidth * macroblockHeight; index++) {
        const sourceLeft = index % macroblockWidth * 16;
        const sourceTop = Math.floor(index / macroblockWidth) * 16;
        const targetLeft = Math.floor(index / macroblockHeight) * 16;
        const targetTop = index % macroblockHeight * 16;
        for (let row = 0; row < 16; row++) {
            for (let column = 0; column < 16; column++) {
                const sourceX = sourceLeft + column;
                const sourceY = sourceTop + row;
                const targetX = targetLeft + column;
                const targetY = targetTop + row;
                const y = data[sourceY * width + sourceX]! - 16;
                const chroma = Math.floor(sourceY / 2) * chromaWidth
                    + Math.floor(sourceX / 2);
                const blue = data[blueOffset + chroma]! - 128;
                const red = data[redOffset + chroma]! - 128;
                const target = (targetY * width + targetX) * 4;
                rgba[target] = (298 * y + 409 * red + 128) >> 8;
                rgba[target + 1] = (298 * y - 100 * blue - 208 * red + 128) >> 8;
                rgba[target + 2] = (298 * y + 516 * blue + 128) >> 8;
                rgba[target + 3] = 255;
            }
        }
    }
    return rgba;
}

async function loadLibAv(url: string): Promise<LibAvInstance> {
    if (libavPromise) {
        if (loadedLibavUrl !== url)
            throw new Error("stage decoder libav URL changed after initialization");
        return libavPromise;
    }
    if (!url)
        throw new Error("libavUrl is required");
    loadedLibavUrl = url;
    libavPromise = (async () => {
        // libav is a runtime-served generated asset and is intentionally not bundled.
        const imported: unknown = await import(/* @vite-ignore */ url);
        const candidate = typeof imported === "object" && imported !== null
            && "default" in imported ? imported.default : imported;
        if ((typeof candidate !== "object" && typeof candidate !== "function")
            || candidate === null || !("base" in candidate)
            || typeof candidate.base !== "string" || !("LibAV" in candidate)
            || typeof candidate.LibAV !== "function")
            throw new Error("libav.js did not export LibAV");
        const factory = candidate as LibAvFactory;
        factory.base = new URL(".", url).href;
        return factory.LibAV({ noworker: true });
    })();
    try {
        return await libavPromise;
    } catch (cause) {
        libavPromise = null;
        loadedLibavUrl = null;
        throw cause;
    }
}

function parseRequest(value: unknown): StagePreviewDecodeRequest {
    if (typeof value !== "object" || value === null)
        throw new Error("stage decoder request must be an object");
    const request = value as Partial<StagePreviewDecodeRequest>;
    if (request.type !== "decode" || !Number.isSafeInteger(request.requestId)
        || !Number.isSafeInteger(request.generation) || request.generation! < 1
        || typeof request.libavUrl !== "string" || request.libavUrl.length === 0
        || typeof request.path !== "string" || request.path.length === 0
        || !(request.ipc instanceof ArrayBuffer))
        throw new Error("stage decoder received a malformed decode request");
    return request as StagePreviewDecodeRequest;
}

function assertCurrent(generation: number): void {
    if (generation < latestGeneration)
        throw new CancelledDecode();
}

function post(response: StagePreviewDecoderResponse,
              transfer: Transferable[] = []): void {
    scope.postMessage(response, transfer);
}
