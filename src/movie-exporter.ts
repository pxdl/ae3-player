import {
    AudioSampleSink,
    BufferSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    EncodedVideoPacketSource,
    canEncodeAudio,
    canEncodeVideo,
    Input,
    MkvOutputFormat,
    Mp4OutputFormat,
    Output,
    TextSubtitleSource,
    VideoSample,
    VideoSampleSource,
    WAVE,
} from "mediabunny";
import type { AudioSample } from "mediabunny";
import {
    createMovieDecoderSource,
    MovieDecoderClient,
} from "./movie-decoder-client.ts";
import {
    movieOutputFrameDuration,
    type DecodedMovieFrame,
    type MovieDecoderStats,
} from "./movie-decoder-protocol.ts";
import type {
    MovieMp4ExportErrorStage,
    MovieMp4ExportRequest,
} from "./movie-export-protocol.ts";
import {
    demuxFmv,
    indexMpeg2SeekPoints,
    type FmvDemux,
    type FmvVideoInfo,
} from "./vendor/extract/index.ts";
type MovieOutput = Output<Mp4OutputFormat, BufferTarget>
    | Output<MkvOutputFormat, BufferTarget>;


const AUDIO_BITRATE = 256_000;
const MAX_DECODER_FRAMES = 32;
const MAX_DECODER_BYTES = 16 * 1024 * 1024;
const MICROSECONDS_PER_SECOND = 1_000_000;
const VIDEO_BITS_PER_PIXEL = 0.15;
const VIDEO_MIN_BITRATE = 1_250_000;
const VIDEO_MAX_BITRATE = 2_000_000;
const CAPABILITY_MESSAGE = "Fast MP4 export is unavailable in this browser. "
    + "Download Masters ZIP to convert locally.";
const VIDEO_ENCODING_OPTIONS = {
    bitrateMode: "variable" as const,
    latencyMode: "quality" as const,
    hardwareAcceleration: "no-preference" as const,
    contentHint: "motion",
};

export function movieExportVideoBitrate(width: number, height: number,
                                        frameRate: number): number {
    if (!Number.isFinite(width) || width <= 0
            || !Number.isFinite(height) || height <= 0
            || !Number.isFinite(frameRate) || frameRate <= 0)
        throw new RangeError("video dimensions and frame rate must be positive and finite");
    const bitrate = width * height * frameRate * VIDEO_BITS_PER_PIXEL;
    const rounded = Math.ceil(bitrate / 1_000) * 1_000;
    return Math.min(VIDEO_MAX_BITRATE, Math.max(VIDEO_MIN_BITRATE, rounded));
}

export type MovieExportProgress = (progress: number, stage: string) => void;

export interface MovieMp4ExportResult {
    buffer: ArrayBuffer;
    mime: "video/mp4";
    encodedFrames: number;
    duration: number;
    stats: MovieDecoderStats;
}
export interface MovieMkvExportResult {
    buffer: ArrayBuffer;
    mime: "video/x-matroska";
    encodedFrames: number;
    duration: number;
}


export class MovieExportStageError extends Error {
    readonly stage: MovieMp4ExportErrorStage;

    constructor(stage: MovieMp4ExportErrorStage, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "MovieExportStageError";
        this.stage = stage;
    }
}

export class MovieMp4ExportController {
    readonly #abort = new AbortController();
    #decoder: MovieDecoderClient | null = null;
    #output: MovieOutput | null = null;
    #cancelPromise: Promise<void> | null = null;

    get signal(): AbortSignal {
        return this.#abort.signal;
    }

    attachDecoder(decoder: MovieDecoderClient): void {
        this.#decoder = decoder;
        if (this.signal.aborted)
            decoder.terminate();
    }

    attachOutput(output: MovieOutput): void {
        this.#output = output;
        if (this.signal.aborted && this.#cancelPromise === null)
            this.#cancelPromise = this.#cancelOutput(output);
    }

    async cancel(reason: unknown = new DOMException("Movie export cancelled", "AbortError")):
            Promise<void> {
        if (!this.signal.aborted)
            this.#abort.abort(reason);
        this.#decoder?.terminate();
        if (this.#cancelPromise === null && this.#output !== null)
            this.#cancelPromise = this.#cancelOutput(this.#output);
        await this.#cancelPromise;
    }

    throwIfAborted(): void {
        this.signal.throwIfAborted();
    }

    async #cancelOutput(output: MovieOutput): Promise<void> {
        if (output.state === "canceled" || output.state === "finalized")
            return;
        await output.cancel();
    }
}

export async function exportMovieMp4(request: MovieMp4ExportRequest,
                                     progress: MovieExportProgress,
                                     controller = new MovieMp4ExportController()):
        Promise<MovieMp4ExportResult> {
    validateRuntimeSupport();
    controller.throwIfAborted();
    progress(0, "Checking browser encoders…");
    await preflight(request);
    controller.throwIfAborted();

    progress(0.04, "Demuxing movie…");
    const demux = runStage("demux", () => demuxFmv(
        new Uint8Array(request.fmv),
        request.name,
    ));
    validateDemux(request, demux);
    controller.throwIfAborted();

    progress(0.1, "Indexing MPEG-2 video…");
    const seekIndex = runStage("index", () => indexMpeg2SeekPoints(
        demux.video,
        `${request.name} video`,
    ));
    controller.throwIfAborted();

    let waveInput: Input<BufferSource> | null = null;
    let decoder: MovieDecoderClient | null = null;
    let output: Output<Mp4OutputFormat, BufferTarget> | null = null;
    let completed = false;
    try {
        const audio = await openWave(demux, request);
        waveInput = audio.input;
        controller.throwIfAborted();

        decoder = new MovieDecoderClient();
        controller.attachDecoder(decoder);
        const ready = await runAsyncStage("decode", () => decoder!.initialize(
            createMovieDecoderSource({
                video: ownedBuffer(demux.video),
                videoInfo: demux.videoInfo,
                duration: request.expectations.duration,
                seekIndex,
            }),
        ));
        controller.throwIfAborted();

        const decoderDuration = ready.outputFrames * ready.frameDuration;
        const duration = Math.min(
            request.expectations.duration,
            decoderDuration,
            audio.duration,
        );
        if (!Number.isFinite(duration) || duration <= 0)
            throw new MovieExportStageError("demux", "movie has no shared audio/video duration");

        const target = new BufferTarget();
        output = new Output({
            format: new Mp4OutputFormat({ fastStart: "in-memory" }),
            target,
        });
        controller.attachOutput(output);

        const videoSource = new VideoSampleSource({
            codec: "avc",
            ...VIDEO_ENCODING_OPTIONS,
            bitrate: movieExportVideoBitrate(ready.width, ready.height, ready.outputRate),
            keyFrameInterval: 2,
        });
        const audioSource = new ClippedAudioEncoderSource(duration);
        const subtitleSource = request.vtt === undefined
            ? null
            : new TextSubtitleSource("webvtt");
        output.addVideoTrack(videoSource, { frameRate: ready.outputRate });
        output.addAudioTrack(audioSource.source);
        if (subtitleSource !== null)
            output.addSubtitleTrack(subtitleSource, { languageCode: "eng" });

        progress(0.15, "Starting MP4 muxer…");
        await runAsyncStage("mux", () => output!.start());
        controller.throwIfAborted();

        let videoResult: VideoProducerResult | undefined;
        const producers = [
            failTogether(controller, async () => {
                videoResult = await produceVideo(
                    decoder!, ready.outputFrames, ready.frameDuration, duration,
                    demux.videoInfo, videoSource, progress, controller,
                );
            }),
            failTogether(controller, () => produceAudio(
                audio.sink, audioSource, controller,
            )),
        ];
        if (subtitleSource !== null && request.vtt !== undefined) {
            producers.push(failTogether(controller, () => produceSubtitles(
                request.vtt!, subtitleSource, duration, controller,
            )));
        }
        const settled = await Promise.allSettled(producers);
        const failure = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure !== undefined)
            throw controller.signal.aborted ? controller.signal.reason : failure.reason;
        if (videoResult === undefined)
            throw new MovieExportStageError("decode", "video producer returned no result");

        controller.throwIfAborted();
        progress(0.94, "Finalizing MP4…");
        await runAsyncStage("mux", () => output!.finalize());
        const buffer = target.buffer;
        if (buffer === null || buffer.byteLength === 0)
            throw new MovieExportStageError("mux", "MP4 muxer produced an empty file");
        completed = true;
        progress(1, "Fast MP4 ready");
        return {
            buffer,
            mime: "video/mp4",
            encodedFrames: videoResult.encodedFrames,
            duration,
            stats: videoResult.stats,
        };
    } catch (cause) {
        try {
            await controller.cancel(cause);
        } catch (cleanupCause) {
            console.error("movie export cleanup failed", cleanupCause);
        }
        throw cause;
    } finally {
        waveInput?.dispose();
        if (decoder !== null) {
            if (completed)
                await decoder.dispose();
            else
                decoder.terminate();
        }
    }
}
export async function exportMovieMkv(request: MovieMp4ExportRequest,
                                     progress: MovieExportProgress,
                                     controller = new MovieMp4ExportController()):
        Promise<MovieMkvExportResult> {
    controller.throwIfAborted();
    progress(0, "Demuxing lossless movie…");
    const demux = runStage("demux", () => demuxFmv(
        new Uint8Array(request.fmv),
        request.name,
    ));
    validateDemux(request, demux);
    controller.throwIfAborted();

    progress(0.08, "Packetizing original MPEG-2 video…");
    const seekIndex = runStage("index", () => indexMpeg2SeekPoints(
        demux.video,
        `${request.name} video`,
    ));
    const packetizedVideo = runStage("index", () => packetizeMpeg2Video(
        demux.video,
        demux.videoInfo.frameRate,
        seekIndex,
    ));
    const audio = runStage("demux", () => readPcmWave(
        demux.wav,
        request.expectations.channels,
        request.expectations.sampleRate,
    ));
    const aligned = runStage("index", () => alignLosslessMovieTracks(
        packetizedVideo,
        audio.duration,
        request.expectations.duration,
    ));
    const { duration, videoPackets } = aligned;
    controller.throwIfAborted();

    const target = new BufferTarget();
    const output = new Output({
        format: new MkvOutputFormat(),
        target,
    });
    controller.attachOutput(output);
    const videoSource = new EncodedVideoPacketSource("mpeg2");
    const audioSource = new EncodedAudioPacketSource("pcm-s16");
    const subtitleSource = request.vtt === undefined
        ? null
        : new TextSubtitleSource("webvtt");
    output.addVideoTrack(videoSource, { frameRate: demux.videoInfo.frameRate });
    output.addAudioTrack(audioSource);
    if (subtitleSource !== null)
        output.addSubtitleTrack(subtitleSource, { languageCode: "eng" });

    try {
        progress(0.14, "Starting lossless MKV muxer…");
        await runAsyncStage("mux", () => output.start());
        controller.throwIfAborted();
        const producers = [
            failTogether(controller, () => produceMpeg2Video(
                videoPackets,
                demux.videoInfo,
                videoSource,
                progress,
                controller,
            )),
            failTogether(controller, () => producePcmAudio(
                audio,
                duration,
                audioSource,
                controller,
            )),
        ];
        if (subtitleSource !== null && request.vtt !== undefined) {
            producers.push(failTogether(controller, () => produceSubtitles(
                request.vtt!,
                subtitleSource,
                duration,
                controller,
            )));
        }
        const settled = await Promise.allSettled(producers);
        const failure = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure !== undefined)
            throw controller.signal.aborted ? controller.signal.reason : failure.reason;

        controller.throwIfAborted();
        progress(0.96, "Finalizing lossless MKV…");
        await runAsyncStage("mux", () => output.finalize());
        const buffer = target.buffer;
        if (buffer === null || buffer.byteLength === 0)
            throw new MovieExportStageError("mux", "MKV muxer produced an empty file");
        progress(1, "Lossless MKV ready");
        return {
            buffer,
            mime: "video/x-matroska",
            encodedFrames: videoPackets.length,
            duration,
        };
    } catch (cause) {
        try {
            await controller.cancel(cause);
        } catch (cleanupCause) {
            console.error("movie export cleanup failed", cleanupCause);
        }
        throw cause;
    }
}


function validateRuntimeSupport(): void {
    if (typeof VideoFrame !== "function" || typeof VideoEncoder !== "function"
            || typeof AudioData !== "function" || typeof AudioEncoder !== "function")
        throw new MovieExportStageError("capability", CAPABILITY_MESSAGE);
}

async function preflight(request: MovieMp4ExportRequest): Promise<void> {
    const { width, height, fieldOrder, channels, sampleRate } = request.expectations;
    const frameRate = 1 / movieOutputFrameDuration(fieldOrder);
    const bitrate = movieExportVideoBitrate(width, height, frameRate);
    let videoSupported: boolean;
    let audioSupported: boolean;
    try {
        [videoSupported, audioSupported] = await Promise.all([
            canEncodeVideo("avc", {
                width, height, bitrate, ...VIDEO_ENCODING_OPTIONS,
            }),
            canEncodeAudio("aac", {
                numberOfChannels: channels,
                sampleRate,
                bitrate: AUDIO_BITRATE,
            }),
        ]);
    } catch (cause) {
        throw new MovieExportStageError("capability", CAPABILITY_MESSAGE, { cause });
    }
    if (!videoSupported || !audioSupported)
        throw new MovieExportStageError("capability", CAPABILITY_MESSAGE);
}

function validateDemux(request: MovieMp4ExportRequest, demux: FmvDemux): void {
    const expected = request.expectations;
    const actual = demux.videoInfo;
    if (actual.width !== expected.width || actual.height !== expected.height
            || actual.fieldOrder !== expected.fieldOrder
            || !sameRatio(actual.sampleAspect, expected.sampleAspect)
            || !sameRatio(actual.displayAspect, expected.displayAspect)) {
        throw new MovieExportStageError(
            "demux",
            `${request.name} metadata does not match the scanned catalog`,
        );
    }
    const duration = demux.header.fields / demux.header.fieldRate;
    if (!nearlyEqual(duration, expected.duration)
            || demux.header.channels !== expected.channels
            || demux.header.sampleRate !== expected.sampleRate) {
        throw new MovieExportStageError(
            "demux",
            `${request.name} audio or duration metadata does not match the scanned catalog`,
        );
    }
}

async function openWave(demux: FmvDemux, request: MovieMp4ExportRequest): Promise<{
    input: Input<BufferSource>;
    sink: AudioSampleSink;
    duration: number;
}> {
    const input = new Input({
        formats: [WAVE],
        source: new BufferSource(demux.wav),
    });
    try {
        if (!await input.canRead())
            throw new Error("decoded PCM WAV is unreadable");
        const tracks = await input.getAudioTracks();
        if (tracks.length !== 1)
            throw new Error(`decoded PCM WAV has ${tracks.length} audio tracks`);
        const track = tracks[0];
        const [channels, sampleRate, duration] = await Promise.all([
            track.getNumberOfChannels(),
            track.getSampleRate(),
            input.computeDuration([track]),
        ]);
        if (channels !== request.expectations.channels
                || sampleRate !== request.expectations.sampleRate)
            throw new Error("decoded PCM WAV metadata does not match the scanned catalog");
        if (!Number.isFinite(duration) || duration <= 0)
            throw new Error("decoded PCM WAV has no duration");
        return { input, sink: new AudioSampleSink(track), duration };
    } catch (cause) {
        input.dispose();
        throw stageError("demux", cause);
    }
}
export function packetizeMpeg2Video(video: Uint8Array, frameRate: number,
                                    seekIndex = indexMpeg2SeekPoints(video)):
        EncodedPacket[] {
    if (!Number.isFinite(frameRate) || frameRate <= 0)
        throw new RangeError("MPEG-2 frame rate must be positive and finite");
    const codes: Array<{ offset: number; code: number }> = [];
    for (let offset = 0; offset + 4 <= video.byteLength; offset++) {
        if (video[offset] === 0 && video[offset + 1] === 0 && video[offset + 2] === 1) {
            codes.push({ offset, code: video[offset + 3]! });
            offset += 3;
        }
    }
    const pictures = codes
        .map((item, codeIndex) => ({ ...item, codeIndex }))
        .filter(item => item.code === 0);
    if (pictures.length !== seekIndex.frames)
        throw new Error(`packetized ${pictures.length} MPEG-2 pictures; expected ${seekIndex.frames}`);

    const units = pictures.map((picture, pictureIndex) => {
        const payload = picture.offset + 4;
        if (payload + 2 > video.byteLength)
            throw new Error(`truncated MPEG-2 picture header at 0x${picture.offset.toString(16)}`);
        const temporalReference = video[payload]! << 2 | video[payload + 1]! >> 6;
        const pictureType = video[payload + 1]! >> 3 & 7;
        if (pictureType < 1 || pictureType > 3)
            throw new Error(`unsupported MPEG-2 picture type ${pictureType}`);

        let start = picture.offset;
        if (pictureIndex === 0) {
            start = 0;
        } else {
            const previousPictureCodeIndex = pictures[pictureIndex - 1]!.codeIndex;
            for (let index = picture.codeIndex - 1; index > previousPictureCodeIndex; index--) {
                const leading = codes[index]!;
                if (leading.code >= 0x01 && leading.code <= 0xaf)
                    break;
                start = leading.offset;
            }
        }
        return {
            start,
            temporalReference,
            pictureType,
            key: seekIndex.points.some(point =>
                point.offset >= start && point.offset <= picture.offset),
        };
    });
    if (!units[0]?.key)
        throw new Error("first MPEG-2 access unit is not an indexed key picture");

    const packets: EncodedPacket[] = [];
    let groupStart = 0;
    let presentationBase = 0;
    for (let index = 1; index <= units.length; index++) {
        if (index < units.length && !units[index]!.key)
            continue;
        const group = units.slice(groupStart, index);
        const references = new Set(group.map(unit => unit.temporalReference));
        if (references.size !== group.length
                || group.some(unit => unit.temporalReference >= group.length)) {
            throw new Error("MPEG-2 GOP temporal references are not a complete presentation order");
        }
        for (let offset = 0; offset < group.length; offset++) {
            const unitIndex = groupStart + offset;
            const unit = group[offset]!;
            const end = units[unitIndex + 1]?.start ?? video.byteLength;
            packets.push(new EncodedPacket(
                video.subarray(unit.start, end),
                unit.key ? "key" : "delta",
                (presentationBase + unit.temporalReference) / frameRate,
                1 / frameRate,
                unitIndex,
            ));
        }
        presentationBase += group.length;
        groupStart = index;
    }
    return packets;
}
export function clipMpeg2Packets(packets: readonly EncodedPacket[],
                                 duration: number): EncodedPacket[] {
    if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("movie has no shared audio/video duration");
    return packets.map(packet => {
        const clippedDuration = Math.min(packet.duration, duration - packet.timestamp);
        if (clippedDuration <= 0) {
            throw new Error(
                "shared movie duration would discard original MPEG-2 picture data",
            );
        }
        return clippedDuration === packet.duration
            ? packet
            : packet.clone({ duration: clippedDuration });
    });
}
export function alignLosslessMovieTracks(
    packets: readonly EncodedPacket[],
    audioDuration: number,
    scannedDuration: number,
): { duration: number; videoPackets: EncodedPacket[] } {
    const naturalVideoDuration = packets.reduce(
        (end, packet) => Math.max(end, packet.timestamp + packet.duration),
        0,
    );
    const duration = Math.min(scannedDuration, naturalVideoDuration, audioDuration);
    return {
        duration,
        videoPackets: clipMpeg2Packets(packets, duration),
    };
}



interface PcmWave {
    data: Uint8Array;
    channels: number;
    sampleRate: number;
    frames: number;
    duration: number;
}

function readPcmWave(bytes: Uint8Array, expectedChannels: number,
                     expectedSampleRate: number): PcmWave {
    if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF"
            || ascii(bytes, 8, 4) !== "WAVE")
        throw new Error("decoded PCM WAV has an invalid RIFF header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let channels = 0;
    let sampleRate = 0;
    let blockAlign = 0;
    let bitsPerSample = 0;
    let data: Uint8Array | null = null;
    for (let offset = 12; offset + 8 <= bytes.byteLength;) {
        const size = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = start + size;
        if (end > bytes.byteLength)
            throw new Error("decoded PCM WAV contains a truncated chunk");
        const id = ascii(bytes, offset, 4);
        if (id === "fmt ") {
            if (size < 16 || view.getUint16(start, true) !== 1)
                throw new Error("decoded WAV audio is not integer PCM");
            channels = view.getUint16(start + 2, true);
            sampleRate = view.getUint32(start + 4, true);
            blockAlign = view.getUint16(start + 12, true);
            bitsPerSample = view.getUint16(start + 14, true);
        } else if (id === "data") {
            data = bytes.subarray(start, end);
        }
        offset = end + (size & 1);
    }
    if (data === null || channels !== expectedChannels || sampleRate !== expectedSampleRate
            || bitsPerSample !== 16 || blockAlign !== channels * 2
            || data.byteLength === 0 || data.byteLength % blockAlign !== 0)
        throw new Error("decoded PCM WAV metadata does not match the scanned catalog");
    const frames = data.byteLength / blockAlign;
    return { data, channels, sampleRate, frames, duration: frames / sampleRate };
}

async function produceMpeg2Video(packets: readonly EncodedPacket[],
                                 info: FmvVideoInfo,
                                 source: EncodedVideoPacketSource,
                                 progress: MovieExportProgress,
                                 controller: MovieMp4ExportController): Promise<void> {
    const metadata: EncodedVideoChunkMetadata = {
        decoderConfig: {
            codec: "mpeg2video",
            codedWidth: info.width,
            codedHeight: info.height,
            displayAspectWidth: info.displayAspect[0],
            displayAspectHeight: info.displayAspect[1],
            colorSpace: {
                primaries: "smpte170m",
                transfer: "smpte170m",
                matrix: "smpte170m",
                fullRange: false,
            },
        },
    };
    try {
        for (let index = 0; index < packets.length; index++) {
            controller.throwIfAborted();
            await source.add(packets[index]!, index === 0 ? metadata : undefined);
            progress(
                0.16 + 0.74 * (index + 1) / packets.length,
                `Remuxing original MPEG-2 video · ${index + 1} / ${packets.length}`,
            );
        }
    } catch (cause) {
        throw stageError("mux", cause);
    } finally {
        source.close();
    }
}

async function producePcmAudio(audio: PcmWave, duration: number,
                               source: EncodedAudioPacketSource,
                               controller: MovieMp4ExportController): Promise<void> {
    const framesPerPacket = 4096;
    const bytesPerFrame = audio.channels * 2;
    const outputFrames = audioFramesWithinDuration(
        0,
        audio.sampleRate,
        audio.frames,
        duration,
    );
    const metadata: EncodedAudioChunkMetadata = {
        decoderConfig: {
            codec: "pcm-s16",
            numberOfChannels: audio.channels,
            sampleRate: audio.sampleRate,
        },
    };
    try {
        for (let frame = 0, sequence = 0; frame < outputFrames;
                frame += framesPerPacket, sequence++) {
            controller.throwIfAborted();
            const frames = Math.min(framesPerPacket, outputFrames - frame);
            const start = frame * bytesPerFrame;
            const data = audio.data.subarray(start, start + frames * bytesPerFrame);
            await source.add(
                new EncodedPacket(
                    data,
                    "key",
                    frame / audio.sampleRate,
                    frames / audio.sampleRate,
                    sequence,
                ),
                sequence === 0 ? metadata : undefined,
            );
        }
    } catch (cause) {
        throw stageError("mux", cause);
    } finally {
        source.close();
    }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    let value = "";
    for (let index = 0; index < length; index++)
        value += String.fromCharCode(bytes[offset + index]!);
    return value;
}


interface VideoProducerResult {
    encodedFrames: number;
    stats: MovieDecoderStats;
}

async function produceVideo(decoder: MovieDecoderClient, outputFrames: number,
                            frameDuration: number, duration: number,
                            info: FmvVideoInfo, source: VideoSampleSource,
                            progress: MovieExportProgress,
                            controller: MovieMp4ExportController):
        Promise<VideoProducerResult> {
    const timelineEnd = outputFrames * frameDuration;
    const pull = {
        untilTimestamp: timelineEnd,
        maxFrames: MAX_DECODER_FRAMES,
        maxBytes: MAX_DECODER_BYTES,
    };
    let deliveredFrames = 0;
    let encodedFrames = 0;
    let stats: MovieDecoderStats | null = null;
    let first = true;
    try {
        for (;;) {
            controller.throwIfAborted();
            const response = await runAsyncStage("decode", () => first
                ? decoder.prime(pull)
                : decoder.pull(pull));
            first = false;
            stats = response.stats;
            if (response.type === "eof")
                break;
            for (const frame of response.frames) {
                deliveredFrames++;
                if (frame.timestamp < duration) {
                    const clippedDuration = Math.min(
                        frame.duration,
                        duration - frame.timestamp,
                    );
                    if (clippedDuration > 0) {
                        await addVideoFrame(frame, clippedDuration, info, source);
                        encodedFrames++;
                    }
                }
                progress(
                    0.18 + 0.72 * Math.min(1, deliveredFrames / outputFrames),
                    `Decoding and encoding video · ${deliveredFrames} / ${outputFrames}`,
                );
                controller.throwIfAborted();
            }
            if (response.eof)
                break;
        }
    } catch (cause) {
        throw stageError(
            cause instanceof MovieExportStageError ? cause.stage : "encode",
            cause,
        );
    } finally {
        source.close();
    }
    if (deliveredFrames !== outputFrames)
        throw new MovieExportStageError(
            "decode",
            `decoder delivered ${deliveredFrames} frames; expected ${outputFrames}`,
        );
    if (stats === null)
        throw new MovieExportStageError("decode", "decoder returned no statistics");
    console.info("movie export decoder stats", stats);
    return { encodedFrames, stats };
}

async function addVideoFrame(frame: DecodedMovieFrame, duration: number,
                             info: FmvVideoInfo, source: VideoSampleSource): Promise<void> {
    let sample: VideoSample | null = null;
    try {
        sample = createMovieVideoSample(frame, duration, info.displayAspect);
        await source.add(sample);
    } catch (cause) {
        throw stageError("encode", cause);
    } finally {
        sample?.close();
    }
}

export function createMovieVideoSample(frame: DecodedMovieFrame, duration: number,
                                       displayAspect: readonly [number, number]):
        VideoSample {
    const [displayWidth, displayHeight] = exactDisplaySize(displayAspect);
    const data = frame.data;
    const init: VideoFrameBufferInit & { transfer: ArrayBuffer[] } = {
        format: "I420",
        codedWidth: frame.width,
        codedHeight: frame.height,
        layout: frame.layout.map(plane => ({ ...plane })),
        timestamp: Math.round(frame.timestamp * MICROSECONDS_PER_SECOND),
        duration: Math.round(duration * MICROSECONDS_PER_SECOND),
        displayWidth,
        displayHeight,
        colorSpace: {
            primaries: "smpte170m",
            transfer: "smpte170m",
            matrix: "smpte170m",
            fullRange: false,
        },
        transfer: [data],
    };
    const nativeFrame = new VideoFrame(data, init);
    try {
        return new VideoSample(nativeFrame, {
            timestamp: frame.timestamp,
            duration,
        });
    } catch (cause) {
        nativeFrame.close();
        throw cause;
    }
}

class ClippedAudioEncoderSource {
    readonly source = new EncodedAudioPacketSource("aac");
    readonly duration: number;
    #encoder: AudioEncoder | null = null;
    #pendingPacketAdds = Promise.resolve();
    #failure: { cause: unknown } | null = null;

    constructor(duration: number) {
        this.duration = duration;
    }

    async add(sample: AudioSample): Promise<void> {
        this.#throwIfFailed();
        const encoder = this.#encoder ??= this.#createEncoder(sample);
        const data = sample.toAudioData();
        try {
            encoder.encode(data);
        } finally {
            data.close();
        }
        if (encoder.encodeQueueSize >= 4) {
            await new Promise<void>(resolve => {
                encoder.addEventListener("dequeue", () => resolve(), { once: true });
            });
        }
        await this.#pendingPacketAdds;
        this.#throwIfFailed();
    }

    async close(): Promise<void> {
        try {
            if (this.#encoder !== null) {
                await this.#encoder.flush();
                await this.#pendingPacketAdds;
                this.#throwIfFailed();
            }
        } finally {
            try {
                if (this.#encoder !== null && this.#encoder.state !== "closed")
                    this.#encoder.close();
            } finally {
                this.source.close();
            }
        }
    }

    #createEncoder(sample: AudioSample): AudioEncoder {
        const encoder = new AudioEncoder({
            output: (chunk, meta) => {
                try {
                    const packet = clipEncodedAudioPacket(
                        snapEncodedAudioPacket(
                            EncodedPacket.fromEncodedChunk(chunk),
                            sample.sampleRate,
                        ),
                        this.duration,
                    );
                    if (packet === null)
                        return;
                    const normalizedMeta = normalizeAacMetadata(
                        meta,
                        sample.sampleRate,
                        sample.numberOfChannels,
                    );
                    this.#pendingPacketAdds = this.#pendingPacketAdds
                        .then(() => this.source.add(packet, normalizedMeta))
                        .catch(cause => this.#recordFailure(cause));
                } catch (cause) {
                    this.#recordFailure(cause);
                }
            },
            error: cause => this.#recordFailure(cause),
        });
        encoder.configure({
            codec: "mp4a.40.2",
            numberOfChannels: sample.numberOfChannels,
            sampleRate: sample.sampleRate,
            bitrate: AUDIO_BITRATE,
        });
        return encoder;
    }

    #recordFailure(cause: unknown): void {
        this.#failure ??= { cause };
    }

    #throwIfFailed(): void {
        if (this.#failure !== null)
            throw this.#failure.cause;
    }
}

async function produceAudio(sink: AudioSampleSink, encoder: ClippedAudioEncoderSource,
                            controller: MovieMp4ExportController): Promise<void> {
    await runAsyncStage("encode", async () => {
        try {
            for await (const sample of sink.samples(0, encoder.duration)) {
                controller.throwIfAborted();
                try {
                    const frames = audioFramesWithinDuration(
                        sample.timestamp,
                        sample.sampleRate,
                        sample.numberOfFrames,
                        encoder.duration,
                    );
                    if (frames <= 0)
                        break;
                    const outputSample = frames < sample.numberOfFrames
                        ? sample.trim(0, frames)
                        : sample;
                    try {
                        await encoder.add(outputSample);
                    } finally {
                        if (outputSample !== sample)
                            outputSample.close();
                    }
                } finally {
                    sample.close();
                }
            }
        } finally {
            await encoder.close();
        }
    });
}


const AAC_SAMPLE_RATES = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000,
    24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
] as const;
const AAC_CHANNELS = [-1, 1, 2, 3, 4, 5, 6, 8] as const;

export function normalizeAacMetadata(meta: EncodedAudioChunkMetadata | undefined,
                                     sampleRate: number, numberOfChannels: number):
        EncodedAudioChunkMetadata {
    const config = meta?.decoderConfig;
    const description = config?.description;
    if (meta !== undefined && description !== undefined) {
        const bytes = bufferBytes(description);
        if (bytes.byteLength >= 2 && bytes[0] >> 3 !== 0)
            return meta;
    }
    return {
        ...meta,
        decoderConfig: {
            ...config,
            codec: config?.codec ?? "mp4a.40.2",
            sampleRate: config?.sampleRate ?? sampleRate,
            numberOfChannels: config?.numberOfChannels ?? numberOfChannels,
            description: buildAacLcAudioSpecificConfig(sampleRate, numberOfChannels),
        },
    };
}

export function snapEncodedAudioPacket(packet: EncodedPacket, sampleRate: number):
        EncodedPacket {
    const timestamp = Math.round(packet.timestamp * sampleRate) / sampleRate;
    const duration = Math.round(packet.duration * sampleRate) / sampleRate;
    if (timestamp === packet.timestamp && duration === packet.duration)
        return packet;
    return packet.clone({ timestamp, duration });
}

function buildAacLcAudioSpecificConfig(sampleRate: number,
                                       numberOfChannels: number): Uint8Array {
    let frequencyIndex = AAC_SAMPLE_RATES.indexOf(
        sampleRate as typeof AAC_SAMPLE_RATES[number],
    );
    const channelConfiguration = AAC_CHANNELS.indexOf(
        numberOfChannels as typeof AAC_CHANNELS[number],
    );
    if (channelConfiguration < 0)
        throw new TypeError(`unsupported AAC channel count: ${numberOfChannels}`);
    const customRate = frequencyIndex < 0;
    if (customRate)
        frequencyIndex = 15;
    const bits: number[] = [];
    writeBits(bits, 2, 5);
    writeBits(bits, frequencyIndex, 4);
    if (customRate)
        writeBits(bits, sampleRate, 24);
    writeBits(bits, channelConfiguration, 4);
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let index = 0; index < bits.length; index++)
        bytes[index >> 3] |= bits[index] << (7 - (index & 7));
    return bytes;
}

function writeBits(target: number[], value: number, count: number): void {
    for (let shift = count - 1; shift >= 0; shift--)
        target.push(value >> shift & 1);
}

function bufferBytes(buffer: AllowSharedBufferSource): Uint8Array {
    if (ArrayBuffer.isView(buffer)) {
        return new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
        );
    }
    return new Uint8Array(buffer);
}

export function clipEncodedAudioPacket(packet: EncodedPacket, duration: number):
        EncodedPacket | null {
    const clippedDuration = Math.min(packet.duration, duration - packet.timestamp);
    if (clippedDuration <= 0)
        return null;
    return clippedDuration === packet.duration
        ? packet
        : packet.clone({ duration: clippedDuration });
}

export function audioFramesWithinDuration(timestamp: number, sampleRate: number,
                                          frames: number, duration: number): number {
    const remaining = duration - timestamp;
    if (remaining <= 0)
        return 0;
    return Math.min(
        frames,
        Math.floor(remaining * sampleRate + Number.EPSILON),
    );
}

async function produceSubtitles(vtt: ArrayBuffer, source: TextSubtitleSource,
                                duration: number, controller: MovieMp4ExportController):
        Promise<void> {
    try {
        controller.throwIfAborted();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(vtt);
        await source.add(clipMovieVtt(text, duration));
    } catch (cause) {
        throw stageError("mux", cause);
    } finally {
        source.close();
    }
}

export function exactDisplaySize(aspect: readonly [number, number]): [number, number] {
    const divisor = gcd(aspect[0], aspect[1]);
    return [aspect[0] / divisor, aspect[1] / divisor];
}

export function clipMovieVtt(text: string, duration: number): string {
    if (!Number.isFinite(duration) || duration <= 0)
        throw new TypeError("subtitle duration must be positive and finite");
    const normalized = text.replace(/\r\n?/g, "\n");
    const blocks = normalized.split(/\n{2,}/);
    if (blocks[0]?.trim() !== "WEBVTT")
        throw new Error("captions are not a generated WebVTT file");
    const clipped = ["WEBVTT"];
    for (const block of blocks.slice(1)) {
        const lines = block.split("\n");
        const timingIndex = lines.findIndex(line => line.includes(" --> "));
        if (timingIndex < 0)
            continue;
        const match = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/.exec(
            lines[timingIndex],
        );
        if (match === null)
            throw new Error("captions contain an unsupported WebVTT timing line");
        const start = vttSeconds(match, 1);
        const end = vttSeconds(match, 5);
        if (start >= duration || end <= start)
            continue;
        lines[timingIndex] = `${vttTimestamp(start)} --> ${vttTimestamp(Math.min(end, duration))}`;
        clipped.push(lines.join("\n"));
    }
    return `${clipped.join("\n\n")}\n`;
}

function vttSeconds(match: RegExpExecArray, offset: number): number {
    return Number(match[offset]) * 3600 + Number(match[offset + 1]) * 60
        + Number(match[offset + 2]) + Number(match[offset + 3]) / 1000;
}

function vttTimestamp(seconds: number): string {
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const wholeSeconds = Math.floor(milliseconds % 60_000 / 1000);
    const fraction = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:`
        + `${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

async function failTogether(controller: MovieMp4ExportController,
                            producer: () => Promise<void>): Promise<void> {
    try {
        await producer();
    } catch (cause) {
        await controller.cancel(cause);
        throw cause;
    }
}

function runStage<T>(stage: MovieMp4ExportErrorStage, operation: () => T): T {
    try {
        return operation();
    } catch (cause) {
        throw stageError(stage, cause);
    }
}

async function runAsyncStage<T>(stage: MovieMp4ExportErrorStage,
                                operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (cause) {
        throw stageError(stage, cause);
    }
}

function stageError(stage: MovieMp4ExportErrorStage,
                    cause: unknown): MovieExportStageError {
    if (cause instanceof MovieExportStageError)
        return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new MovieExportStageError(stage, message || `movie export failed during ${stage}`, {
        cause,
    });
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.buffer instanceof ArrayBuffer
            && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
        return bytes.buffer;
    return bytes.slice().buffer;
}

function sameRatio(left: readonly number[], right: readonly number[]): boolean {
    return left.length === 2 && right.length === 2
        && left[0] * right[1] === left[1] * right[0];
}

function nearlyEqual(left: number, right: number): boolean {
    return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function gcd(left: number, right: number): number {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) {
        [a, b] = [b, a % b];
    }
    return a;
}
