import type {
    DecoderEofResponse,
    DecoderFramesResponse,
    DecoderReadyResponse,
    DecoderSeekedResponse,
    InitializeDecoderRequest,
    MovieDecoderRequest,
    MovieDecoderResponse,
} from "./movie-decoder-protocol.ts";
import { isMovieDecoderResponse } from "./movie-decoder-protocol.ts";

export type MovieDecoderSource = Omit<InitializeDecoderRequest,
    "type" | "requestId" | "generation">;

export interface MovieDecoderPullOptions {
    untilTimestamp: number;
    maxFrames: number;
    maxBytes: number;
}

interface PendingRequest {
    generation: number;
    resolve: (response: MovieDecoderResponse) => void;
    reject: (cause: Error) => void;
}

export class MovieDecoderCancelledError extends Error {
    constructor() {
        super("movie decoder operation was cancelled");
        this.name = "MovieDecoderCancelledError";
    }
}

export class MovieDecoderWorkerError extends Error {
    readonly stage: string;

    constructor(stage: string, message: string) {
        super(message);
        this.name = "MovieDecoderWorkerError";
        this.stage = stage;
    }
}

const DISPOSE_ACK_TIMEOUT_MS = 250;

export class MovieDecoderClient {
    readonly #worker: Worker;
    readonly #pending = new Map<number, PendingRequest>();
    #requestId = 0;
    #generation = 0;
    #disposed = false;
    #workerTerminated = false;
    #terminalCause: Error | undefined;
    #disposePromise: Promise<void> | undefined;

    constructor() {
        this.#worker = new Worker(new URL("./movie-decoder.worker.ts", import.meta.url), {
            type: "module",
        });
        this.#worker.onmessage = event => this.#receive(event.data);
        this.#worker.onerror = event => {
            console.error("movie decoder worker failed", event.error ?? event);
            const location = event.filename
                ? ` (${event.filename}:${event.lineno}:${event.colno})`
                : "";
            const message = event.error instanceof Error
                ? event.error.message
                : event.message || "movie decoder worker failed";
            this.#latchFailure(new MovieDecoderWorkerError(
                "worker",
                `${message}${location}`,
            ));
        };
        this.#worker.onmessageerror = () => {
            this.#latchFailure(new MovieDecoderWorkerError(
                "protocol",
                "movie decoder response could not be cloned",
            ));
        };
    }

    get generation(): number {
        return this.#generation;
    }

    async initialize(source: MovieDecoderSource): Promise<DecoderReadyResponse> {
        this.#assertLive();
        if (this.#generation !== 0)
            throw new Error("movie decoder is already initialized");
        this.#generation = 1;
        const response = await this.#send({
            type: "initialize",
            requestId: this.#nextRequestId(),
            generation: this.#generation,
            ...source,
        }, [source.video]);
        if (response.type !== "ready")
            this.#protocolFailure("ready", response.type);
        return response;
    }

    prime(options: MovieDecoderPullOptions): Promise<DecoderFramesResponse | DecoderEofResponse> {
        return this.#decode("prime", options);
    }

    pull(options: MovieDecoderPullOptions): Promise<DecoderFramesResponse | DecoderEofResponse> {
        return this.#decode("pull", options);
    }

    async seek(target: number): Promise<DecoderSeekedResponse> {
        this.#assertInitialized();
        this.#generation++;
        this.#cancelOlderRequests();
        const response = await this.#send({
            type: "seek",
            requestId: this.#nextRequestId(),
            generation: this.#generation,
            target,
        });
        if (response.type !== "seeked")
            this.#protocolFailure("seeked", response.type);
        return response;
    }

    dispose(): Promise<void> {
        if (this.#disposePromise !== undefined)
            return this.#disposePromise;
        if (this.#terminalCause !== undefined || this.#disposed) {
            this.#disposed = true;
            this.#terminateWorker();
            this.#disposePromise = Promise.resolve();
            return this.#disposePromise;
        }

        this.#disposed = true;
        this.#generation++;
        this.#cancelOlderRequests();
        const request: MovieDecoderRequest = {
            type: "dispose",
            requestId: this.#nextRequestId(),
            generation: this.#generation,
        };
        this.#disposePromise = this.#disposeGracefully(request);
        return this.#disposePromise;
    }

    terminate(): void {
        if (this.#terminalCause !== undefined) {
            this.#terminateWorker();
            return;
        }
        if (!this.#disposed) {
            this.#disposed = true;
            this.#generation++;
        }
        this.#terminateWorker();
        this.#fail(new MovieDecoderCancelledError());
    }

    async #decode(type: "prime" | "pull", options: MovieDecoderPullOptions):
            Promise<DecoderFramesResponse | DecoderEofResponse> {
        this.#assertInitialized();
        const response = await this.#send({
            type,
            requestId: this.#nextRequestId(),
            generation: this.#generation,
            ...options,
        });
        if (response.type !== "frames" && response.type !== "eof")
            this.#protocolFailure("frames or eof", response.type);
        return response;
    }

    #send(request: MovieDecoderRequest, transfer: Transferable[] = []): Promise<MovieDecoderResponse> {
        if (this.#terminalCause !== undefined)
            return Promise.reject(this.#terminalCause);
        if (this.#disposed && request.type !== "dispose")
            return Promise.reject(new Error("movie decoder is disposed"));

        const { promise, resolve, reject } = Promise.withResolvers<MovieDecoderResponse>();
        this.#pending.set(request.requestId, { generation: request.generation, resolve, reject });
        try {
            this.#worker.postMessage(request, transfer);
        } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            this.#latchFailure(error);
        }
        return promise;
    }

    #receive(value: unknown): void {
        if (!isMovieDecoderResponse(value)) {
            this.#latchFailure(new MovieDecoderWorkerError(
                "protocol",
                "movie decoder returned a malformed response",
            ));
            return;
        }
        const pending = this.#pending.get(value.requestId);
        if (pending === undefined) {
            if (value.generation < this.#generation)
                return;
            this.#latchFailure(new MovieDecoderWorkerError(
                "protocol",
                `movie decoder returned unknown request ${value.requestId}`,
            ));
            return;
        }
        if (value.generation !== pending.generation) {
            this.#latchFailure(new MovieDecoderWorkerError(
                "protocol",
                "movie decoder returned the wrong generation",
            ));
            return;
        }
        this.#pending.delete(value.requestId);
        if (value.type === "error") {
            pending.reject(new MovieDecoderWorkerError(value.stage, value.message));
            return;
        }
        if (value.type === "cancelled") {
            pending.reject(new MovieDecoderCancelledError());
            return;
        }
        pending.resolve(value);
    }

    async #disposeGracefully(request: MovieDecoderRequest): Promise<void> {
        let timeoutId: number | undefined;
        const timeout = new Promise<undefined>(resolve => {
            timeoutId = setTimeout(resolve, DISPOSE_ACK_TIMEOUT_MS);
        });
        try {
            const response = await Promise.race([this.#send(request), timeout]);
            if (response !== undefined && response.type !== "disposed")
                this.#protocolFailure("disposed", response.type);
        } catch (cause) {
            if (this.#terminalCause !== undefined)
                throw this.#terminalCause;
            if (!(cause instanceof MovieDecoderCancelledError))
                throw cause;
        } finally {
            clearTimeout(timeoutId);
            this.#terminateWorker();
            this.#fail(new MovieDecoderCancelledError());
        }
    }

    #cancelOlderRequests(): void {
        for (const [requestId, pending] of this.#pending) {
            if (pending.generation >= this.#generation)
                continue;
            this.#pending.delete(requestId);
            pending.reject(new MovieDecoderCancelledError());
        }
    }

    #fail(cause: Error): void {
        for (const pending of this.#pending.values())
            pending.reject(cause);
        this.#pending.clear();
    }

    #latchFailure(cause: Error): void {
        if (this.#terminalCause !== undefined)
            return;
        this.#terminalCause = cause;
        this.#disposed = true;
        this.#terminateWorker();
        this.#fail(cause);
    }

    #terminateWorker(): void {
        if (this.#workerTerminated)
            return;
        this.#workerTerminated = true;
        this.#worker.onmessage = null;
        this.#worker.onerror = null;
        this.#worker.onmessageerror = null;
        this.#worker.terminate();
    }

    #protocolFailure(expected: string, actual: string): never {
        const cause = unexpectedResponse(expected, actual);
        this.#latchFailure(cause);
        throw cause;
    }

    #nextRequestId(): number {
        this.#requestId++;
        return this.#requestId;
    }

    #assertLive(): void {
        if (this.#terminalCause !== undefined)
            throw this.#terminalCause;
        if (this.#disposed)
            throw new Error("movie decoder is disposed");
    }

    #assertInitialized(): void {
        this.#assertLive();
        if (this.#generation === 0)
            throw new Error("movie decoder is not initialized");
    }
}

function unexpectedResponse(expected: string, actual: string): MovieDecoderWorkerError {
    return new MovieDecoderWorkerError("protocol", `expected ${expected}, received ${actual}`);
}

