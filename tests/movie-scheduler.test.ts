import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import type { MovieDecoderPullOptions } from "../src/movie-decoder-client.ts";
import type {
    DecodedMovieFrame,
    DecoderEofResponse,
    DecoderFramesResponse,
    MovieDecoderStats,
} from "../src/movie-decoder-protocol.ts";
import type { MovieFrameRenderer } from "../src/movie-renderer.ts";
import {
    MovieFrameScheduler,
    type MovieFrameSource,
    type MoviePlaybackClock,
    type MovieSchedulerEvents,
} from "../src/movie-scheduler.ts";

type SourceResponse = DecoderFramesResponse | DecoderEofResponse;
type QueuedResponse = SourceResponse | Promise<SourceResponse>;

const FRAME_DURATION = 0.1;
const FRAME_BYTES = 6;
const EMPTY_STATS: MovieDecoderStats = {
    packets: 0,
    decodedFrames: 0,
    outputFrames: 0,
    droppedFrames: 0,
    decodeWallTime: 0,
    pendingBytes: 0,
    wasmBytes: 0,
};

class FakeAnimationFrames {
    #nextId = 1;
    #callbacks = new Map<number, (time: number) => void>();

    readonly request = (callback: (time: number) => void): number => {
        const id = this.#nextId++;
        this.#callbacks.set(id, callback);
        return id;
    };

    readonly cancel = (id: number): void => {
        this.#callbacks.delete(id);
    };

    get pending(): number {
        return this.#callbacks.size;
    }

    flush(time = 0): void {
        const callbacks = [...this.#callbacks.values()];
        this.#callbacks.clear();
        for (const callback of callbacks)
            callback(time);
    }
}

class FakeMovieFrameSource implements MovieFrameSource {
    readonly requests: Array<{ kind: "prime" | "pull"; options: MovieDecoderPullOptions }> = [];
    #responses: QueuedResponse[];
    activeRequests = 0;
    maxActiveRequests = 0;

    constructor(responses: QueuedResponse[]) {
        this.#responses = [...responses];
    }

    prime(options: MovieDecoderPullOptions): Promise<SourceResponse> {
        return this.#respond("prime", options);
    }

    pull(options: MovieDecoderPullOptions): Promise<SourceResponse> {
        return this.#respond("pull", options);
    }

    async #respond(kind: "prime" | "pull", options: MovieDecoderPullOptions): Promise<SourceResponse> {
        this.requests.push({ kind, options: { ...options } });
        const response = this.#responses.shift();
        if (response === undefined)
            throw new Error(`unexpected ${kind} request`);
        this.activeRequests++;
        this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
        try {
            return await response;
        } finally {
            this.activeRequests--;
        }
    }
}

class FakeMovieFrameRenderer implements MovieFrameRenderer {
    readonly rendered: DecodedMovieFrame[] = [];
    clearCalls = 0;
    disposeCalls = 0;
    renderError: Error | null = null;

    configure(): void {}

    render(frame: DecodedMovieFrame): void {
        if (this.renderError !== null)
            throw this.renderError;
        this.rendered.push(frame);
    }

    clear(): void {
        this.clearCalls++;
    }

    dispose(): void {
        this.disposeCalls++;
    }
}

class FakeMovieClock implements MoviePlaybackClock {
    currentTime = 0;
    paused = true;
    playCalls = 0;
    pauseCalls = 0;

    playResult: Promise<void> | null = null;
    async play(): Promise<void> {
        this.playCalls++;
        this.paused = false;
        const result = this.playResult;
        this.playResult = null;
        if (result !== null)
            await result;
    }

    pause(): void {
        this.pauseCalls++;
        this.paused = true;
    }
}

class FakeSchedulerEvents implements MovieSchedulerEvents {
    readonly buffering: boolean[] = [];
    readonly presented: DecodedMovieFrame[] = [];
    readonly errors: Error[] = [];
    endedCalls = 0;

    bufferingChanged(buffering: boolean): void {
        this.buffering.push(buffering);
    }

    framePresented(frame: DecodedMovieFrame): void {
        this.presented.push(frame);
    }

    ended(): void {
        this.endedCalls++;
    }

    error(cause: Error): void {
        this.errors.push(cause);
    }
}

interface Harness {
    scheduler: MovieFrameScheduler;
    source: FakeMovieFrameSource;
    renderer: FakeMovieFrameRenderer;
    clock: FakeMovieClock;
    events: FakeSchedulerEvents;
}

const activeSchedulers = new Set<MovieFrameScheduler>();
const activeSources = new Set<FakeMovieFrameSource>();

function createHarness(responses: QueuedResponse[], duration = 4): Harness {
    const source = new FakeMovieFrameSource(responses);
    const renderer = new FakeMovieFrameRenderer();
    const clock = new FakeMovieClock();
    const events = new FakeSchedulerEvents();
    const scheduler = new MovieFrameScheduler({
        source,
        renderer,
        clock,
        events,
        width: 2,
        height: 2,
        duration,
        frameDuration: FRAME_DURATION,
    });
    activeSchedulers.add(scheduler);
    activeSources.add(source);
    return { scheduler, source, renderer, clock, events };
}

function frame(index: number, timestamp = index * FRAME_DURATION): DecodedMovieFrame {
    return {
        index,
        timestamp,
        duration: FRAME_DURATION,
        width: 2,
        height: 2,
        format: "I420",
        data: new ArrayBuffer(FRAME_BYTES),
        layout: [
            { offset: 0, stride: 2 },
            { offset: 4, stride: 1 },
            { offset: 5, stride: 1 },
        ],
    };
}

function frames(startIndex: number, count: number, startTimestamp = startIndex * FRAME_DURATION): DecodedMovieFrame[] {
    return Array.from({ length: count }, (_, offset) =>
        frame(startIndex + offset, startTimestamp + offset * FRAME_DURATION));
}

function framesResponse(value: DecodedMovieFrame[], eof = false): DecoderFramesResponse {
    return {
        type: "frames",
        requestId: 1,
        generation: 1,
        frames: value,
        eof,
        stats: EMPTY_STATS,
    };
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolvePromise: (value: T) => void = () => {};
    let rejectPromise: (cause: unknown) => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function drainAsyncWork(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

const animationFrames = new FakeAnimationFrames();
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
globalThis.requestAnimationFrame = animationFrames.request;
globalThis.cancelAnimationFrame = animationFrames.cancel;

afterEach(() => {
    for (const scheduler of activeSchedulers)
        scheduler.dispose();
    for (const source of activeSources)
        assert.equal(source.activeRequests, 0, "each fake source must finish its pending work");
    activeSchedulers.clear();
    activeSources.clear();
    assert.equal(animationFrames.pending, 0, "each scheduler must cancel its animation frame");
});

after(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

test("bounds decoder requests and applies backpressure while a refill is in flight", async t => {
    const refill = deferred<SourceResponse>();
    const harness = createHarness([
        framesResponse(frames(0, 8)),
        refill.promise,
    ]);
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();

    assert.equal(harness.scheduler.queuedFrames, 8);
    assert.equal(harness.scheduler.queueSeconds, 0.8);
    assert.deepEqual(harness.source.requests, [{
        kind: "prime",
        options: { untilTimestamp: 0.75, maxFrames: 8, maxBytes: FRAME_BYTES * 8 },
    }]);

    harness.clock.currentTime = 0.4;
    animationFrames.flush();
    await drainAsyncWork();
    assert.equal(harness.source.requests.length, 1, "the queue above its low-water mark must not refill");

    harness.clock.currentTime = 0.6;
    animationFrames.flush();
    animationFrames.flush();
    assert.equal(harness.source.requests.length, 2, "ticks must share the in-flight refill");
    assert.equal(harness.source.activeRequests, 1);
    assert.equal(harness.source.maxActiveRequests, 1);
    assert.deepEqual(harness.source.requests[1], {
        kind: "pull",
        options: { untilTimestamp: 1.35, maxFrames: 8, maxBytes: FRAME_BYTES * 8 },
    });

    refill.resolve(framesResponse(frames(8, 6)));
    await drainAsyncWork();

    assert.equal(harness.source.activeRequests, 0);
    assert.equal(harness.source.requests.length, 2);
    assert.ok(harness.scheduler.queueSeconds <= 0.8 + 1e-12,
        "refill must stop at the bounded high-water window");
});

test("presents monotonically and drops obsolete frames when the clock jumps", async t => {
    const harness = createHarness([framesResponse(frames(0, 8))]);
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    assert.deepEqual(harness.renderer.rendered.map(value => value.index), [0]);

    harness.clock.currentTime = 0.36;
    animationFrames.flush();
    harness.clock.currentTime = 0.21;
    animationFrames.flush();
    harness.clock.currentTime = 0.51;
    animationFrames.flush();

    assert.deepEqual(harness.renderer.rendered.map(value => value.index), [0, 4, 5]);
    assert.deepEqual(harness.events.presented.map(value => value.index), [0, 4, 5]);
    assert.ok(harness.events.presented.every((value, index, all) =>
        index === 0 || value.timestamp > all[index - 1].timestamp));
});

test("rejects non-monotonic decoder output without presenting it", async t => {
    const harness = createHarness([
        framesResponse([frame(1, 0.1), frame(0, 0)]),
    ]);
    t.after(() => harness.scheduler.dispose());

    await assert.rejects(harness.scheduler.prime(), /non-monotonic frames/);
    assert.equal(harness.renderer.rendered.length, 0);
    assert.equal(harness.events.errors.length, 1);
});

test("buffers on underrun and resumes playback after the queue recovers", async t => {
    const refill = deferred<SourceResponse>();
    const harness = createHarness([
        framesResponse(frames(0, 8)),
        refill.promise,
    ]);
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    await harness.scheduler.play();
    assert.equal(harness.clock.playCalls, 1);
    assert.equal(harness.clock.paused, false);

    harness.clock.currentTime = 0.76;
    animationFrames.flush();

    assert.equal(harness.clock.paused, true);
    assert.equal(harness.clock.pauseCalls, 1);
    assert.equal(harness.scheduler.buffering, true);
    assert.deepEqual(harness.events.buffering, [true]);
    assert.equal(harness.source.activeRequests, 1);

    refill.resolve(framesResponse(frames(8, 8)));
    await drainAsyncWork();

    assert.equal(harness.scheduler.buffering, false);
    assert.deepEqual(harness.events.buffering, [true, false]);
    assert.equal(harness.clock.playCalls, 2);
    assert.equal(harness.clock.paused, false);
});

test("ignores an old generation that resolves after seek reset", async t => {
    const oldGeneration = deferred<SourceResponse>();
    const harness = createHarness([
        oldGeneration.promise,
        framesResponse(frames(20, 8, 2)),
    ]);
    t.after(() => harness.scheduler.dispose());

    const oldPrime = harness.scheduler.prime();
    harness.clock.currentTime = 2;
    await harness.scheduler.resetAfterSeek();

    assert.equal(harness.source.maxActiveRequests, 2);
    assert.deepEqual(harness.source.requests.map(request => request.kind), ["prime", "prime"]);
    assert.equal(harness.renderer.clearCalls, 1);
    assert.deepEqual(harness.renderer.rendered.map(value => value.index), [20]);
    assert.equal(harness.scheduler.queuedFrames, 8);

    oldGeneration.resolve(framesResponse(frames(0, 8)));
    await oldPrime;

    assert.deepEqual(harness.renderer.rendered.map(value => value.index), [20]);
    assert.deepEqual(harness.events.presented.map(value => value.index), [20]);
    assert.equal(harness.scheduler.queuedFrames, 8);
    assert.equal(harness.events.errors.length, 0);
});

test("pauses audio and reports a renderer failure from the animation-frame path", async t => {
    const harness = createHarness([framesResponse(frames(0, 8))]);
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    await harness.scheduler.play();
    const failure = new Error("render failed");
    harness.renderer.renderError = failure;
    harness.clock.currentTime = 0.1;
    animationFrames.flush();

    assert.equal(harness.clock.paused, true);
    assert.deepEqual(harness.events.errors, [failure]);
    assert.equal(animationFrames.pending, 0);
});

test("emits ended once at the exact final-frame boundary", async t => {
    const harness = createHarness([
        framesResponse(frames(0, 10), true),
    ], 1);
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    await harness.scheduler.play();

    harness.clock.currentTime = 1 - Number.EPSILON;
    animationFrames.flush();
    assert.equal(harness.events.endedCalls, 0);

    harness.clock.currentTime = 1;
    animationFrames.flush();
    assert.equal(harness.events.endedCalls, 1);
    assert.equal(harness.clock.paused, true);

    harness.clock.currentTime = 1.5;
    animationFrames.flush();
    assert.equal(harness.events.endedCalls, 1);
    assert.equal(harness.clock.playCalls, 1);
});

test("suppresses AbortError when pause cancels an in-flight play", async t => {
    const harness = createHarness([framesResponse(frames(0, 8))]);
    const pendingPlay = deferred<void>();
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    harness.clock.playResult = pendingPlay.promise;
    const playing = harness.scheduler.play();
    await drainAsyncWork();
    assert.equal(harness.clock.playCalls, 1);

    harness.scheduler.pause();
    pendingPlay.reject(new DOMException("play interrupted by pause", "AbortError"));

    await playing;
    assert.equal(harness.events.errors.length, 0);
    assert.equal(harness.clock.paused, true);
});

test("keeps a newer play live when an older cancelled play rejects", async t => {
    const harness = createHarness([framesResponse(frames(0, 8))]);
    const oldPlay = deferred<void>();
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    harness.clock.playResult = oldPlay.promise;
    const stalePlaying = harness.scheduler.play();
    await drainAsyncWork();

    harness.scheduler.pause();
    const currentPlaying = harness.scheduler.play();
    oldPlay.reject(new DOMException("old play interrupted by pause", "AbortError"));

    await Promise.all([stalePlaying, currentPlaying]);
    assert.equal(harness.clock.playCalls, 2);
    assert.equal(harness.clock.paused, false);
    assert.equal(harness.events.errors.length, 0);
});

test("does not suppress non-AbortError after play is cancelled", async t => {
    const harness = createHarness([framesResponse(frames(0, 8))]);
    const pendingPlay = deferred<void>();
    const notAllowed = new DOMException("autoplay denied", "NotAllowedError");
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    harness.clock.playResult = pendingPlay.promise;
    const playing = harness.scheduler.play();
    await drainAsyncWork();

    harness.scheduler.pause();
    pendingPlay.reject(notAllowed);

    await assert.rejects(playing, cause => cause === notAllowed);
});

test("rejects AbortError while the corresponding play intent remains live", async t => {
    const harness = createHarness([framesResponse(frames(0, 8))]);
    const pendingPlay = deferred<void>();
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    harness.clock.playResult = pendingPlay.promise;
    const playing = harness.scheduler.play();
    await drainAsyncWork();
    assert.equal(harness.clock.playCalls, 1);

    pendingPlay.reject(new DOMException("audio playback failed", "AbortError"));

    await assert.rejects(playing, cause =>
        cause instanceof DOMException && cause.name === "AbortError");
});

test("suppresses AbortError when pause cancels auto-resume after refill", async t => {
    const refill = deferred<SourceResponse>();
    const pendingResume = deferred<void>();
    const harness = createHarness([
        framesResponse(frames(0, 8)),
        refill.promise,
    ]);
    t.after(() => harness.scheduler.dispose());

    await harness.scheduler.prime();
    await harness.scheduler.play();
    harness.clock.currentTime = 0.76;
    animationFrames.flush();
    harness.clock.playResult = pendingResume.promise;

    refill.resolve(framesResponse(frames(8, 8)));
    await drainAsyncWork();
    assert.equal(harness.clock.playCalls, 2);

    harness.scheduler.pause();
    pendingResume.reject(new DOMException("resume interrupted by pause", "AbortError"));
    await drainAsyncWork();

    assert.equal(harness.events.errors.length, 0);
    assert.equal(harness.clock.paused, true);
});

test("disposes idempotently and suppresses pending decode work", async () => {
    const pending = deferred<SourceResponse>();
    const harness = createHarness([pending.promise]);
    const priming = harness.scheduler.prime();

    assert.equal(animationFrames.pending, 1);
    assert.equal(harness.source.activeRequests, 1);

    harness.scheduler.dispose();
    harness.scheduler.dispose();

    assert.equal(animationFrames.pending, 0);
    assert.equal(harness.clock.pauseCalls, 1);
    assert.equal(harness.scheduler.queuedFrames, 0);

    pending.resolve(framesResponse(frames(0, 8)));
    await priming;

    assert.equal(harness.source.activeRequests, 0);
    assert.equal(harness.renderer.rendered.length, 0);
    assert.equal(harness.events.presented.length, 0);
    assert.equal(harness.events.errors.length, 0);
    await assert.rejects(harness.scheduler.prime(), /scheduler is disposed/);
    await assert.rejects(harness.scheduler.play(), /scheduler is disposed/);
    await assert.rejects(harness.scheduler.resetAfterSeek(), /scheduler is disposed/);
});
