/// <reference lib="webworker" />

import {
    isMovieMp4ExportCancelRequest,
    isMovieMp4ExportRequest,
    type MovieMp4ExportError,
    type MovieMp4ExportWorkerResponse,
} from "./movie-export-protocol.ts";
import {
    exportMovieMkv,
    exportMovieMp4,
    MovieExportStageError,
    MovieMp4ExportController,
} from "./movie-exporter.ts";

const PROGRESS_INTERVAL_MS = 80;
const scope = self as DedicatedWorkerGlobalScope;
let accepted = false;
let terminal = false;
let jobId: string | null = null;
let controller: MovieMp4ExportController | null = null;
let lastProgress = 0;
let lastProgressAt = 0;
let pendingProgress: { value: number; stage: string } | null = null;
let progressTimer: number | null = null;

scope.onmessage = (event: MessageEvent<unknown>) => {
    if (isMovieMp4ExportCancelRequest(event.data)) {
        void cancel(event.data.jobId);
        return;
    }
    if (!isMovieMp4ExportRequest(event.data))
        throw new TypeError("movie export worker received a malformed request");
    if (accepted)
        throw new Error("movie export worker accepts exactly one export request");
    accepted = true;
    jobId = event.data.jobId;
    controller = new MovieMp4ExportController();
    void run(event.data);
};

async function run(request: Parameters<typeof exportMovieMp4>[0]): Promise<void> {
    try {
        const exporter = request.format === "mkv" ? exportMovieMkv : exportMovieMp4;
        const result = await exporter(request, reportProgress, controller!);
        if (terminal)
            return;
        terminal = true;
        clearProgressTimer();
        post({
            type: "complete",
            jobId: request.jobId,
            buffer: result.buffer,
            mime: result.mime,
            encodedFrames: result.encodedFrames,
            duration: result.duration,
        }, [result.buffer]);
        scope.close();
    } catch (cause) {
        if (terminal)
            return;
        terminal = true;
        clearProgressTimer();
        const error: MovieMp4ExportError = {
            type: "error",
            jobId: request.jobId,
            stage: cause instanceof MovieExportStageError
                ? cause.stage
                : request.format === "mkv" ? "mux" : "encode",
            message: errorMessage(cause),
        };
        post(error);
        scope.close();
    }
}

async function cancel(cancelJobId: string): Promise<void> {
    if (!accepted || jobId === null || controller === null)
        throw new Error("movie export worker received cancel before export");
    if (cancelJobId !== jobId)
        throw new Error("movie export worker received cancel for the wrong job");
    if (terminal)
        return;
    terminal = true;
    clearProgressTimer();
    try {
        await controller.cancel(new DOMException("Movie export cancelled", "AbortError"));
    } catch (cause) {
        console.error("movie export cancellation cleanup failed", cause);
        post({
            type: "error",
            jobId,
            stage: "mux",
            message: errorMessage(cause),
        });
        scope.close();
        return;
    }
    post({ type: "cancelled", jobId });
    scope.close();
}

function reportProgress(value: number, stage: string): void {
    if (terminal)
        return;
    const monotonic = Math.max(lastProgress, Math.min(1, Math.max(0, value)));
    const now = performance.now();
    if (monotonic === 1 || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        clearProgressTimer();
        sendProgress(monotonic, stage);
        return;
    }
    pendingProgress = { value: monotonic, stage };
    if (progressTimer === null) {
        progressTimer = scope.setTimeout(() => {
            progressTimer = null;
            const pending = pendingProgress;
            pendingProgress = null;
            if (pending !== null && !terminal)
                sendProgress(pending.value, pending.stage);
        }, PROGRESS_INTERVAL_MS - (now - lastProgressAt));
    }
}

function sendProgress(value: number, stage: string): void {
    if (jobId === null)
        return;
    lastProgress = value;
    lastProgressAt = performance.now();
    post({ type: "progress", jobId, value, stage });
}

function clearProgressTimer(): void {
    if (progressTimer !== null)
        scope.clearTimeout(progressTimer);
    progressTimer = null;
    pendingProgress = null;
}

function post(response: MovieMp4ExportWorkerResponse,
              transfer: Transferable[] = []): void {
    scope.postMessage(response, transfer);
}

function errorMessage(cause: unknown): string {
    if (cause instanceof Error && cause.message.trim().length > 0)
        return cause.message;
    const message = String(cause);
    return message.trim().length > 0 ? message : "movie export failed";
}
