import type { DecodedMovieFrame, DecoderEofResponse, DecoderFramesResponse } from "./movie-decoder-protocol.ts";
import { movieFrameByteLength } from "./movie-decoder-protocol.ts";
import type { MovieDecoderPullOptions } from "./movie-decoder-client.ts";
import type { MovieFrameRenderer } from "./movie-renderer.ts";

export interface MovieFrameSource {
    prime(options: MovieDecoderPullOptions): Promise<DecoderFramesResponse | DecoderEofResponse>;
    pull(options: MovieDecoderPullOptions): Promise<DecoderFramesResponse | DecoderEofResponse>;
}

export interface MoviePlaybackClock {
    currentTime: number;
    readonly paused: boolean;
    play(): Promise<void>;
    pause(): void;
}

export interface MovieSchedulerEvents {
    bufferingChanged(buffering: boolean): void;
    framePresented(frame: DecodedMovieFrame): void;
    ended(): void;
    error(cause: Error): void;
}

export interface MovieSchedulerOptions {
    source: MovieFrameSource;
    renderer: MovieFrameRenderer;
    clock: MoviePlaybackClock;
    events: MovieSchedulerEvents;
    width: number;
    height: number;
    duration: number;
    frameDuration: number;
}

const HIGH_WATER_SECONDS = 0.75;
const LOW_WATER_SECONDS = 0.25;
const RESPONSE_FRAMES = 8;

export class MovieFrameScheduler {
    readonly #source: MovieFrameSource;
    readonly #renderer: MovieFrameRenderer;
    readonly #clock: MoviePlaybackClock;
    readonly #events: MovieSchedulerEvents;
    readonly #duration: number;
    readonly #frameDuration: number;
    readonly #frameBytes: number;
    #queue: DecodedMovieFrame[] = [];
    #animationFrame = 0;
    #fill: Promise<void> | null = null;
    #version = 0;
    #lastFrame = -1;
    #playingIntent = false;
    #playVersion = 0;
    #clockPlay: { promise: Promise<void>; version: number } | null = null;
    #buffering = false;
    #eof = false;
    #ended = false;
    #suspended = false;
    #disposed = false;
    #error: Error | null = null;

    constructor(options: MovieSchedulerOptions) {
        if (!Number.isFinite(options.duration) || options.duration <= 0
                || !Number.isFinite(options.frameDuration) || options.frameDuration <= 0)
            throw new Error("invalid movie scheduler timing");
        this.#source = options.source;
        this.#renderer = options.renderer;
        this.#clock = options.clock;
        this.#events = options.events;
        this.#duration = options.duration;
        this.#frameDuration = options.frameDuration;
        this.#frameBytes = movieFrameByteLength(options.width, options.height);
        this.#animationFrame = requestAnimationFrame(this.#tick);
    }

    get queuedFrames(): number {
        return this.#queue.length;
    }

    get queueSeconds(): number {
        return Math.max(0, this.#queueEnd() - this.#clock.currentTime);
    }

    get buffering(): boolean {
        return this.#buffering;
    }

    async prime(): Promise<void> {
        this.#assertLive();
        await this.#ensureBuffered();
        this.#throwIfFailed();
        this.#present(this.#clock.currentTime);
    }

    async play(): Promise<void> {
        this.#assertLive();
        const playVersion = ++this.#playVersion;
        this.#playingIntent = true;
        if (this.#suspended)
            return;
        await this.#ensureBuffered();
        this.#throwIfFailed();
        if (!this.#isCurrentPlay(playVersion))
            return;
        if (!this.#clock.paused && this.#clockPlay?.version !== playVersion)
            return;
        await this.#playClock(playVersion);
    }

    pause(): void {
        this.#playingIntent = false;
        this.#playVersion++;
        this.#clock.pause();
    }

    async resetAfterSeek(): Promise<void> {
        this.#assertLive();
        this.#version++;
        this.#fill = null;
        this.#queue.length = 0;
        this.#lastFrame = -1;
        this.#eof = false;
        this.#ended = false;
        this.#setBuffering(true);
        this.#renderer.clear();
        await this.#ensureBuffered();
        this.#throwIfFailed();
        this.#present(this.#clock.currentTime);
    }

    suspend(): void {
        if (this.#suspended)
            return;
        this.#suspended = true;
        this.#playVersion++;
        this.#clock.pause();
        this.#setBuffering(true);
    }

    resume(): void {
        if (!this.#suspended)
            return;
        this.#suspended = false;
        void this.#ensureBuffered();
    }

    dispose(): void {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#version++;
        this.#playingIntent = false;
        this.#playVersion++;
        this.#clock.pause();
        cancelAnimationFrame(this.#animationFrame);
        this.#queue.length = 0;
        this.#fill = null;
    }

    #tick = (): void => {
        if (this.#disposed)
            return;
        try {
            if (!this.#suspended) {
                const time = Math.min(this.#clock.currentTime, this.#duration);
                this.#present(time);
                const ahead = this.#queueEnd() - time;
                if (!this.#eof && ahead < LOW_WATER_SECONDS)
                    void this.#ensureBuffered();
                if (this.#playingIntent && !this.#clock.paused && !this.#eof
                        && ahead <= this.#frameDuration / 2) {
                    this.#playVersion++;
                    this.#clock.pause();
                    this.#setBuffering(true);
                    void this.#ensureBuffered();
                }
                if (!this.#ended && this.#eof && time >= this.#duration) {
                    this.#ended = true;
                    this.#playingIntent = false;
                    this.#playVersion++;
                    this.#clock.pause();
                    this.#events.ended();
                }
            }
        } catch (cause) {
            this.#fail(cause);
            return;
        }
        this.#animationFrame = requestAnimationFrame(this.#tick);
    };

    #present(time: number): void {
        const presentAt = time + this.#frameDuration / 2;
        while (this.#queue.length > 1 && this.#queue[1].timestamp <= presentAt)
            this.#queue.shift();
        const frame = this.#queue[0];
        if (frame === undefined || frame.timestamp > presentAt || frame.index === this.#lastFrame)
            return;
        this.#renderer.render(frame);
        this.#lastFrame = frame.index;
        this.#events.framePresented(frame);
    }

    #ensureBuffered(): Promise<void> {
        if (this.#fill !== null)
            return this.#fill;
        const version = this.#version;
        const run = this.#fillTo(version, HIGH_WATER_SECONDS).catch(cause => {
            if (!this.#disposed && version === this.#version)
                this.#fail(cause);
        }).finally(() => {
            if (this.#fill === run)
                this.#fill = null;
        });
        this.#fill = run;
        return run;
    }

    async #fillTo(version: number, targetAhead: number): Promise<void> {
        let firstRequest = this.#queue.length === 0;
        while (!this.#eof && version === this.#version && !this.#disposed) {
            const clockTime = Math.min(this.#clock.currentTime, this.#duration);
            const untilTimestamp = Math.min(clockTime + targetAhead, this.#duration);
            if (this.#queueEnd() >= untilTimestamp - this.#frameDuration / 2)
                break;
            const request = {
                untilTimestamp,
                maxFrames: RESPONSE_FRAMES,
                maxBytes: this.#frameBytes * RESPONSE_FRAMES,
            };
            const response = firstRequest
                ? await this.#source.prime(request)
                : await this.#source.pull(request);
            firstRequest = false;
            if (version !== this.#version || this.#disposed)
                return;
            if (response.type === "eof") {
                this.#eof = true;
                break;
            }
            this.#append(response.frames);
            this.#eof = response.eof;
            if (response.frames.length === 0)
                throw new Error("movie decoder returned no frames before EOF");
        }
        if (version !== this.#version || this.#disposed || this.#suspended)
            return;
        const restored = this.#eof || this.#queueEnd() - this.#clock.currentTime >= LOW_WATER_SECONDS;
        if (!restored)
            return;
        this.#setBuffering(false);
        if (this.#playingIntent && this.#clock.paused) {
            const playVersion = this.#playVersion;
            void this.#playClock(playVersion).catch(cause => {
                if (!this.#disposed)
                    this.#fail(cause);
            });
        }
    }

    #append(frames: readonly DecodedMovieFrame[]): void {
        let prior = this.#queue.at(-1)?.timestamp ?? -Infinity;
        for (const frame of frames) {
            if (frame.timestamp <= prior)
                throw new Error("movie decoder returned non-monotonic frames");
            this.#queue.push(frame);
            prior = frame.timestamp;
        }
    }

    #queueEnd(): number {
        const last = this.#queue.at(-1);
        return last === undefined ? this.#clock.currentTime : last.timestamp + last.duration;
    }

    #setBuffering(buffering: boolean): void {
        if (this.#buffering === buffering)
            return;
        this.#buffering = buffering;
        this.#events.bufferingChanged(buffering);
    }

    #playClock(playVersion: number): Promise<void> {
        const current = this.#clockPlay;
        if (current?.version === playVersion)
            return current.promise;
        const promise = this.#runClockPlay(playVersion).finally(() => {
            if (this.#clockPlay?.promise === promise)
                this.#clockPlay = null;
        });
        this.#clockPlay = { promise, version: playVersion };
        return promise;
    }

    async #runClockPlay(playVersion: number): Promise<void> {
        try {
            await this.#clock.play();
        } catch (cause) {
            if (cause instanceof Error && cause.name === "AbortError"
                    && !this.#isCurrentPlay(playVersion))
                return;
            throw cause;
        }
    }

    #isCurrentPlay(playVersion: number): boolean {
        return !this.#disposed && !this.#suspended && this.#playingIntent
            && playVersion === this.#playVersion;
    }

    #fail(cause: unknown): void {
        if (this.#disposed || this.#error !== null)
            return;
        this.#error = cause instanceof Error ? cause : new Error(String(cause));
        this.#playingIntent = false;
        this.#playVersion++;
        this.#clock.pause();
        cancelAnimationFrame(this.#animationFrame);
        this.#events.error(this.#error);
    }

    #throwIfFailed(): void {
        if (this.#error !== null)
            throw this.#error;
    }

    #assertLive(): void {
        if (this.#disposed)
            throw new Error("movie scheduler is disposed");
    }
}

