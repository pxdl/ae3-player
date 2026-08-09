export interface StagePreviewDecodeRequest {
    type: "decode";
    requestId: number;
    generation: number;
    libavUrl: string;
    path: string;
    ipc: ArrayBuffer;
}

export interface DecodedStagePreview {
    type: "decoded";
    requestId: number;
    generation: number;
    width: 256;
    height: 256;
    rgba: ArrayBuffer;
}

export interface StagePreviewDecodeCancelled {
    type: "cancelled";
    requestId: number;
    generation: number;
}

export interface StagePreviewDecodeError {
    type: "error";
    requestId: number;
    generation: number;
    stage: "load" | "convert" | "decode" | "protocol";
    message: string;
}

export type StagePreviewDecoderResponse = DecodedStagePreview
    | StagePreviewDecodeCancelled | StagePreviewDecodeError;

export function isStagePreviewDecoderResponse(
    value: unknown,
): value is StagePreviewDecoderResponse {
    if (typeof value !== "object" || value === null) return false;
    const response = value as Partial<StagePreviewDecoderResponse>;
    if (!Number.isSafeInteger(response.requestId)
        || !Number.isSafeInteger(response.generation))
        return false;
    if (response.type === "decoded")
        return response.width === 256 && response.height === 256
            && response.rgba instanceof ArrayBuffer;
    if (response.type === "cancelled") return true;
    return response.type === "error"
        && (response.stage === "load" || response.stage === "convert"
            || response.stage === "decode" || response.stage === "protocol")
        && typeof response.message === "string";
}
