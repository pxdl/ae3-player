import {
    isMovieMp4ExportWorkerResponse,
    type MovieExportFormat,
    type MovieMp4ExportErrorStage,
    type MovieMp4ExportExpectations,
    type MovieMp4ExportRequest,
} from "./movie-export-protocol.ts";
import type { MovieProgress } from "./movies.ts";

const CANCEL_ACK_TIMEOUT_MS = 300;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

export interface MovieExportInput {
    name: string;
    fmv: Uint8Array;
    vtt?: Uint8Array;
    expectations: MovieMp4ExportExpectations;
    cooperativeCopy?: boolean;
}

export class MovieExportWorkerError extends Error {
    readonly stage: MovieMp4ExportErrorStage;

    constructor(stage: MovieMp4ExportErrorStage, message: string) {
        super(message);
        this.name = "MovieExportWorkerError";
        this.stage = stage;
    }
}

export function exportMovieMp4(input: MovieExportInput, progress: MovieProgress,
                               signal?: AbortSignal): Promise<Uint8Array> {
    return exportMovie("mp4", input, progress, signal);
}

export function exportMovieMkv(input: MovieExportInput, progress: MovieProgress,
                               signal?: AbortSignal): Promise<Uint8Array> {
    return exportMovie("mkv", input, progress, signal);
}

async function exportMovie(format: MovieExportFormat, input: MovieExportInput,
                           progress: MovieProgress,
                           signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const fmv = await ownedCopy(input.fmv, input.cooperativeCopy === true, signal);
    const vtt = input.vtt === undefined
        ? undefined
        : await ownedCopy(input.vtt, input.cooperativeCopy === true, signal);
    signal?.throwIfAborted();

    const worker = new Worker(new URL("./movie-export.worker.ts", import.meta.url), {
        type: "module",
    });
    const jobId = crypto.randomUUID();
    const request: MovieMp4ExportRequest = {
        type: "export",
        format,
        jobId,
        name: input.name,
        fmv,
        expectations: input.expectations,
        ...(vtt === undefined ? {} : { vtt }),
    };
    const transfer: Transferable[] = vtt === undefined ? [fmv] : [fmv, vtt];
    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
    let settled = false;
    let aborting = false;
    let lastProgress = 0;
    let cancelTimer: number | undefined;

    const detach = (): void => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        signal?.removeEventListener("abort", aborted);
        clearTimeout(cancelTimer);
    };
    const terminate = (): void => {
        detach();
        worker.terminate();
    };
    const fail = (cause: unknown): void => {
        if (settled)
            return;
        settled = true;
        terminate();
        reject(cause);
    };
    const aborted = (): void => {
        if (settled)
            return;
        settled = true;
        aborting = true;
        signal?.removeEventListener("abort", aborted);
        try {
            worker.postMessage({ type: "cancel", jobId });
        } catch {
            terminate();
            aborting = false;
        }
        reject(signal?.reason);
        if (aborting) {
            cancelTimer = setTimeout(() => {
                aborting = false;
                terminate();
            }, CANCEL_ACK_TIMEOUT_MS);
        }
    };

    worker.onmessage = (event: MessageEvent<unknown>): void => {
        if (!isMovieMp4ExportWorkerResponse(event.data)
                || event.data.jobId !== jobId) {
            if (!settled)
                fail(new Error("movie export worker returned a malformed response"));
            return;
        }
        const response = event.data;
        if (aborting) {
            if (response.type === "cancelled") {
                aborting = false;
                terminate();
            }
            return;
        }
        if (settled)
            return;
        switch (response.type) {
        case "progress":
            if (response.value < lastProgress) {
                fail(new Error("movie export worker reported regressing progress"));
                return;
            }
            lastProgress = Math.max(lastProgress, response.value);
            progress(lastProgress, response.stage);
            break;
        case "complete":
            if (response.mime !== (format === "mp4" ? "video/mp4" : "video/x-matroska")) {
                fail(new Error("movie export worker returned the wrong container format"));
                return;
            }
            settled = true;
            terminate();
            resolve(new Uint8Array(response.buffer));
            break;
        case "error":
            fail(new MovieExportWorkerError(response.stage, response.message));
            break;
        case "cancelled":
            fail(new Error("movie export worker cancelled unexpectedly"));
            break;
        }
    };
    worker.onerror = (event): void => {
        const location = event.filename
            ? ` (${event.filename}:${event.lineno}:${event.colno})`
            : "";
        const message = event.error instanceof Error
            ? event.error.message
            : event.message || "movie export worker failed";
        fail(new Error(`${message}${location}`, { cause: event.error }));
    };
    worker.onmessageerror = (): void => {
        fail(new Error("movie export worker response could not be cloned"));
    };
    signal?.addEventListener("abort", aborted, { once: true });

    if (signal?.aborted) {
        aborted();
        return promise;
    }
    try {
        worker.postMessage(request, transfer);
    } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return promise;
}

async function ownedCopy(bytes: Uint8Array, cooperative: boolean,
                         signal?: AbortSignal): Promise<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    if (!cooperative) {
        copy.set(bytes);
        return copy.buffer;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += COPY_CHUNK_BYTES) {
        signal?.throwIfAborted();
        const end = Math.min(bytes.byteLength, offset + COPY_CHUNK_BYTES);
        copy.set(bytes.subarray(offset, end), offset);
        if (end < bytes.byteLength)
            await yieldToMainThread();
    }
    signal?.throwIfAborted();
    return copy.buffer;
}

function yieldToMainThread(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
