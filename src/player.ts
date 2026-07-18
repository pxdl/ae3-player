/* Main-thread controller for the AudioWorklet synth.
 *
 * Owns the AudioContext (48 kHz -- the core renders only on the SPU2 clock;
 * the browser resamples to the device), compiles ae3synth.wasm ONCE and posts
 * the Module into the worklet, then speaks the engine.mjs message protocol.
 *
 * The playhead the UI shows is aligned to what is HEARD: each snapshot is
 * stamped with the worklet's currentFrame, and heardPos() rebases it onto the
 * context clock minus output latency (WEB_PORT_PLAN §1). */

import type { DisplayClock } from "./timeline.ts";

export const RATE = 48000;

export interface Snapshot {
    pos: number;               /* absolute samples rendered */
    ctxFrame: number;          /* worklet currentFrame at snapshot */
    clock: DisplayClock;
    voices: Int32Array;        /* [flags,ch,key,env] x 48 */
    peakL: number;
    peakR: number;
    playing: boolean;
    seeking: boolean;
    done: boolean;
}

export interface SongAssets {
    hd: Uint8Array; bd: Uint8Array; mid: Uint8Array;
    irx: Uint8Array | null; libsd: Uint8Array | null;
}

export interface EngineConfig {
    songvol: number; revDepth: number;
    exact: boolean; gaussian: boolean; loop: number;
}

export interface LoadResult { ppqn: number; events: Uint32Array; warning: string; }

const base = import.meta.env.BASE_URL;

export class WorkletPlayer {
    readonly ctx: AudioContext;
    private readonly node: AudioWorkletNode;
    snap: Snapshot | null = null;
    onsnapshot: ((s: Snapshot) => void) | null = null;
    onended: (() => void) | null = null;
    onerror: ((msg: string) => void) | null = null;
    private pendingLoad: { resolve: (r: LoadResult) => void;
                           reject: (e: Error) => void } | null = null;

    private constructor(ctx: AudioContext, node: AudioWorkletNode) {
        this.ctx = ctx;
        this.node = node;
        node.port.onmessage = (e) => { this.dispatch(e.data); };
        node.port.onmessageerror = () =>
            this.onerror?.("worklet message failed to deserialize");
        node.onprocessorerror = () =>
            this.onerror?.("audio worklet crashed (processorerror)");
    }

    /* NOTE: no handshake here. While the context is suspended (autoplay
     * policy) Chrome does not run the worklet at all -- port messages queue
     * and the processor replies only once rendering starts -- so awaiting a
     * 'ready' before the first user gesture deadlocks. Messages are ordered,
     * so init/load/play queue correctly; resume() must be called from a
     * gesture handler (see resume()). */
    static async create(): Promise<WorkletPlayer> {
        const ctx = new AudioContext({ sampleRate: RATE });
        await ctx.audioWorklet.addModule(`${base}synth/worklet.mjs`);
        /* raw bytes, compiled inside the worklet: Chrome silently drops a
         * postMessage'd WebAssembly.Module bound for an AudioWorklet */
        const bytes = await (await fetch(`${base}synth/ae3synth.wasm`)).arrayBuffer();
        const node = new AudioWorkletNode(ctx, "ae3-player",
            { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(ctx.destination);
        const p = new WorkletPlayer(ctx, node);
        node.port.postMessage({ t: "init", module: bytes }, [bytes]);
        return p;
    }

    /** Unlock audio. MUST be called synchronously from a user-gesture handler
     *  the first time -- a resume() issued outside one just stays pending. */
    resume(): void {
        if (this.ctx.state === "suspended") void this.ctx.resume();
    }

    private dispatch(m: any): void {
        switch (m.t) {
        case "ready":
            break;                      /* informational */
        case "loaded":
            this.pendingLoad?.resolve(
                { ppqn: m.ppqn, events: m.events, warning: m.warning });
            this.pendingLoad = null;
            break;
        case "snapshot":
            this.snap = m as Snapshot;
            this.onsnapshot?.(this.snap);
            break;
        case "ended":
            this.onended?.();
            break;
        case "error":
            if (this.pendingLoad) {
                this.pendingLoad.reject(new Error(m.message));
                this.pendingLoad = null;
            } else {
                this.onerror?.(m.message);
            }
            break;
        }
    }

    /** Load a song into the worklet synth (buffers are transferred). */
    load(assets: SongAssets, config: EngineConfig): Promise<LoadResult> {
        return new Promise((resolve, reject) => {
            this.pendingLoad = { resolve, reject };
            const bufs = [assets.hd, assets.bd, assets.mid,
                          assets.irx, assets.libsd];
            this.node.port.postMessage({
                t: "load", config,
                hd: assets.hd, bd: assets.bd, mid: assets.mid,
                irx: assets.irx, libsd: assets.libsd,
            }, bufs.filter((b) => b !== null).map((b) => b!.buffer));
        });
    }

    play(): void {
        this.resume();
        this.node.port.postMessage({ t: "play" });
        if (this.snap) this.snap.playing = true;   /* until the next snapshot */
    }

    pause(): void {
        this.node.port.postMessage({ t: "pause" });
        if (this.snap) this.snap.playing = false;
    }

    seek(sample: number): void {
        this.node.port.postMessage({ t: "seek", sample });
    }

    set(key: keyof EngineConfig, value: number | boolean): void {
        this.node.port.postMessage({ t: "set", key, value });
    }

    /** Latency-compensated absolute sample position -- what the speaker is
     *  playing NOW. While paused or seeking the raw position is truthful. */
    heardPos(): number {
        const s = this.snap;
        if (!s) return 0;
        if (!s.playing || s.seeking) return s.pos;
        const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        const speakerFrame = (this.ctx.currentTime - lat) * RATE;
        const p = s.pos - s.ctxFrame + speakerFrame;
        return Math.min(Math.max(p, 0), s.pos);
    }
}
