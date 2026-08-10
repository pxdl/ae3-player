import type { Mpeg2SeekPoint } from "./vendor/extract/index.ts";

export type MovieFieldOrder = "progressive" | "tt" | "bb";

export interface MoviePlaneLayout {
    offset: number;
    stride: number;
}

export interface DecodedMovieFrame {
    index: number;
    timestamp: number;
    duration: number;
    width: number;
    height: number;
    format: "I420";
    data: ArrayBuffer;
    layout: readonly [MoviePlaneLayout, MoviePlaneLayout, MoviePlaneLayout];
}

interface DecoderRequest {
    requestId: number;
    generation: number;
}

export interface InitializeDecoderRequest extends DecoderRequest {
    type: "initialize";
    libavUrl: string;
    video: ArrayBuffer;
    width: number;
    height: number;
    fieldOrder: MovieFieldOrder;
    duration: number;
    sourceFrames: number;
    seekPoints: readonly Mpeg2SeekPoint[];
}

export interface DecodeFramesRequest extends DecoderRequest {
    type: "prime" | "pull";
    untilTimestamp: number;
    maxFrames: number;
    maxBytes: number;
}

export interface SeekDecoderRequest extends DecoderRequest {
    type: "seek";
    target: number;
}

export interface DisposeDecoderRequest extends DecoderRequest {
    type: "dispose";
}

export type MovieDecoderRequest = InitializeDecoderRequest | DecodeFramesRequest
    | SeekDecoderRequest | DisposeDecoderRequest;

interface DecoderResponse {
    requestId: number;
    generation: number;
}

export interface DecoderReadyResponse extends DecoderResponse {
    type: "ready";
    width: number;
    height: number;
    format: "I420";
    outputRate: number;
    frameDuration: number;
    sourceFrames: number;
    outputFrames: number;
    firstSeekPoint: Mpeg2SeekPoint;
}

export interface DecoderFramesResponse extends DecoderResponse {
    type: "frames";
    frames: DecodedMovieFrame[];
    eof: boolean;
    stats: MovieDecoderStats;
}

export interface DecoderSeekedResponse extends DecoderResponse {
    type: "seeked";
    target: number;
    timestamp: number;
}

export interface DecoderEofResponse extends DecoderResponse {
    type: "eof";
    stats: MovieDecoderStats;
}

export interface DecoderDisposedResponse extends DecoderResponse {
    type: "disposed";
}

export interface DecoderCancelledResponse extends DecoderResponse {
    type: "cancelled";
}

export type MovieDecoderErrorStage = "load" | "initialize" | "decode" | "seek"
    | "dispose" | "protocol";

export interface DecoderErrorResponse extends DecoderResponse {
    type: "error";
    stage: MovieDecoderErrorStage;
    message: string;
}

export type MovieDecoderResponse = DecoderReadyResponse | DecoderFramesResponse
    | DecoderSeekedResponse | DecoderEofResponse | DecoderDisposedResponse
    | DecoderCancelledResponse | DecoderErrorResponse;

export interface MovieDecoderStats {
    packets: number;
    decodedFrames: number;
    outputFrames: number;
    droppedFrames: number;
    decodeWallTime: number;
    pendingBytes: number;
    wasmBytes: number;
}

export const MPEG_FRAME_DURATION = 1001 / 30000;
export const MPEG_BOB_FRAME_DURATION = 1001 / 60000;

export function movieOutputFrameDuration(fieldOrder: MovieFieldOrder): number {
    return fieldOrder === "progressive" ? MPEG_FRAME_DURATION : MPEG_BOB_FRAME_DURATION;
}

export function movieFrameByteLength(width: number, height: number): number {
    if (!Number.isInteger(width) || !Number.isInteger(height)
            || width <= 0 || height <= 0 || (width & 1) !== 0 || (height & 1) !== 0)
        throw new Error(`invalid I420 dimensions ${width}x${height}`);
    return width * height * 3 / 2;
}

type UnknownRecord = Record<string, unknown>;

const RESPONSE_IDENTITY_KEYS = ["type", "requestId", "generation"] as const;
const READY_KEYS = new Set([
    ...RESPONSE_IDENTITY_KEYS,
    "width", "height", "format", "outputRate", "frameDuration",
    "sourceFrames", "outputFrames", "firstSeekPoint",
]);
const FRAMES_KEYS = new Set([
    ...RESPONSE_IDENTITY_KEYS, "frames", "eof", "stats",
]);
const SEEKED_KEYS = new Set([
    ...RESPONSE_IDENTITY_KEYS, "target", "timestamp",
]);
const STATS_RESPONSE_KEYS = new Set([...RESPONSE_IDENTITY_KEYS, "stats"]);
const TERMINAL_KEYS = new Set(RESPONSE_IDENTITY_KEYS);
const ERROR_KEYS = new Set([
    ...RESPONSE_IDENTITY_KEYS, "stage", "message",
]);
const FRAME_KEYS = new Set([
    "index", "timestamp", "duration", "width", "height",
    "format", "data", "layout",
]);
const PLANE_KEYS = new Set(["offset", "stride"]);
const STATS_KEYS = new Set([
    "packets", "decodedFrames", "outputFrames", "droppedFrames",
    "decodeWallTime", "pendingBytes", "wasmBytes",
]);
const SEEK_POINT_KEYS = new Set(["offset", "frame"]);

export function isMovieDecoderResponse(value: unknown): value is MovieDecoderResponse {
    const response = responseRecord(value);
    if (!response) return false;
    switch (response.type) {
        case "ready":
            return hasOnlyKeys(response, READY_KEYS)
                && hasDimensions(response.width, response.height)
                && response.format === "I420"
                && isPositiveFinite(response.outputRate)
                && isPositiveFinite(response.frameDuration)
                && isPositiveSafeInteger(response.sourceFrames)
                && isPositiveSafeInteger(response.outputFrames)
                && response.outputFrames >= response.sourceFrames
                && isSeekPoint(response.firstSeekPoint);
        case "frames":
            return hasOnlyKeys(response, FRAMES_KEYS)
                && Array.isArray(response.frames)
                && response.frames.every(isDecodedMovieFrame)
                && typeof response.eof === "boolean"
                && isDecoderStats(response.stats);
        case "seeked":
            return hasOnlyKeys(response, SEEKED_KEYS)
                && isNonnegativeFinite(response.target)
                && isNonnegativeFinite(response.timestamp);
        case "eof":
            return hasOnlyKeys(response, STATS_RESPONSE_KEYS)
                && isDecoderStats(response.stats);
        case "disposed":
        case "cancelled":
            return hasOnlyKeys(response, TERMINAL_KEYS);
        case "error":
            return hasOnlyKeys(response, ERROR_KEYS)
                && isErrorStage(response.stage)
                && typeof response.message === "string"
                && response.message.length > 0;
        default:
            return false;
    }
}

function record(value: unknown): UnknownRecord | null {
    return typeof value === "object" && value !== null
        ? value as UnknownRecord
        : null;
}

function responseRecord(value: unknown): UnknownRecord | null {
    const response = record(value);
    return response
        && typeof response.type === "string"
        && isPositiveSafeInteger(response.requestId)
        && isPositiveSafeInteger(response.generation)
        ? response
        : null;
}

function hasOnlyKeys(
    value: UnknownRecord,
    allowed: ReadonlySet<string>,
): boolean {
    return Object.keys(value).every(key => allowed.has(key));
}

function hasDimensions(width: unknown, height: unknown): boolean {
    return isPositiveSafeInteger(width)
        && isPositiveSafeInteger(height)
        && (width & 1) === 0
        && (height & 1) === 0
        && Number.isSafeInteger(width * height * 3 / 2);
}

function isDecodedMovieFrame(value: unknown): value is DecodedMovieFrame {
    const frame = record(value);
    if (!frame
            || !hasOnlyKeys(frame, FRAME_KEYS)
            || !isNonnegativeSafeInteger(frame.index)
            || !isNonnegativeFinite(frame.timestamp)
            || !isPositiveFinite(frame.duration)
            || !hasDimensions(frame.width, frame.height)
            || frame.format !== "I420"
            || !(frame.data instanceof ArrayBuffer)
            || !Array.isArray(frame.layout)
            || frame.layout.length !== 3)
        return false;
    const width = frame.width as number;
    const height = frame.height as number;
    const yBytes = width * height;
    const chromaBytes = yBytes / 4;
    return frame.data.byteLength === movieFrameByteLength(width, height)
        && isPlaneLayout(frame.layout[0], 0, width)
        && isPlaneLayout(frame.layout[1], yBytes, width / 2)
        && isPlaneLayout(frame.layout[2], yBytes + chromaBytes, width / 2);
}

function isPlaneLayout(
    value: unknown,
    offset: number,
    stride: number,
): value is MoviePlaneLayout {
    const plane = record(value);
    return plane !== null
        && hasOnlyKeys(plane, PLANE_KEYS)
        && plane.offset === offset
        && plane.stride === stride;
}

function isDecoderStats(value: unknown): value is MovieDecoderStats {
    const stats = record(value);
    return stats !== null
        && hasOnlyKeys(stats, STATS_KEYS)
        && isNonnegativeSafeInteger(stats.packets)
        && isNonnegativeSafeInteger(stats.decodedFrames)
        && isNonnegativeSafeInteger(stats.outputFrames)
        && isNonnegativeSafeInteger(stats.droppedFrames)
        && isNonnegativeFinite(stats.decodeWallTime)
        && isNonnegativeSafeInteger(stats.pendingBytes)
        && isNonnegativeSafeInteger(stats.wasmBytes);
}

function isSeekPoint(value: unknown): value is Mpeg2SeekPoint {
    const point = record(value);
    return point !== null
        && hasOnlyKeys(point, SEEK_POINT_KEYS)
        && isNonnegativeSafeInteger(point.offset)
        && isNonnegativeSafeInteger(point.frame);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonnegativeFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isErrorStage(value: unknown): value is MovieDecoderErrorStage {
    return value === "load" || value === "initialize" || value === "decode"
        || value === "seek" || value === "dispose" || value === "protocol";
}
