import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
    MovieDecoderCancelledError,
    MovieDecoderClient,
    MovieDecoderWorkerError,
} from "../src/movie-decoder-client.ts";
import type {
    DecoderReadyResponse,
    MovieDecoderRequest,
    MovieDecoderResponse,
} from "../src/movie-decoder-protocol.ts";

class FakeWorker {
    static instances: FakeWorker[] = [];

    onmessage: ((event: MessageEvent<MovieDecoderResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    readonly requests: MovieDecoderRequest[] = [];
    terminated = false;

    constructor() {
        FakeWorker.instances.push(this);
    }

    postMessage(request: MovieDecoderRequest): void {
        this.requests.push(request);
    }

    terminate(): void {
        this.terminated = true;
    }

    respond(response: MovieDecoderResponse): void {
        this.onmessage?.({ data: response } as MessageEvent<MovieDecoderResponse>);
    }
}

const originalWorker = globalThis.Worker;
Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
});

after(() => {
    Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: originalWorker,
    });
});

function source() {
    return {
        libavUrl: "https://example.invalid/libav.mjs",
        video: new ArrayBuffer(1),
        width: 2,
        height: 2,
        fieldOrder: "progressive" as const,
        frameRate: 30000 / 1001,
        duration: 1,
        sourceFrames: 1,
        seekPoints: [{ offset: 0, frame: 0 }],
    };
}

function ready(request: MovieDecoderRequest): DecoderReadyResponse {
    return {
        type: "ready",
        requestId: request.requestId,
        generation: request.generation,
        width: 2,
        height: 2,
        format: "I420",
        outputRate: 30000 / 1001,
        frameDuration: 1001 / 30000,
        sourceFrames: 1,
        outputFrames: 1,
        firstSeekPoint: { offset: 0, frame: 0 },
    };
}

async function initializedClient(): Promise<{
    client: MovieDecoderClient;
    worker: FakeWorker;
}> {
    const client = new MovieDecoderClient();
    const worker = FakeWorker.instances.at(-1)!;
    const initializing = client.initialize(source());
    worker.respond(ready(worker.requests[0]!));
    await initializing;
    return { client, worker };
}

test("ignores an error response from a cancelled decoder generation", async () => {
    const { client, worker } = await initializedClient();
    const pulling = client.pull({ untilTimestamp: 1, maxFrames: 1, maxBytes: 6 });
    const pullRequest = worker.requests.at(-1)!;
    const seeking = client.seek(0);
    const seekRequest = worker.requests.at(-1)!;

    await assert.rejects(pulling, MovieDecoderCancelledError);
    worker.respond({
        type: "error",
        requestId: pullRequest.requestId,
        generation: pullRequest.generation,
        stage: "decode",
        message: "stale decode failed",
    });
    worker.respond({
        type: "seeked",
        requestId: seekRequest.requestId,
        generation: seekRequest.generation,
        target: 0,
        timestamp: 0,
    });

    await seeking;
    assert.equal(worker.terminated, false);
    client.terminate();
});

test("rejects all pending work for an unknown current-generation request", async () => {
    const client = new MovieDecoderClient();
    const worker = FakeWorker.instances.at(-1)!;
    const initializing = client.initialize(source());
    const request = worker.requests[0]!;
    worker.respond({ ...ready(request), requestId: request.requestId + 99 });

    await assert.rejects(initializing, (error: unknown) => {
        assert.ok(error instanceof MovieDecoderWorkerError);
        assert.match(error.message, /unknown request/);
        return true;
    });
    assert.equal(worker.terminated, true);
});

test("rejects malformed nested frame data for the current request", async () => {
    const { client, worker } = await initializedClient();
    const pulling = client.pull({ untilTimestamp: 1, maxFrames: 1, maxBytes: 6 });
    const request = worker.requests.at(-1)!;
    worker.respond({
        type: "frames",
        requestId: request.requestId,
        generation: request.generation,
        frames: [{
            index: -1,
            timestamp: 0,
            duration: 1001 / 30000,
            width: 2,
            height: 2,
            format: "I420",
            data: new ArrayBuffer(6),
            layout: [
                { offset: 0, stride: 2 },
                { offset: 4, stride: 1 },
                { offset: 5, stride: 1 },
            ],
        }],
        eof: false,
        stats: {
            packets: 1,
            decodedFrames: 1,
            outputFrames: 1,
            droppedFrames: 0,
            decodeWallTime: 0,
            pendingBytes: 0,
            wasmBytes: 1,
        },
    } as unknown as MovieDecoderResponse);

    await assert.rejects(pulling, (error: unknown) => {
        assert.ok(error instanceof MovieDecoderWorkerError);
        assert.match(error.message, /malformed response/);
        return true;
    });
    assert.equal(worker.terminated, true);
});
