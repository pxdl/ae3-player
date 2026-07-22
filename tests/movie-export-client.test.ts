import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
    exportMovieMp4,
    MovieMp4ExportWorkerError,
} from "../src/movie-export-client.ts";
import type {
    MovieMp4ExportWorkerRequest,
    MovieMp4ExportWorkerResponse,
} from "../src/movie-export-protocol.ts";

class FakeWorker {
    static instances: FakeWorker[] = [];

    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    readonly requests: MovieMp4ExportWorkerRequest[] = [];
    terminated = false;

    constructor() {
        FakeWorker.instances.push(this);
    }

    postMessage(request: MovieMp4ExportWorkerRequest,
                transfer: Transferable[] = []): void {
        this.requests.push(structuredClone(request, { transfer }));
    }

    terminate(): void {
        this.terminated = true;
    }

    respond(response: unknown): void {
        this.onmessage?.({ data: response } as MessageEvent<unknown>);
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

beforeEach(() => {
    FakeWorker.instances.length = 0;
});

function input(source = new Uint8Array([1, 2, 3, 4])) {
    return {
        name: "new_advertise",
        fmv: source,
        expectations: {
            duration: 1,
            width: 512,
            height: 320,
            fieldOrder: "progressive" as const,
            sampleAspect: [7, 6] as const,
            displayAspect: [28, 15] as const,
            channels: 2,
            sampleRate: 48_000,
        },
    };
}

async function currentWorker(): Promise<FakeWorker> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const worker = FakeWorker.instances.at(-1);
        if (worker)
            return worker;
        await Promise.resolve();
    }
    throw new Error("export worker was not created");
}

function complete(worker: FakeWorker, buffer = new Uint8Array([9, 8, 7]).buffer): void {
    const request = worker.requests[0];
    assert.equal(request?.type, "export");
    worker.respond({
        type: "complete",
        jobId: request.jobId,
        buffer,
        mime: "video/mp4",
        encodedFrames: 1,
        duration: 1,
    } satisfies MovieMp4ExportWorkerResponse);
}

test("transfers a non-empty result and relays monotonic progress", async () => {
    const updates: Array<[number, string]> = [];
    const promise = exportMovieMp4(input(), (value, stage) => updates.push([value, stage]));
    const worker = await currentWorker();
    const request = worker.requests[0];
    assert.equal(request.type, "export");
    worker.respond({
        type: "progress",
        jobId: request.jobId,
        value: 0.25,
        stage: "Demuxing movie…",
    } satisfies MovieMp4ExportWorkerResponse);
    worker.respond({
        type: "progress",
        jobId: request.jobId,
        value: 0.75,
        stage: "Encoding movie…",
    } satisfies MovieMp4ExportWorkerResponse);
    complete(worker);

    const result = await promise;
    assert.deepEqual([...result], [9, 8, 7]);
    assert.deepEqual(updates, [
        [0.25, "Demuxing movie…"],
        [0.75, "Encoding movie…"],
    ]);
    assert.equal(worker.terminated, true);
});

test("abort before start creates no worker", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    await assert.rejects(exportMovieMp4(input(), () => {}, controller.signal),
        cause => cause === reason);
    assert.equal(FakeWorker.instances.length, 0);
});

test("mid-job abort sends cancel, rejects once, and ignores a late result", async () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    const promise = exportMovieMp4(input(), () => {}, controller.signal);
    const worker = await currentWorker();
    const request = worker.requests[0];
    assert.equal(request.type, "export");

    controller.abort(reason);
    await assert.rejects(promise, cause => cause === reason);
    assert.deepEqual(worker.requests[1], { type: "cancel", jobId: request.jobId });
    complete(worker);
    assert.equal(worker.terminated, false);
    worker.respond({
        type: "cancelled",
        jobId: request.jobId,
    } satisfies MovieMp4ExportWorkerResponse);
    assert.equal(worker.terminated, true);
});

test("structured worker errors preserve their stage", async () => {
    const promise = exportMovieMp4(input(), () => {});
    const worker = await currentWorker();
    const request = worker.requests[0];
    assert.equal(request.type, "export");
    worker.respond({
        type: "error",
        jobId: request.jobId,
        stage: "capability",
        message: "Fast MP4 unavailable",
    } satisfies MovieMp4ExportWorkerResponse);
    await assert.rejects(promise, (cause: unknown) => {
        assert.ok(cause instanceof MovieMp4ExportWorkerError);
        assert.equal(cause.stage, "capability");
        assert.equal(cause.message, "Fast MP4 unavailable");
        return true;
    });
});

test("worker error and messageerror reject with useful failures", async (context) => {
    await context.test("error", async () => {
        const promise = exportMovieMp4(input(), () => {});
        const worker = await currentWorker();
        worker.onerror?.({
            message: "worker exploded",
            filename: "movie-export.worker.js",
            lineno: 4,
            colno: 2,
            error: new Error("worker exploded"),
        } as ErrorEvent);
        await assert.rejects(promise, /worker exploded/);
        assert.equal(worker.terminated, true);
    });
    FakeWorker.instances.length = 0;
    await context.test("messageerror", async () => {
        const promise = exportMovieMp4(input(), () => {});
        const worker = await currentWorker();
        worker.onmessageerror?.({} as MessageEvent);
        await assert.rejects(promise, /could not be cloned/);
        assert.equal(worker.terminated, true);
    });
});

test("malformed and regressing responses fail closed", async (context) => {
    const invalidResponses: Array<[string, (worker: FakeWorker) => void]> = [
        ["out-of-range progress", worker => {
            const request = worker.requests[0];
            assert.equal(request.type, "export");
            worker.respond({ type: "progress", jobId: request.jobId, value: 2, stage: "bad" });
        }],
        ["non-finite progress", worker => {
            const request = worker.requests[0];
            assert.equal(request.type, "export");
            worker.respond({ type: "progress", jobId: request.jobId, value: NaN, stage: "bad" });
        }],
        ["empty result", worker => {
            const request = worker.requests[0];
            assert.equal(request.type, "export");
            worker.respond({
                type: "complete", jobId: request.jobId, buffer: new ArrayBuffer(0),
                mime: "video/mp4", encodedFrames: 1, duration: 1,
            });
        }],
    ];
    for (const [name, respond] of invalidResponses) {
        await context.test(name, async () => {
            FakeWorker.instances.length = 0;
            const promise = exportMovieMp4(input(), () => {});
            const worker = await currentWorker();
            respond(worker);
            await assert.rejects(promise, /malformed response/);
            assert.equal(worker.terminated, true);
        });
    }

    await context.test("regressing progress", async () => {
        FakeWorker.instances.length = 0;
        const promise = exportMovieMp4(input(), () => {});
        const worker = await currentWorker();
        const request = worker.requests[0];
        assert.equal(request.type, "export");
        worker.respond({
            type: "progress", jobId: request.jobId, value: 0.6, stage: "encode",
        });
        worker.respond({
            type: "progress", jobId: request.jobId, value: 0.5, stage: "encode",
        });
        await assert.rejects(promise, /regressing progress/);
        assert.equal(worker.terminated, true);
    });
});

test("source transfer never detaches the caller-owned source view", async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const source = backing.subarray(2, 5);
    const promise = exportMovieMp4(input(source), () => {});
    const worker = await currentWorker();
    const request = worker.requests[0];
    assert.equal(request.type, "export");
    assert.deepEqual([...new Uint8Array(request.fmv)], [2, 3, 4]);
    assert.equal(request.fmv.byteLength, 3);
    assert.equal(backing.buffer.byteLength, 6);
    assert.deepEqual([...source], [2, 3, 4]);
    complete(worker);
    await promise;
});
