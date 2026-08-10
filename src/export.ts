/* Export UI glue: bgmplay's dropdown actions (current settings / authored
 * original / loop xN) through the export Worker, finished WAV delivered as a
 * download. Mirrors export_wav's command construction: the pitch irx goes in
 * whenever present, libsd + rev depth only when the depth is nonzero. One
 * export at a time (bgmplay's exporting flag). */

import type { SeAssets, SongAssets } from "./player.ts";
import { RATE } from "./timeline.ts";
import { storeZip } from "./zip.ts";
import { technicalReason } from "./errors.ts";

export interface ExportOpts {
    songvol: number;
    revDepth: number;
    exact: boolean;
    bright: boolean;
    loop: number;               /* 0 = single pass; N>=2 = wavdump --loop N */
}

export interface SeExportOpts {
    volume: number;
    revDepth: number;
    exact: boolean;
    bright: boolean;
    bank: number;
    request: number;
    seconds: number;
    loop: boolean;
}

const base = import.meta.env?.BASE_URL ?? "/";

/** Deliver `bytes` to the user as a file download. */
export function download(bytes: Uint8Array | ArrayBuffer | Blob, file: string,
                         type: string): void {
    /* BlobPart wants ArrayBuffer-backed views; ours always are (OPFS reads,
     * worker transfers) -- TS just can't see it through Uint8Array's default
     * ArrayBufferLike parameter. Large archive exporters pass a Blob directly
     * to avoid copying the complete archive into another contiguous buffer. */
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : null;
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): boolean {
    return Object.keys(value).every(key => allowed.has(key));
}

const PROGRESS_KEYS = new Set(["t", "frames"]);
const DONE_KEYS = new Set(["t", "wav", "frames"]);
const ERROR_KEYS = new Set(["t", "id", "message"]);
const KIT_DONE_KEYS = new Set(["t", "entries"]);
const KIT_ENTRY_KEYS = new Set(["name", "wav"]);

function isFrameCount(value: unknown): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isWav(value: unknown): value is Uint8Array {
    if (!(value instanceof Uint8Array) || value.byteLength < 44) return false;
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return value[0] === 0x52 && value[1] === 0x49
        && value[2] === 0x46 && value[3] === 0x46
        && value[8] === 0x57 && value[9] === 0x41
        && value[10] === 0x56 && value[11] === 0x45
        && view.getUint32(4, true) === value.byteLength - 8;
}

function isProgress(message: Record<string, unknown>): boolean {
    return hasOnlyKeys(message, PROGRESS_KEYS)
        && message.t === "progress"
        && isFrameCount(message.frames);
}

function isDone(message: Record<string, unknown>): boolean {
    return hasOnlyKeys(message, DONE_KEYS)
        && message.t === "done"
        && isFrameCount(message.frames)
        && isWav(message.wav);
}

function isWorkerError(message: Record<string, unknown>): boolean {
    return hasOnlyKeys(message, ERROR_KEYS)
        && message.t === "error"
        && message.id === undefined
        && typeof message.message === "string"
        && message.message.length > 0;
}

function isKitDone(message: Record<string, unknown>): boolean {
    if (!hasOnlyKeys(message, KIT_DONE_KEYS)
            || message.t !== "kit-done"
            || !Array.isArray(message.entries)
            || message.entries.length > 0xffff)
        return false;
    return message.entries.every(value => {
        const entry = record(value);
        return entry !== null
            && hasOnlyKeys(entry, KIT_ENTRY_KEYS)
            && typeof entry.name === "string"
            && entry.name.length > 0
            && isWav(entry.wav);
    });
}

export class Exporter {
    busy = false;
    onstatus: ((msg: string, err: boolean) => void) | null = null;
    private worker: Worker | null = null;

    private reportFailure(cause: unknown): void {
        this.busy = false;
        this.onstatus?.(`EXPORT FAILED: ${technicalReason(cause)}`, true);
    }

    private failWorker(worker: Worker, cause: unknown): void {
        if (this.worker !== worker) return;
        this.worker = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        this.reportFailure(cause);
    }

    private ensure(): Worker {
        if (this.worker) return this.worker;
        const worker = new Worker(`${base}synth/export-worker.mjs`,
                                  { type: "module" });
        this.worker = worker;
        worker.onerror = event => {
            event.preventDefault();
            this.failWorker(
                worker,
                new Error(event.message || "audio export worker failed"),
            );
        };
        worker.onmessageerror = () => {
            this.failWorker(worker, new Error("invalid audio export worker response"));
        };
        return worker;
    }

    private begin(
        progress: ((frames: number) => string) | null,
        complete: (message: Record<string, unknown>, worker: Worker) => void,
    ): Worker | null {
        if (this.busy) return null;
        this.busy = true;
        let worker: Worker;
        try {
            worker = this.ensure();
        } catch (cause) {
            this.reportFailure(cause);
            return null;
        }
        worker.onmessage = event => {
            if (this.worker !== worker) return;
            try {
                const message = record(event.data);
                if (!message)
                    throw new Error("invalid audio export worker response");
                if (isProgress(message) && progress) {
                    this.onstatus?.(progress(message.frames as number), false);
                    return;
                }
                if (isWorkerError(message)) {
                    this.failWorker(worker, new Error(message.message as string));
                    return;
                }
                complete(message, worker);
            } catch (cause) {
                this.failWorker(worker, cause);
            }
        };
        return worker;
    }

    private finish(worker: Worker): boolean {
        if (this.worker !== worker) return false;
        worker.onmessage = null;
        this.busy = false;
        return true;
    }

    private send(
        worker: Worker,
        message: Record<string, unknown>,
        transfer: Transferable[],
    ): void {
        try {
            worker.postMessage(message, transfer);
        } catch (cause) {
            this.failWorker(worker, cause);
        }
    }

    /** Render `name{suffix}.wav` off-thread and download it. */
    start(name: string, suffix: string, assets: SongAssets, o: ExportOpts): void {
        const file = `${name}${suffix}.wav`;
        const worker = this.begin(
            frames => `EXPORTING ${file}... ${(frames / RATE).toFixed(0)}s`,
            (message, current) => {
                if (!isDone(message))
                    throw new Error("invalid audio export worker response");
                download(message.wav as Uint8Array, file, "audio/wav");
                if (this.finish(current))
                    this.onstatus?.(`EXPORTED ${file}`, false);
            },
        );
        if (!worker) return;
        this.onstatus?.(`EXPORTING ${file} (VOL ${o.songvol}`
                        + `${o.loop >= 2 ? " LOOPED" : ""})...`, false);
        const withRev = o.revDepth > 0 && assets.libsd !== null;
        const files = {
            hd: assets.hd, bd: assets.bd, mid: assets.mid,
            irx: assets.irx,
            libsd: withRev ? assets.libsd : null,
        };
        const opts = {
            songvol: o.songvol,
            revDepth: withRev ? o.revDepth : null,
            exact: o.exact, bright: o.bright, loop: o.loop,
        };
        this.send(worker, { t: "render", files, opts }, [
            assets.hd.buffer,
            assets.bd.buffer,
            assets.mid.buffer,
            ...(assets.irx ? [assets.irx.buffer] : []),
            ...(withRev ? [assets.libsd!.buffer] : []),
        ]);
    }

    dispose(): void {
        const worker = this.worker;
        this.worker = null;
        if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
        }
        this.busy = false;
    }

    /** Render one embedded SE request, capped for authored infinite loops. */
    se(name: string, assets: SeAssets, o: SeExportOpts): void {
        const file = `${name}_${o.bank}_${o.request}.wav`;
        const worker = this.begin(
            frames => `EXPORTING ${file}... ${(frames / RATE).toFixed(1)}s`,
            (message, current) => {
                if (!isDone(message))
                    throw new Error("invalid audio export worker response");
                download(message.wav as Uint8Array, file, "audio/wav");
                if (this.finish(current))
                    this.onstatus?.(`EXPORTED ${file}`, false);
            },
        );
        if (!worker) return;
        this.onstatus?.(`EXPORTING ${file} (VOL ${o.volume})...`, false);
        const withRev = o.revDepth > 0 && assets.libsd !== null;
        const files = {
            hd: assets.hd, bd: assets.bd, irx: assets.irx,
            libsd: withRev ? assets.libsd : null,
        };
        const opts = {
            volume: o.volume,
            revDepth: withRev ? o.revDepth : null,
            exact: o.exact, bright: o.bright,
            bank: o.bank, request: o.request, seconds: o.seconds, loop: o.loop,
        };
        this.send(worker, { t: "se-render", files, opts }, [
            assets.hd.buffer,
            assets.bd.buffer,
            ...(assets.irx ? [assets.irx.buffer] : []),
            ...(withRev ? [assets.libsd!.buffer] : []),
        ]);
    }

    /** Build `name`_samples.zip (every bank waveform as a WAV) off-thread
     *  and download it. Same worker + busy flag as the WAV renders. */
    kit(name: string, assets: SongAssets): void {
        const file = `${name}_samples.zip`;
        const worker = this.begin(null, (message, current) => {
            if (!isKitDone(message))
                throw new Error("invalid audio export worker response");
            const entries = (message.entries as Record<string, unknown>[])
                .map(entry => [
                    entry.name as string,
                    entry.wav as Uint8Array,
                ] as [string, Uint8Array]);
            const archive = storeZip(entries);
            download(archive, file, "application/zip");
            if (this.finish(current))
                this.onstatus?.(
                    `EXPORTED ${file} (${entries.length} SAMPLES)`,
                    false,
                );
        });
        if (!worker) return;
        this.onstatus?.(`EXPORTING ${file}...`, false);
        this.send(
            worker,
            { t: "kit", files: { hd: assets.hd, bd: assets.bd } },
            [assets.hd.buffer, assets.bd.buffer],
        );
    }
}
