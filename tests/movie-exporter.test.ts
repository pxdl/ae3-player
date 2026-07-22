import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
    BufferSource,
    EncodedPacket,
    Input,
    WAVE,
} from "mediabunny";
import {
    audioFramesWithinDuration,
    clipEncodedAudioPacket,
    clipMovieVtt,
    createMovieVideoSample,
    exactDisplaySize,
    MovieMp4ExportController,
    movieExportVideoBitrate,
    normalizeAacMetadata,
    snapEncodedAudioPacket,
} from "../src/movie-exporter.ts";
import type { DecodedMovieFrame } from "../src/movie-decoder-protocol.ts";

class FakeVideoFrame {
    static lastInit: (VideoFrameBufferInit & { transfer?: ArrayBuffer[] }) | null = null;
    static transfersOwnership = true;
    readonly format: VideoPixelFormat;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly timestamp: number;
    readonly duration: number | null;
    readonly visibleRect: DOMRectReadOnly;
    readonly colorSpace: VideoColorSpace;
    closed = false;

    constructor(data: AllowSharedBufferSource,
                init: VideoFrameBufferInit & { transfer?: ArrayBuffer[] }) {
        FakeVideoFrame.lastInit = {
            ...init,
            layout: init.layout?.map(plane => ({ ...plane })),
        };
        this.format = init.format;
        this.codedWidth = init.codedWidth;
        this.codedHeight = init.codedHeight;
        this.displayWidth = init.displayWidth ?? init.codedWidth;
        this.displayHeight = init.displayHeight ?? init.codedHeight;
        this.timestamp = init.timestamp;
        this.duration = init.duration ?? null;
        this.visibleRect = {
            x: 0,
            y: 0,
            width: init.codedWidth,
            height: init.codedHeight,
        } as DOMRectReadOnly;
        this.colorSpace = init.colorSpace as VideoColorSpace;
        if (init.transfer && FakeVideoFrame.transfersOwnership)
            structuredClone(data, { transfer: init.transfer });
    }

    close(): void {
        this.closed = true;
    }
}

const originalVideoFrame = globalThis.VideoFrame;
Object.defineProperty(globalThis, "VideoFrame", {
    configurable: true,
    value: FakeVideoFrame,
});

after(() => {
    Object.defineProperty(globalThis, "VideoFrame", {
        configurable: true,
        value: originalVideoFrame,
    });
});

function pcmWave(frames: number, channels: number, sampleRate: number): Uint8Array {
    const bytesPerFrame = channels * 2;
    const dataBytes = frames * bytesPerFrame;
    const wav = new Uint8Array(44 + dataBytes);
    const view = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, 36 + dataBytes, true);
    wav.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerFrame, true);
    view.setUint16(32, bytesPerFrame, true);
    view.setUint16(34, 16, true);
    wav.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, dataBytes, true);
    return wav;
}

function decodedFrame(timestamp: number, duration: number): DecodedMovieFrame {
    return {
        index: 0,
        timestamp,
        duration,
        width: 4,
        height: 2,
        format: "I420",
        data: new ArrayBuffer(12),
        layout: [
            { offset: 0, stride: 4 },
            { offset: 8, stride: 2 },
            { offset: 10, stride: 2 },
        ],
    };
}

test("MediaBunny accepts generated PCM WAV metadata", async () => {
    const frames = 2_048;
    const channels = 2;
    const sampleRate = 48_000;
    const input = new Input({
        formats: [WAVE],
        source: new BufferSource(pcmWave(frames, channels, sampleRate)),
    });
    try {
        assert.equal(await input.canRead(), true);
        const tracks = await input.getAudioTracks();
        assert.equal(tracks.length, 1);
        assert.equal(await tracks[0].getNumberOfChannels(), channels);
        assert.equal(await tracks[0].getSampleRate(), sampleRate);
        assert.equal(await input.computeDuration(tracks), frames / sampleRate);
    } finally {
        input.dispose();
    }
});

test("video bitrate adapts to frame cadence within quality bounds", () => {
    assert.equal(movieExportVideoBitrate(512, 320, 30_000 / 1_001), 1_250_000);
    assert.equal(movieExportVideoBitrate(512, 384, 60_000 / 1_001), 1_768_000);
    assert.equal(movieExportVideoBitrate(320, 240, 24), 1_250_000);
    assert.equal(movieExportVideoBitrate(1_920, 1_080, 60), 2_000_000);
});

test("display metadata preserves exact authored DAR", () => {
    for (const [width, height, expected] of [
        [512, 320, [28, 15]],
        [512, 448, [4, 3]],
    ] as const) {
        const display = exactDisplaySize(expected);
        assert.deepEqual(display, [...expected]);
        assert.equal(display[0] * height * 6, display[1] * width * 7);
    }
});

test("native VideoFrame receives exact I420 layout and transferred ownership", () => {
    const frame = decodedFrame(1001 / 30000, 1001 / 30000);
    const originalBuffer = frame.data;
    const sample = createMovieVideoSample(frame, frame.duration, [28, 15]);
    try {
        assert.equal(originalBuffer.byteLength, 0);
        assert.equal(sample.format, "I420");
        assert.equal(sample.codedWidth, 4);
        assert.equal(sample.codedHeight, 2);
        assert.deepEqual(sample.pixelAspectRatio, { num: 14, den: 15 });
        assert.equal(sample.timestamp, 1001 / 30000);
        assert.equal(sample.duration, 1001 / 30000);
        assert.deepEqual(FakeVideoFrame.lastInit?.layout, frame.layout);
        assert.equal(FakeVideoFrame.lastInit?.timestamp, Math.round(frame.timestamp * 1e6));
        assert.equal(FakeVideoFrame.lastInit?.duration, Math.round(frame.duration * 1e6));
        assert.deepEqual(FakeVideoFrame.lastInit?.colorSpace, {
            primaries: "smpte170m",
            transfer: "smpte170m",
            matrix: "smpte170m",
            fullRange: false,
        });
    } finally {
        sample.close();
    }
});

test("accepts VideoFrame implementations that copy I420 input", () => {
    FakeVideoFrame.transfersOwnership = false;
    const frame = decodedFrame(0, 1001 / 30000);
    const originalBuffer = frame.data;
    let sample: ReturnType<typeof createMovieVideoSample> | null = null;
    try {
        sample = createMovieVideoSample(frame, frame.duration, [4, 3]);
        assert.equal(originalBuffer.byteLength, 12);
        assert.equal(sample.format, "I420");
        assert.equal(sample.codedWidth, 4);
        assert.equal(sample.codedHeight, 2);
    } finally {
        sample?.close();
        FakeVideoFrame.transfersOwnership = true;
    }
});

test("fractional decoder timelines stay exact in VideoSample wrappers", () => {
    for (const duration of [1001 / 30000, 1001 / 60000]) {
        const frame = decodedFrame(duration * 7, duration);
        const sample = createMovieVideoSample(frame, duration, [4, 3]);
        try {
            assert.equal(sample.timestamp, duration * 7);
            assert.equal(sample.duration, duration);
        } finally {
            sample.close();
        }
    }
});

test("audio final trimming is sample-accurate", () => {
    assert.equal(audioFramesWithinDuration(0.04, 48_000, 2_048, 0.05), 480);
    assert.equal(audioFramesWithinDuration(0.05, 48_000, 2_048, 0.05), 0);
    assert.equal(audioFramesWithinDuration(0, 48_000, 2_048, 1), 2_048);
});

test("AAC packets are retained or clipped to the shared export duration", () => {
    const packet = new EncodedPacket(
        new Uint8Array([1, 2, 3]),
        "key",
        0.04,
        1_024 / 48_000,
    );
    assert.equal(clipEncodedAudioPacket(packet, 0.1), packet);
    const clipped = clipEncodedAudioPacket(packet, 0.05);
    assert.notEqual(clipped, packet);
    assert.equal(clipped?.timestamp, 0.04);
    assert.ok(Math.abs((clipped?.duration ?? 0) - 0.01) < 1e-12);
    assert.equal(clipEncodedAudioPacket(packet, 0.04), null);
});

test("AAC metadata repairs invalid WebKit decoder descriptions", () => {
    const decoderConfig = {
        codec: "mp4a.40.2",
        sampleRate: 48_000,
        numberOfChannels: 2,
    };
    const invalidDescriptions = [
        undefined,
        new Uint8Array(),
        new Uint8Array([0]),
        new Uint8Array([0, 0]),
    ];
    for (const description of invalidDescriptions) {
        const meta = description === undefined
            ? undefined
            : { decoderConfig: { ...decoderConfig, description } };
        const normalized = normalizeAacMetadata(meta, 48_000, 2);
        assert.deepEqual(
            normalized.decoderConfig?.description,
            new Uint8Array([0x11, 0x90]),
        );
    }
    const valid = {
        decoderConfig: {
            ...decoderConfig,
            description: new Uint8Array([0x11, 0x90]),
        },
    };
    assert.equal(normalizeAacMetadata(valid, 48_000, 2), valid);
});

test("AAC packet timing snaps to the encoded sample grid", () => {
    const packet = new EncodedPacket(
        new Uint8Array([1]),
        "key",
        0.0400004,
        0.0213335,
    );
    const snapped = snapEncodedAudioPacket(packet, 48_000);
    assert.notEqual(snapped, packet);
    assert.equal(snapped.timestamp, 0.04);
    assert.equal(snapped.duration, 1_024 / 48_000);
    const aligned = new EncodedPacket(
        new Uint8Array([2]),
        "key",
        0.04,
        1_024 / 48_000,
    );
    assert.equal(snapEncodedAudioPacket(aligned, 48_000), aligned);
});

test("export cancellation surfaces MP4 cleanup failures", async () => {
    const failure = new Error("mux cleanup failed");
    const output = {
        state: "started",
        cancel: async () => {
            throw failure;
        },
    };
    const controller = new MovieMp4ExportController();
    controller.attachOutput(output as never);
    await assert.rejects(controller.cancel(), failure);
});

test("late output attachment propagates one cleanup failure", async () => {
    const failure = new Error("late mux cleanup failed");
    let cancelCalls = 0;
    const output = {
        state: "started",
        cancel: async () => {
            cancelCalls++;
            throw failure;
        },
    };
    const controller = new MovieMp4ExportController();
    await controller.cancel();
    controller.attachOutput(output as never);
    await assert.rejects(controller.cancel(), failure);
    assert.equal(cancelCalls, 1);
});

test("WebVTT cues are clipped to the shared export duration", () => {
    const clipped = clipMovieVtt(
        "WEBVTT\n\n1\n00:00:00.500 --> 00:00:02.000\nFirst\n\n"
            + "2\n00:00:02.500 --> 00:00:03.000\nDropped\n",
        1.25,
    );
    assert.match(clipped, /00:00:00\.500 --> 00:00:01\.250/);
    assert.doesNotMatch(clipped, /Dropped/);
});
