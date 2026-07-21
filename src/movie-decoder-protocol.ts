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

export function isMovieDecoderResponse(value: unknown): value is MovieDecoderResponse {
    if (!hasResponseIdentity(value))
        return false;
    switch (value.type) {
        case "ready":
            return hasNumber(value, "width") && hasNumber(value, "height")
                && hasStringValue(value, "format", "I420")
                && hasNumber(value, "outputRate") && hasNumber(value, "frameDuration")
                && hasNumber(value, "sourceFrames") && hasNumber(value, "outputFrames")
                && "firstSeekPoint" in value && isSeekPoint(value.firstSeekPoint);
        case "frames":
            return "frames" in value && Array.isArray(value.frames)
                && value.frames.every(isDecodedMovieFrame)
                && "eof" in value && typeof value.eof === "boolean"
                && "stats" in value && isDecoderStats(value.stats);
        case "seeked":
            return hasNumber(value, "target") && hasNumber(value, "timestamp");
        case "eof":
            return "stats" in value && isDecoderStats(value.stats);
        case "disposed":
        case "cancelled":
            return true;
        case "error":
            return "stage" in value && isErrorStage(value.stage)
                && "message" in value && typeof value.message === "string";
        default:
            return false;
    }
}

function hasResponseIdentity(value: unknown): value is {
    type: string;
    requestId: number;
    generation: number;
} {
    return typeof value === "object" && value !== null
        && "type" in value && typeof value.type === "string"
        && "requestId" in value && typeof value.requestId === "number"
        && Number.isSafeInteger(value.requestId)
        && "generation" in value && typeof value.generation === "number"
        && Number.isSafeInteger(value.generation);
}

function isDecodedMovieFrame(value: unknown): value is DecodedMovieFrame {
    return typeof value === "object" && value !== null
        && hasNumber(value, "index") && hasNumber(value, "timestamp")
        && hasNumber(value, "duration") && hasNumber(value, "width")
        && hasNumber(value, "height") && hasStringValue(value, "format", "I420")
        && "data" in value && value.data instanceof ArrayBuffer
        && "layout" in value && Array.isArray(value.layout)
        && value.layout.length === 3 && value.layout.every(isPlaneLayout);
}

function isPlaneLayout(value: unknown): value is MoviePlaneLayout {
    return typeof value === "object" && value !== null
        && hasNumber(value, "offset") && hasNumber(value, "stride");
}

function isDecoderStats(value: unknown): value is MovieDecoderStats {
    return typeof value === "object" && value !== null
        && hasNumber(value, "packets") && hasNumber(value, "decodedFrames")
        && hasNumber(value, "outputFrames") && hasNumber(value, "droppedFrames")
        && hasNumber(value, "decodeWallTime") && hasNumber(value, "pendingBytes")
        && hasNumber(value, "wasmBytes");
}

function isSeekPoint(value: unknown): value is Mpeg2SeekPoint {
    return typeof value === "object" && value !== null
        && hasNumber(value, "offset") && hasNumber(value, "frame");
}

function hasNumber(value: object, key: string): boolean {
    return key in value && typeof value[key as keyof typeof value] === "number"
        && Number.isFinite(value[key as keyof typeof value]);
}

function hasStringValue(value: object, key: string, expected: string): boolean {
    return key in value && value[key as keyof typeof value] === expected;
}

function isErrorStage(value: unknown): value is MovieDecoderErrorStage {
    return value === "load" || value === "initialize" || value === "decode"
        || value === "seek" || value === "dispose" || value === "protocol";
}
