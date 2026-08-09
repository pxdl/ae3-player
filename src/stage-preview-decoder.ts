import {
    isStagePreviewDecoderResponse,
    type DecodedStagePreview,
    type StagePreviewDecodeRequest,
    type StagePreviewDecoderResponse,
} from "./stage-preview-decoder-protocol.ts";

interface PendingDecode {
    generation: number;
    resolve: (response: DecodedStagePreview) => void;
    reject: (cause: Error) => void;
}

export class StagePreviewDecodeCancelledError extends Error {
    constructor() {
        super("stage-preview decode was cancelled");
        this.name = "StagePreviewDecodeCancelledError";
    }
}

export class StagePreviewDecoderError extends Error {
    readonly stage: string;

    constructor(stage: string, message: string) {
        super(message);
        this.name = "StagePreviewDecoderError";
        this.stage = stage;
    }
}

export class StagePreviewDecoder {
    readonly #worker: Worker;
    readonly #pending = new Map<number, PendingDecode>();
    #requestId = 0;
    #generation = 0;
    #terminalError: Error | null = null;
    #disposed = false;

    constructor() {
        this.#worker = new Worker(
            new URL("./stage-preview-decoder.worker.ts", import.meta.url),
            { type: "module" },
        );
        this.#worker.onmessage = event => this.#receive(event.data);
        this.#worker.onerror = event => {
            const location = event.filename
                ? ` (${event.filename}:${event.lineno}:${event.colno})`
                : "";
            const message = event.error instanceof Error
                ? event.error.message
                : event.message || "stage-preview decoder worker failed";
            this.#fail(new StagePreviewDecoderError("worker", `${message}${location}`));
        };
        this.#worker.onmessageerror = () => {
            this.#fail(new StagePreviewDecoderError(
                "protocol",
                "stage-preview decoder response could not be cloned",
            ));
        };
    }

    async decode(ipc: Uint8Array, path: string): Promise<ImageData> {
        if (this.#disposed)
            throw new Error("stage-preview decoder is disposed");
        if (this.#terminalError)
            throw this.#terminalError;
        this.#generation++;
        for (const [requestId, pending] of this.#pending) {
            pending.reject(new StagePreviewDecodeCancelledError());
            this.#pending.delete(requestId);
        }

        const requestId = ++this.#requestId;
        const source = ipc.slice().buffer as ArrayBuffer;
        const request: StagePreviewDecodeRequest = {
            type: "decode",
            requestId,
            generation: this.#generation,
            libavUrl: new URL(
                `${import.meta.env.BASE_URL}${import.meta.env.DEV ? "public/" : ""}`
                    + "libav/libav-6.9.8.1-ae3-mpeg2.mjs",
                location.href,
            ).href,
            path,
            ipc: source,
        };
        const { promise, resolve, reject } = Promise.withResolvers<DecodedStagePreview>();
        this.#pending.set(requestId, { generation: this.#generation, resolve, reject });
        try {
            this.#worker.postMessage(request, [source]);
        } catch (cause) {
            this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
        }
        const decoded = await promise;
        return new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height);
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#worker.terminate();
        const error = new StagePreviewDecodeCancelledError();
        for (const pending of this.#pending.values())
            pending.reject(error);
        this.#pending.clear();
    }

    #receive(value: unknown): void {
        if (!isStagePreviewDecoderResponse(value)) {
            this.#fail(new StagePreviewDecoderError(
                "protocol",
                "stage-preview decoder returned a malformed response",
            ));
            return;
        }
        const pending = this.#pending.get(value.requestId);
        if (!pending) {
            if (value.generation < this.#generation) return;
            this.#fail(new StagePreviewDecoderError(
                "protocol",
                `stage-preview decoder returned unknown request ${value.requestId}`,
            ));
            return;
        }
        if (value.generation !== pending.generation) {
            this.#fail(new StagePreviewDecoderError(
                "protocol",
                "stage-preview decoder returned the wrong generation",
            ));
            return;
        }
        this.#pending.delete(value.requestId);
        if (value.type === "error") {
            pending.reject(new StagePreviewDecoderError(value.stage, value.message));
        } else if (value.type === "cancelled") {
            pending.reject(new StagePreviewDecodeCancelledError());
        } else {
            pending.resolve(value);
        }
    }

    #fail(cause: Error): void {
        if (!this.#terminalError) this.#terminalError = cause;
        this.#worker.terminate();
        for (const pending of this.#pending.values())
            pending.reject(this.#terminalError);
        this.#pending.clear();
    }
}

export type { StagePreviewDecoderResponse };
