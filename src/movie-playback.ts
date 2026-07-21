import {
    MovieDecoderCancelledError,
    MovieDecoderClient,
    type MovieDecoderSource,
} from "./movie-decoder-client.ts";
import type { DecoderReadyResponse } from "./movie-decoder-protocol.ts";
import { MovieFrameScheduler } from "./movie-scheduler.ts";
import { WebGlYuvRenderer } from "./movie-renderer.ts";
import type { MoviePlaybackSource } from "./movies.ts";
import type { SubtitleCue } from "./vendor/extract/index.ts";

export type MoviePlaybackState = "idle" | "initializing-decoder" | "priming"
    | "ready" | "playing" | "paused" | "seeking" | "buffering"
    | "ended" | "error" | "disposed";

export interface MoviePlaybackEvents {
    stateChanged(state: MoviePlaybackState): void;
    captionChanged(caption: string | null): void;
    error(cause: Error): void;
}

interface AttachTask {
    canvas: HTMLCanvasElement;
    promise: Promise<void>;
}

const NOOP_EVENTS: MoviePlaybackEvents = {
    stateChanged() {},
    captionChanged() {},
    error() {},
};
const CONTEXT_RESTORE_TIMEOUT_MS = 10_000;

const LIBAV_URL = new URL(
    `${import.meta.env.BASE_URL}${import.meta.env.DEV ? "public/" : ""}`
        + "libav/libav-6.9.8.1-ae3-mpeg2.mjs",
    location.href,
).href;

class PlaybackOperationCancelledError extends Error {
    constructor() {
        super("movie playback operation was cancelled");
        this.name = "PlaybackOperationCancelledError";
    }
}

export class MoviePlaybackSession {
    readonly #source: MoviePlaybackSource;
    readonly #events: MoviePlaybackEvents;
    readonly #decoder = new MovieDecoderClient();
    readonly #audio: HTMLAudioElement;
    readonly #wavUrl: string;
    #state: MoviePlaybackState = "idle";
    #caption: string | null = null;
    #captionsEnabled = true;
    #playIntent = false;
    #buffering = false;
    #error: Error | null = null;
    #decoderInfo: DecoderReadyResponse | null = null;
    #initializeDecoder: Promise<DecoderReadyResponse> | null = null;
    #audioReady: Promise<void> | null = null;
    #cancelAudioReady: (() => void) | null = null;
    #canvas: HTMLCanvasElement | null = null;
    #renderer: WebGlYuvRenderer | null = null;
    #scheduler: MovieFrameScheduler | null = null;
    #attachTask: AttachTask | null = null;
    #operation = 0;
    #contextRestoreTimer: number | null = null;
    #everReady = false;
    #disposed = false;
    #disposeTask: Promise<void> | null = null;

    constructor(source: MoviePlaybackSource, events: MoviePlaybackEvents = NOOP_EVENTS) {
        validateSource(source);
        this.#source = source;
        this.#events = events;
        this.#wavUrl = URL.createObjectURL(new Blob([copyBuffer(source.wav)], {
            type: "audio/wav",
        }));
        this.#audio = new Audio();
        this.#audio.preload = "auto";
        this.#audio.addEventListener("timeupdate", this.#handleAudioTimeUpdate);
        this.#audio.addEventListener("ended", this.#handleAudioEnded);
        this.#audio.addEventListener("error", this.#handleAudioError);
        this.#audio.src = this.#wavUrl;
        this.#audio.load();
    }

    get state(): MoviePlaybackState {
        return this.#state;
    }

    get name(): string {
        return this.#source.name;
    }

    get currentTime(): number {
        const time = this.#audio.currentTime;
        if (!Number.isFinite(time))
            return 0;
        return Math.min(Math.max(time, 0), this.#source.duration);
    }

    get duration(): number {
        return this.#source.duration;
    }

    get playing(): boolean {
        return this.#scheduler !== null && this.#playIntent;
    }

    get buffering(): boolean {
        return this.#buffering;
    }

    get caption(): string | null {
        return this.#caption;
    }

    get captionsEnabled(): boolean {
        return this.#captionsEnabled;
    }

    attach(canvas: HTMLCanvasElement): Promise<void> {
        this.#assertLive();
        if (this.#state === "error")
            return Promise.reject(this.#error ?? new Error("movie playback session is in error state"));
        if (this.#canvas === canvas) {
            if (this.#attachTask !== null && this.#attachTask.canvas === canvas)
                return this.#attachTask.promise;
            if (this.#scheduler !== null)
                return Promise.resolve();
        }

        const operation = ++this.#operation;
        const resumeAt = this.currentTime;
        this.#disposeVisuals();
        this.#audio.pause();
        this.#canvas = canvas;

        const task: AttachTask = {
            canvas,
            promise: this.#performAttach(canvas, resumeAt, operation),
        };
        task.promise = task.promise.finally(() => {
            if (this.#attachTask === task)
                this.#attachTask = null;
        });
        this.#attachTask = task;
        return task.promise;
    }

    detach(): void {
        if (this.#disposed)
            return;
        this.#operation++;
        this.#audio.pause();
        this.#disposeVisuals();
        this.#setBuffering(false);
        this.#updateCaption();
        if (this.#state !== "error")
            this.#setState(this.#decoderInfo === null && !this.#everReady ? "idle" : "paused");
    }

    async play(): Promise<void> {
        this.#assertLive();
        if (this.#state === "error")
            throw this.#error ?? new Error("movie playback session is in error state");
        this.#playIntent = true;
        if (this.#state === "ended" || this.currentTime >= this.duration) {
            await this.seek(0);
            return;
        }

        const scheduler = this.#scheduler;
        if (scheduler === null)
            return;
        try {
            await scheduler.play();
            if (this.#scheduler === scheduler && this.#playIntent && !this.#buffering)
                this.#setState("playing");
        } catch (cause) {
            const error = toError(cause);
            if (this.#scheduler !== scheduler || this.#disposed)
                throw error;
            this.#fail(error);
            throw error;
        }
    }

    pause(): void {
        if (this.#disposed)
            return;
        this.#playIntent = false;
        if (this.#scheduler !== null)
            this.#scheduler.pause();
        else
            this.#audio.pause();
        if (this.#state === "playing" || this.#state === "buffering" || this.#state === "ended") {
            this.#setBuffering(false);
            this.#setState("paused");
        }
        this.#updateCaption();
    }

    seek(seconds: number): Promise<void> {
        this.#assertLive();
        if (this.#state === "error")
            return Promise.reject(this.#error ?? new Error("movie playback session is in error state"));
        if (!Number.isFinite(seconds))
            return Promise.reject(new RangeError("movie seek time must be finite"));
        const target = Math.min(Math.max(seconds, 0), this.duration);
        const operation = ++this.#operation;
        return this.#performSeek(target, operation);
    }

    setCaptionsEnabled(enabled: boolean): void {
        if (this.#disposed)
            return;
        if (this.#captionsEnabled === enabled)
            return;
        this.#captionsEnabled = enabled;
        this.#updateCaption();
    }

    dispose(): Promise<void> {
        if (this.#disposeTask !== null)
            return this.#disposeTask;
        this.#disposed = true;
        this.#operation++;
        this.#playIntent = false;
        this.#audio.pause();
        this.#disposeVisuals();
        this.#setBuffering(false);
        this.#cancelAudioReady?.();
        this.#audio.removeEventListener("timeupdate", this.#handleAudioTimeUpdate);
        this.#audio.removeEventListener("ended", this.#handleAudioEnded);
        this.#audio.removeEventListener("error", this.#handleAudioError);
        this.#audio.removeAttribute("src");
        this.#audio.load();
        URL.revokeObjectURL(this.#wavUrl);
        this.#setCaption(null);
        this.#setState("disposed");

        this.#disposeTask = this.#decoder.dispose().catch(cause => {
            const error = toError(cause);
            this.#events.error(error);
            throw error;
        });
        return this.#disposeTask;
    }

    async #performAttach(canvas: HTMLCanvasElement, resumeAt: number,
                         operation: number): Promise<void> {
        try {
            const hadDecoder = this.#decoderInfo !== null;
            if (!hadDecoder)
                this.#setState("initializing-decoder");
            const [decoderInfo] = await Promise.all([
                this.#ensureDecoder(),
                this.#ensureAudioReady(),
            ]);
            this.#assertCurrent(operation);

            if (hadDecoder) {
                this.#setState("seeking");
                this.#audio.currentTime = resumeAt;
                await this.#decoder.seek(resumeAt);
                this.#assertCurrent(operation);
            }

            const renderer = this.#createRenderer(canvas, decoderInfo);
            this.#assertCurrent(operation);
            this.#renderer = renderer;
            const scheduler = this.#createScheduler(renderer);
            this.#scheduler = scheduler;
            this.#setBuffering(true);
            this.#setState("priming");
            await scheduler.prime();
            this.#assertCurrent(operation);
            if (this.#scheduler !== scheduler)
                throw new PlaybackOperationCancelledError();
            this.#setBuffering(false);
            this.#updateCaption();

            const firstReady = !this.#everReady;
            this.#everReady = true;
            if (renderer.contextLost) {
                scheduler.suspend();
                this.#setBuffering(true);
                this.#setState("buffering");
                return;
            }
            if (this.#playIntent) {
                await scheduler.play();
                this.#assertCurrent(operation);
                if (this.#scheduler === scheduler && !this.#buffering)
                    this.#setState("playing");
            } else {
                this.#setState(firstReady ? "ready" : "paused");
            }
        } catch (cause) {
            const error = toError(cause);
            if (!this.#isCurrent(operation)) {
                if (error instanceof PlaybackOperationCancelledError
                        || error instanceof MovieDecoderCancelledError)
                    return;
                throw error;
            }
            this.#disposeVisuals();
            this.#fail(error);
            throw error;
        }
    }

    async #performSeek(target: number, operation: number): Promise<void> {
        const renderer = this.#renderer;
        try {
            if (this.#scheduler !== null) {
                this.#scheduler.dispose();
                this.#scheduler = null;
            } else {
                this.#audio.pause();
            }
            this.#setBuffering(false);
            if (this.#decoderInfo === null)
                this.#setState("initializing-decoder");
            const [decoderInfo] = await Promise.all([
                this.#ensureDecoder(),
                this.#ensureAudioReady(),
            ]);
            this.#assertCurrent(operation);

            this.#setState("seeking");
            this.#audio.currentTime = target;
            const decoderTarget = Math.min(
                target,
                Math.max(0, this.duration - decoderInfo.frameDuration),
            );
            await this.#decoder.seek(decoderTarget);
            this.#assertCurrent(operation);
            this.#updateCaption();

            if (renderer === null || this.#renderer !== renderer || this.#canvas === null) {
                this.#setState("paused");
                return;
            }

            const scheduler = this.#createScheduler(renderer);
            this.#scheduler = scheduler;
            this.#setBuffering(true);
            this.#setState("priming");
            await scheduler.prime();
            this.#assertCurrent(operation);
            if (this.#scheduler !== scheduler)
                throw new PlaybackOperationCancelledError();
            this.#setBuffering(false);
            this.#updateCaption();

            if (target >= this.duration) {
                this.#playIntent = false;
                this.#setState("ended");
            } else if (renderer.contextLost) {
                scheduler.suspend();
                this.#setBuffering(true);
                this.#setState("buffering");
            } else if (this.#playIntent) {
                await scheduler.play();
                this.#assertCurrent(operation);
                if (this.#scheduler === scheduler && !this.#buffering)
                    this.#setState("playing");
            } else {
                this.#setState("paused");
            }
        } catch (cause) {
            const error = toError(cause);
            if (!this.#isCurrent(operation)) {
                if (error instanceof PlaybackOperationCancelledError
                        || error instanceof MovieDecoderCancelledError)
                    return;
                throw error;
            }
            this.#fail(error);
            throw error;
        }
    }

    #ensureDecoder(): Promise<DecoderReadyResponse> {
        if (this.#decoderInfo !== null)
            return Promise.resolve(this.#decoderInfo);
        if (this.#initializeDecoder !== null)
            return this.#initializeDecoder;

        const source: MovieDecoderSource = {
            libavUrl: LIBAV_URL,
            video: transferableBuffer(this.#source.video),
            width: this.#source.videoInfo.width,
            height: this.#source.videoInfo.height,
            fieldOrder: this.#source.videoInfo.fieldOrder,
            duration: this.duration,
            sourceFrames: this.#source.seekIndex.frames,
            seekPoints: this.#source.seekIndex.points,
        };
        const initialization = this.#decoder.initialize(source).then(info => {
            if (info.width !== this.#source.videoInfo.width
                    || info.height !== this.#source.videoInfo.height
                    || info.sourceFrames !== this.#source.seekIndex.frames)
                throw new Error("movie decoder initialized with unexpected source metadata");
            this.#decoderInfo = info;
            return info;
        });
        this.#initializeDecoder = initialization;
        return initialization;
    }

    #ensureAudioReady(): Promise<void> {
        if (this.#audio.readyState >= HTMLMediaElement.HAVE_METADATA)
            return Promise.resolve();
        if (this.#audio.error !== null)
            return Promise.reject(audioError(this.#audio.error));
        if (this.#audioReady !== null)
            return this.#audioReady;

        const ready = new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                this.#audio.removeEventListener("loadedmetadata", loaded);
                this.#audio.removeEventListener("error", failed);
                if (this.#cancelAudioReady === cancelled)
                    this.#cancelAudioReady = null;
            };
            const loaded = (): void => {
                cleanup();
                resolve();
            };
            const failed = (): void => {
                cleanup();
                reject(audioError(this.#audio.error));
            };
            const cancelled = (): void => {
                cleanup();
                reject(new PlaybackOperationCancelledError());
            };
            this.#cancelAudioReady = cancelled;
            this.#audio.addEventListener("loadedmetadata", loaded);
            this.#audio.addEventListener("error", failed);
        }).finally(() => {
            if (this.#audioReady === ready)
                this.#audioReady = null;
        });
        this.#audioReady = ready;
        return ready;
    }

    #createRenderer(canvas: HTMLCanvasElement,
                    info: DecoderReadyResponse): WebGlYuvRenderer {
        let renderer: WebGlYuvRenderer;
        renderer = new WebGlYuvRenderer(canvas, {
            contextLost: () => this.#rendererContextLost(renderer),
            contextRestored: () => this.#rendererContextRestored(renderer),
            contextError: cause => this.#rendererContextError(renderer, cause),
        });
        try {
            renderer.configure({
                width: info.width,
                height: info.height,
                label: this.#source.name.length === 0 ? "Movie playback" : this.#source.name,
            });
            return renderer;
        } catch (cause) {
            renderer.dispose();
            throw cause;
        }
    }

    #createScheduler(renderer: WebGlYuvRenderer): MovieFrameScheduler {
        const info = this.#decoderInfo;
        if (info === null)
            throw new Error("movie decoder is not initialized");
        let scheduler: MovieFrameScheduler;
        scheduler = new MovieFrameScheduler({
            source: this.#decoder,
            renderer,
            clock: this.#audio,
            events: {
                bufferingChanged: buffering => {
                    if (this.#scheduler === scheduler)
                        this.#schedulerBufferingChanged(buffering);
                },
                framePresented: () => {
                    if (this.#scheduler === scheduler)
                        this.#updateCaption();
                },
                ended: () => {
                    if (this.#scheduler === scheduler)
                        this.#schedulerEnded();
                },
                error: cause => {
                    if (this.#scheduler === scheduler)
                        this.#fail(cause);
                },
            },
            width: info.width,
            height: info.height,
            duration: this.duration,
            frameDuration: info.frameDuration,
        });
        return scheduler;
    }

    #rendererContextLost(renderer: WebGlYuvRenderer): void {
        if (this.#renderer !== renderer || this.#disposed)
            return;
        this.#clearContextRestoreTimer();
        this.#contextRestoreTimer = window.setTimeout(() => {
            this.#contextRestoreTimer = null;
            if (this.#renderer === renderer && renderer.contextLost) {
                this.#rendererContextError(renderer, new Error(
                    "Movie graphics did not recover. Re-prepare the movie or reload the page.",
                ));
            }
        }, CONTEXT_RESTORE_TIMEOUT_MS);
        this.#scheduler?.suspend();
        this.#setBuffering(true);
        this.#setState("buffering");
    }

    #rendererContextRestored(renderer: WebGlYuvRenderer): void {
        if (this.#renderer !== renderer || this.#disposed)
            return;
        this.#clearContextRestoreTimer();
        const scheduler = this.#scheduler;
        if (scheduler === null)
            return;
        scheduler.resume();
        if (!this.#playIntent && !scheduler.buffering) {
            this.#setBuffering(false);
            this.#setState("paused");
        }
    }

    #rendererContextError(renderer: WebGlYuvRenderer, cause: Error): void {
        if (this.#renderer !== renderer)
            return;
        this.#clearContextRestoreTimer();
        this.#fail(cause);
    }

    #schedulerBufferingChanged(buffering: boolean): void {
        this.#setBuffering(buffering);
        if (buffering) {
            if (this.#state !== "priming" && this.#state !== "seeking")
                this.#setState("buffering");
        } else if (this.#playIntent) {
            this.#setState("playing");
        } else if (this.#state === "buffering") {
            this.#setState("paused");
        }
    }

    #schedulerEnded(): void {
        this.#playIntent = false;
        this.#setBuffering(false);
        this.#updateCaption();
        this.#setState("ended");
    }

    #disposeVisuals(): void {
        this.#clearContextRestoreTimer();
        if (this.#scheduler !== null) {
            this.#scheduler.dispose();
            this.#scheduler = null;
        }
        if (this.#renderer !== null) {
            this.#renderer.dispose();
            this.#renderer = null;
        }
        this.#canvas = null;
    }

    #clearContextRestoreTimer(): void {
        if (this.#contextRestoreTimer === null)
            return;
        clearTimeout(this.#contextRestoreTimer);
        this.#contextRestoreTimer = null;
    }

    #updateCaption(): void {
        const caption = this.#captionsEnabled
            ? captionAt(this.#source.cues, this.currentTime)
            : null;
        this.#setCaption(caption);
    }

    #setCaption(caption: string | null): void {
        if (this.#caption === caption)
            return;
        this.#caption = caption;
        this.#events.captionChanged(caption);
    }

    #setBuffering(buffering: boolean): void {
        this.#buffering = buffering;
    }

    #setState(state: MoviePlaybackState): void {
        if (this.#state === state)
            return;
        this.#state = state;
        this.#events.stateChanged(state);
    }

    #fail(cause: Error): void {
        if (this.#disposed || this.#state === "error")
            return;
        this.#operation++;
        this.#playIntent = false;
        this.#error = cause;
        this.#cancelAudioReady?.();
        this.#decoder.terminate();
        this.#audio.pause();
        this.#disposeVisuals();
        this.#setBuffering(false);
        this.#setState("error");
        this.#events.error(cause);
    }

    #assertLive(): void {
        if (this.#disposed)
            throw new Error("movie playback session is disposed");
    }

    #assertCurrent(operation: number): void {
        if (!this.#isCurrent(operation))
            throw new PlaybackOperationCancelledError();
    }

    #isCurrent(operation: number): boolean {
        return !this.#disposed && operation === this.#operation;
    }

    #handleAudioTimeUpdate = (): void => {
        if (!this.#disposed)
            this.#updateCaption();
    };

    #handleAudioEnded = (): void => {
        if (this.#disposed)
            return;
        const tolerance = this.#decoderInfo?.frameDuration ?? 0.05;
        if (this.currentTime < this.duration - tolerance) {
            this.#fail(new Error(
                `Movie audio ended at ${this.currentTime.toFixed(2)}s, before `
                    + `${this.duration.toFixed(2)}s. Re-prepare the movie or reconnect the disc.`,
            ));
            return;
        }
        this.#schedulerEnded();
    };

    #handleAudioError = (): void => {
        if (!this.#disposed)
            this.#fail(audioError(this.#audio.error));
    };
}

function validateSource(source: MoviePlaybackSource): void {
    if (!Number.isFinite(source.duration) || source.duration <= 0)
        throw new Error("movie playback duration must be positive and finite");
    if (source.video.byteLength === 0)
        throw new Error("movie playback video is empty");
    if (source.wav.byteLength === 0)
        throw new Error("movie playback audio is empty");
    if (!Number.isSafeInteger(source.seekIndex.frames) || source.seekIndex.frames <= 0
            || source.seekIndex.points.length === 0)
        throw new Error("movie playback seek index is empty");
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.buffer instanceof ArrayBuffer
            && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
        return bytes.buffer;
    return copyBuffer(bytes);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function captionAt(cues: readonly SubtitleCue[], time: number): string | null {
    let low = 0;
    let high = cues.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (cues[middle].start <= time)
            low = middle + 1;
        else
            high = middle;
    }
    const cue = cues[low - 1];
    return cue !== undefined && time < cue.end ? cue.text : null;
}

function audioError(error: MediaError | null): Error {
    if (error === null)
        return new Error("movie audio failed to load or play");
    const message = error.message.length === 0
        ? `movie audio failed with media error ${error.code}`
        : error.message;
    return new Error(message);
}

function toError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
}
