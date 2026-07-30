/* Export UI glue: bgmplay's dropdown actions (current settings / authored
 * original / loop xN) through the export Worker, finished WAV delivered as a
 * download. Mirrors export_wav's command construction: the pitch irx goes in
 * whenever present, libsd + rev depth only when the depth is nonzero. One
 * export at a time (bgmplay's exporting flag). */

import type { SeAssets, SongAssets } from "./player.ts";
import { RATE } from "./timeline.ts";
import { storeZip } from "./zip.ts";

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

const base = import.meta.env.BASE_URL;

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

export class Exporter {
    busy = false;
    onstatus: ((msg: string, err: boolean) => void) | null = null;
    private worker: Worker | null = null;

    /** Render `name{suffix}.wav` off-thread and download it. */
    start(name: string, suffix: string, assets: SongAssets, o: ExportOpts): void {
        if (this.busy) return;
        this.busy = true;
        this.worker ??= new Worker(`${base}synth/export-worker.mjs`,
                                   { type: "module" });
        const file = `${name}${suffix}.wav`;
        this.onstatus?.(`EXPORTING ${file} (VOL ${o.songvol}`
                        + `${o.loop >= 2 ? " LOOPED" : ""})...`, false);
        const withRev = o.revDepth > 0 && assets.libsd !== null;
        this.worker.onmessage = (e) => {
            const m = e.data;
            if (m.t === "progress") {
                this.onstatus?.(
                    `EXPORTING ${file}... ${(m.frames / RATE).toFixed(0)}s`, false);
            } else if (m.t === "done") {
                this.busy = false;
                download(m.wav, file, "audio/wav");
                this.onstatus?.(`EXPORTED ${file}`, false);
            } else if (m.t === "error") {
                this.busy = false;
                this.onstatus?.(`EXPORT FAILED: ${m.message}`, true);
            }
        };
        this.worker.onerror = (e) => {
            this.busy = false;
            this.onstatus?.(`EXPORT FAILED: ${e.message}`, true);
        };
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
        this.worker.postMessage({ t: "render", files, opts },
            [assets.hd.buffer, assets.bd.buffer, assets.mid.buffer,
             ...(assets.irx ? [assets.irx.buffer] : []),
             ...(withRev ? [assets.libsd!.buffer] : [])]);
    }

    /** Render one embedded SE request, capped for authored infinite loops. */
    se(name: string, assets: SeAssets, o: SeExportOpts): void {
        if (this.busy) return;
        this.busy = true;
        this.worker ??= new Worker(`${base}synth/export-worker.mjs`,
                                   { type: "module" });
        const file = `${name}_${o.bank}_${o.request}.wav`;
        this.onstatus?.(`EXPORTING ${file} (VOL ${o.volume})...`, false);
        const withRev = o.revDepth > 0 && assets.libsd !== null;
        this.worker.onmessage = (e) => {
            const m = e.data;
            if (m.t === "progress") {
                this.onstatus?.(
                    `EXPORTING ${file}... ${(m.frames / RATE).toFixed(1)}s`, false);
            } else if (m.t === "done") {
                this.busy = false;
                download(m.wav, file, "audio/wav");
                this.onstatus?.(`EXPORTED ${file}`, false);
            } else if (m.t === "error") {
                this.busy = false;
                this.onstatus?.(`EXPORT FAILED: ${m.message}`, true);
            }
        };
        this.worker.onerror = (e) => {
            this.busy = false;
            this.onstatus?.(`EXPORT FAILED: ${e.message}`, true);
        };
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
        this.worker.postMessage({ t: "se-render", files, opts },
            [assets.hd.buffer, assets.bd.buffer,
             ...(assets.irx ? [assets.irx.buffer] : []),
             ...(withRev ? [assets.libsd!.buffer] : [])]);
    }

    /** Build `name`_samples.zip (every bank waveform as a WAV) off-thread
     *  and download it. Same worker + busy flag as the WAV renders. */
    kit(name: string, assets: SongAssets): void {
        if (this.busy) return;
        this.busy = true;
        this.worker ??= new Worker(`${base}synth/export-worker.mjs`,
                                   { type: "module" });
        const file = `${name}_samples.zip`;
        this.onstatus?.(`EXPORTING ${file}...`, false);
        this.worker.onmessage = (e) => {
            const m = e.data;
            if (m.t === "kit-done") {
                this.busy = false;
                const entries: [string, Uint8Array][] =
                    (m.entries as { name: string; wav: Uint8Array }[])
                        .map((x) => [x.name, x.wav]);
                download(storeZip(entries), file, "application/zip");
                this.onstatus?.(`EXPORTED ${file} (${entries.length} SAMPLES)`, false);
            } else if (m.t === "error") {
                this.busy = false;
                this.onstatus?.(`EXPORT FAILED: ${m.message}`, true);
            }
        };
        this.worker.onerror = (e) => {
            this.busy = false;
            this.onstatus?.(`EXPORT FAILED: ${e.message}`, true);
        };
        this.worker.postMessage({ t: "kit", files: { hd: assets.hd, bd: assets.bd } },
                                [assets.hd.buffer, assets.bd.buffer]);
    }
}
