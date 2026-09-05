import type { MovieFieldOrder } from "./movie-decoder-protocol.ts";

export type MovieAspectRatio = readonly [number, number];
export type MovieExportFormat = "mp4" | "mkv";


export interface MovieMp4ExportExpectations {
    duration: number;
    width: number;
    height: number;
    fieldOrder: MovieFieldOrder;
    frameRate: number;
    sampleAspect: MovieAspectRatio;
    displayAspect: MovieAspectRatio;
    channels: number;
    sampleRate: number;
}

export interface MovieMp4ExportRequest {
    type: "export";
    format: MovieExportFormat;
    jobId: string;
    name: string;
    fmv: ArrayBuffer;
    audioTrack: number;
    audioLanguage: string | null;
    subtitleLanguage: string | null;
    vtt?: ArrayBuffer;
    expectations: MovieMp4ExportExpectations;
}

export interface MovieMp4ExportCancelRequest {
    type: "cancel";
    jobId: string;
}

export type MovieMp4ExportWorkerRequest = MovieMp4ExportRequest
    | MovieMp4ExportCancelRequest;

interface MovieMp4ExportResponseBase {
    jobId: string;
}

export interface MovieMp4ExportProgress extends MovieMp4ExportResponseBase {
    type: "progress";
    value: number;
    stage: string;
}

export interface MovieMp4ExportComplete extends MovieMp4ExportResponseBase {
    type: "complete";
    buffer: ArrayBuffer;
    mime: "video/mp4" | "video/x-matroska";
    encodedFrames: number;
    duration: number;
}

export interface MovieMp4ExportCancelled extends MovieMp4ExportResponseBase {
    type: "cancelled";
}

export type MovieMp4ExportErrorStage = "capability" | "demux" | "index"
    | "decode" | "encode" | "mux";

export interface MovieMp4ExportError extends MovieMp4ExportResponseBase {
    type: "error";
    stage: MovieMp4ExportErrorStage;
    message: string;
}

export type MovieMp4ExportWorkerResponse = MovieMp4ExportProgress
    | MovieMp4ExportComplete | MovieMp4ExportCancelled | MovieMp4ExportError;

export function isMovieMp4ExportRequest(value: unknown): value is MovieMp4ExportRequest {
    if (!isRecord(value) || value.type !== "export"
            || !hasExactKeys(value, [
                "type", "format", "jobId", "name", "fmv", "expectations",
                "audioTrack", "audioLanguage", "subtitleLanguage",
            ], ["vtt"]))
        return false;
    if (value.format !== "mp4" && value.format !== "mkv")
        return false;
    return isNonEmptyString(value.jobId)
        && isNonEmptyString(value.name)
        && value.fmv instanceof ArrayBuffer
        && Number.isSafeInteger(value.audioTrack)
        && (value.audioTrack as number) >= 0 && (value.audioTrack as number) < 5
        && isLanguage(value.audioLanguage) && isLanguage(value.subtitleLanguage)
        && (!("vtt" in value) || value.vtt instanceof ArrayBuffer)
        && isExpectations(value.expectations);
}

export function isMovieMp4ExportCancelRequest(
    value: unknown,
): value is MovieMp4ExportCancelRequest {
    return isRecord(value)
        && hasExactKeys(value, ["type", "jobId"])
        && value.type === "cancel"
        && isNonEmptyString(value.jobId);
}

export function isMovieMp4ExportWorkerRequest(
    value: unknown,
): value is MovieMp4ExportWorkerRequest {
    return isMovieMp4ExportRequest(value) || isMovieMp4ExportCancelRequest(value);
}

export function isMovieMp4ExportWorkerResponse(
    value: unknown,
): value is MovieMp4ExportWorkerResponse {
    if (!isRecord(value) || !isNonEmptyString(value.jobId))
        return false;
    switch (value.type) {
    case "progress":
        return hasExactKeys(value, ["type", "jobId", "value", "stage"])
            && isUnitInterval(value.value)
            && isNonEmptyString(value.stage);
    case "complete":
        return hasExactKeys(value, [
            "type", "jobId", "buffer", "mime", "encodedFrames", "duration",
        ])
            && value.buffer instanceof ArrayBuffer
            && value.buffer.byteLength > 0
            && (value.mime === "video/mp4" || value.mime === "video/x-matroska")
            && isPositiveInteger(value.encodedFrames)
            && isPositiveFinite(value.duration);
    case "cancelled":
        return hasExactKeys(value, ["type", "jobId"]);
    case "error":
        return hasExactKeys(value, ["type", "jobId", "stage", "message"])
            && isErrorStage(value.stage)
            && isNonEmptyString(value.message);
    default:
        return false;
    }
}

function isExpectations(value: unknown): value is MovieMp4ExportExpectations {
    return isRecord(value)
        && hasExactKeys(value, [
            "duration", "width", "height", "fieldOrder", "sampleAspect",
            "displayAspect", "channels", "sampleRate",
            "frameRate",
        ])
        && isPositiveFinite(value.duration)
        && isPositiveInteger(value.width)
        && isPositiveInteger(value.height)
        && isFieldOrder(value.fieldOrder)
        && (value.frameRate === 25 || value.frameRate === 30000 / 1001)
        && isAspectRatio(value.sampleAspect)
        && isAspectRatio(value.displayAspect)
        && isPositiveInteger(value.channels)
        && isPositiveInteger(value.sampleRate);
}

function isLanguage(value: unknown): value is string | null {
    return value === null || (typeof value === "string" && /^[a-z]{3}$/.test(value));
}

function isAspectRatio(value: unknown): value is MovieAspectRatio {
    return Array.isArray(value)
        && value.length === 2
        && isPositiveInteger(value[0])
        && isPositiveInteger(value[1]);
}

function isFieldOrder(value: unknown): value is MovieFieldOrder {
    return value === "progressive" || value === "tt" || value === "bb";
}

function isErrorStage(value: unknown): value is MovieMp4ExportErrorStage {
    return value === "capability" || value === "demux" || value === "index"
        || value === "decode" || value === "encode" || value === "mux";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[],
                      optional: readonly string[] = []): boolean {
    const keys = Object.keys(value);
    return required.every(key => key in value)
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isUnitInterval(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
