import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import {
    Input, Output, BufferSource, BufferTarget, MatroskaInputFormat,
    WebMOutputFormat, Conversion, QUALITY_HIGH,
} from "mediabunny";
import type { FmvVideoInfo } from "./vendor/extract/index.ts";

export type MovieOutputFormat = "mkv" | "mp4" | "webm";

export interface MovieConversionInput {
    video: Uint8Array;
    wav: Uint8Array;
    videoInfo: FmvVideoInfo;
    subtitleSrt?: Uint8Array;
    embedCaptions?: boolean;
}

export type ConversionProgress = (progress: number, stage: string) => void;

let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let busy = false;
const CLEANUP_FILES = [
    "input.m2v", "input.wav", "input.srt", "base.mkv", "base.mp4",
    "output.mkv", "output.mp4", "intermediate.mkv",
] as const;

async function engine(): Promise<FFmpeg> {
    if (ffmpeg) return ffmpeg;
    if (!loading) {
        const next = new FFmpeg();
        loading = next.load({ coreURL, wasmURL }).then(() => {
            ffmpeg = next;
            return next;
        });
    }
    try {
        return await loading;
    } finally {
        loading = null;
    }
}

function videoFilter(info: FmvVideoInfo): string {
    const sar = "setsar=7/6,format=yuv420p";
    return info.fieldOrder === "progressive"
        ? sar : `yadif=mode=1:parity=${info.fieldOrder === "tt" ? 0 : 1},${sar}`;
}

function outputRate(info: FmvVideoInfo): string {
    return info.fieldOrder === "progressive" ? "30000/1001" : "60000/1001";
}

function displayRatio(info: FmvVideoInfo): string {
    return `${info.displayAspect[0]}:${info.displayAspect[1]}`;
}

function sourceArgs(): string[] {
    return ["-fflags", "+genpts", "-r", "30000/1001", "-i", "input.m2v",
            "-i", "input.wav"];
}

function mp4VideoArgs(): string[] {
    return ["-c:v", "libx264", "-crf", "15", "-preset", "slow"];
}

function baseCommand(format: Exclude<MovieOutputFormat, "webm">,
                     input: MovieConversionInput): string[] {
    const target = input.embedCaptions && input.subtitleSrt
        ? `base.${format}` : `output.${format}`;
    if (format === "mkv") return [
        ...sourceArgs(), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
        "-c:a", "flac", "-aspect", displayRatio(input.videoInfo),
        "-fps_mode", "passthrough", "-shortest", target,
    ];
    return [
        ...sourceArgs(), "-map", "0:v", "-map", "1:a",
        "-vf", videoFilter(input.videoInfo), "-r", outputRate(input.videoInfo),
        ...mp4VideoArgs(), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "256k",
        "-movflags", "+faststart", "-shortest", target,
    ];
}

function captionCommand(format: Exclude<MovieOutputFormat, "webm">): string[] {
    if (format === "mkv") return [
        "-i", "base.mkv", "-i", "input.srt", "-map", "0", "-map", "1:s",
        "-c", "copy", "-metadata:s:s:0", "language=eng", "output.mkv",
    ];
    return [
        "-i", "base.mp4", "-i", "input.srt", "-map", "0", "-map", "1:s",
        "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
        "-metadata:s:s:0", "language=eng", "-movflags", "+faststart",
        "output.mp4",
    ];
}

function webmIntermediateCommand(input: MovieConversionInput): string[] {
    return [
        ...sourceArgs(), "-map", "0:v", "-map", "1:a",
        "-vf", videoFilter(input.videoInfo), "-r", outputRate(input.videoInfo),
        "-c:v", "libx264", "-crf", "1", "-preset", "ultrafast",
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-c:a", "pcm_s16le", "-aspect", displayRatio(input.videoInfo),
        "-shortest", "intermediate.mkv",
    ];
}

async function exec(worker: FFmpeg, args: string[], label: string): Promise<void> {
    const code = await worker.exec(args);
    if (code !== 0) throw new Error(`${label} exited with status ${code}`);
}

function binary(data: Uint8Array | string, label: string): Uint8Array<ArrayBuffer> {
    if (typeof data === "string") throw new Error(`${label} was returned as text`);
    if (data.buffer instanceof ArrayBuffer)
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(data);
}

async function removeFiles(worker: FFmpeg, names: readonly string[]): Promise<void> {
    for (const name of names) {
        try {
            await worker.deleteFile(name);
        } catch {
            // A stage may fail before creating every planned file.
        }
    }
}

async function convertWebm(worker: FFmpeg, input: MovieConversionInput,
                           progress: ConversionProgress,
                           signal?: AbortSignal): Promise<Uint8Array> {
    progress(0, "decoding MPEG-2");
    await exec(worker, webmIntermediateCommand(input), "WebM intermediate conversion");
    const intermediate = binary(await worker.readFile("intermediate.mkv"),
        "WebM intermediate");
    await worker.deleteFile("intermediate.mkv");

    const mediaInput = new Input({
        formats: [new MatroskaInputFormat()],
        source: new BufferSource(intermediate),
    });
    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    const conversion = await Conversion.init({
        input: mediaInput,
        output,
        video: {
            codec: "vp9",
            bitrate: QUALITY_HIGH,
            forceTranscode: true,
            width: 896,
            height: input.videoInfo.height * 1.5,
            fit: "fill",
        },
        audio: { codec: "opus", bitrate: 192_000, forceTranscode: true },
    });
    if (!conversion.isValid || conversion.discardedTracks.length)
        throw new Error(`WebM conversion discarded tracks: ${JSON.stringify(conversion.discardedTracks)}`);
    conversion.onProgress = value => progress(0.5 + value * 0.5, "encoding VP9 and Opus");
    function cancel(): void {
        void conversion.cancel();
    }
    signal?.addEventListener("abort", cancel, { once: true });
    try {
        await conversion.execute();
    } finally {
        signal?.removeEventListener("abort", cancel);
    }
    if (!target.buffer) throw new Error("WebM conversion produced no output");
    return new Uint8Array(target.buffer);
}

function terminateEngine(worker: FFmpeg): void {
    worker.terminate();
    if (ffmpeg === worker) ffmpeg = null;
}


export async function convertMovie(input: MovieConversionInput,
                                   format: MovieOutputFormat,
                                   progress: ConversionProgress,
                                   signal?: AbortSignal): Promise<Uint8Array> {
    if (busy) throw new Error("another movie conversion is already running");
    if (signal?.aborted) throw new DOMException("conversion cancelled", "AbortError");
    busy = true;
    try {
        progress(0, "loading conversion engine");
        const worker = await engine();
        if (signal?.aborted) {
            terminateEngine(worker);
            throw new DOMException("conversion cancelled", "AbortError");
        }
        const onProgress = ({ progress: value }: { progress: number }) =>
            progress(format === "webm" ? value * 0.5 : value, "converting in this browser");
        worker.on("progress", onProgress);
        function cancel(): void {
            terminateEngine(worker);
        }
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            await worker.writeFile("input.m2v", input.video);
            await worker.writeFile("input.wav", input.wav);
            if (input.subtitleSrt) await worker.writeFile("input.srt", input.subtitleSrt);
            if (format === "webm")
                return await convertWebm(worker, input, progress, signal);

            await exec(worker, baseCommand(format, input),
                `${format.toUpperCase()} conversion`);
            if (input.embedCaptions && input.subtitleSrt) {
                await exec(worker, captionCommand(format), `${format.toUpperCase()} caption mux`);
                await worker.deleteFile(`base.${format}`);
            }
            const bytes = binary(await worker.readFile(`output.${format}`),
                `${format.toUpperCase()} output`);
            progress(1, "complete");
            return bytes;
        } finally {
            signal?.removeEventListener("abort", cancel);
            worker.off("progress", onProgress);
            if (!signal?.aborted) await removeFiles(worker, CLEANUP_FILES);
        }
    } finally {
        busy = false;
    }
}
