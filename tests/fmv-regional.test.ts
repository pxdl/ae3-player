import assert from "node:assert/strict";
import { test } from "node:test";

import {
    demuxFmv, inspectFmv, locateFmvAssets, parseFmvSubtitles,
    subtitlesToSrt, subtitlesToVtt,
} from "../src/vendor/extract/fmv.ts";
import type { OpfsCache, Vfi, VfiEntry } from "../src/vendor/extract/index.ts";
import { MovieStore } from "../src/movies.ts";
import { movieOutputFrameDuration } from "../src/movie-decoder-protocol.ts";
import { movieSourceComplete } from "../src/movie-presentation.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PRELOAD = 0x10000;
const AUDIO_BLOCK = 0x4000;

function put32(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer).setUint32(offset, value, true);
}

function movie(lanes: 1 | 5, singleLane = 0, splitPicture = false, rateCode = 3): Uint8Array {
    const video = new Uint8Array(30);
    video.set([0, 0, 1, 0xb3]);
    new DataView(video.buffer).setUint32(4, (512 << 20) | (320 << 8) | 0x10 | rateCode);
    video.set([0, 0, 1, 0xb5, 0x10, 0x08, 0, 0], 8);
    video.set([0, 0, 1, 0xb8], 16);
    video.set([0, 0, 1, 0, 0, 0x08], 20);
    video.set([0, 0, 1, 0xb7], 26);
    const firstChunks = splitPicture ? [video.subarray(0, 22), video.subarray(22)] : [video];
    const preloadStart = lanes === 5 ? 0x5800 : 0x800;
    const firstGroup = preloadStart + lanes * PRELOAD;
    const firstEnd = firstGroup + 48 + firstChunks.reduce((sum, bytes) =>
        sum + 32 + Math.ceil(bytes.length / 16) * 16, 0);
    const secondGroup = Math.ceil((firstEnd + lanes * AUDIO_BLOCK) / 0x800) * 0x800;
    const bytes = new Uint8Array(secondGroup + 48 + 64);
    bytes.set(encoder.encode("str\0"));
    put32(bytes, 4, lanes === 5 ? 1 : 0);
    put32(bytes, 8, 36);
    put32(bytes, 12, 5994); // PAL retains the transport field clock, not MPEG cadence.
    put32(bytes, 16, 2);
    put32(bytes, 0x20, 48000);
    put32(bytes, 0x24, 2);
    put32(bytes, 0x28, 0x400);
    put32(bytes, 0x2c, AUDIO_BLOCK);
    put32(bytes, 0x30, PRELOAD);
    put32(bytes, 0x34, PRELOAD + AUDIO_BLOCK);
    bytes.fill(0xff, 0x800, preloadStart); // Lane control records are not ADPCM.
    for (let lane = 0; lane < lanes; lane++) {
        const value = (lanes === 1 ? singleLane : lane) + 1;
        for (const [start, size] of [
            [preloadStart + lane * PRELOAD, PRELOAD],
            [secondGroup - lanes * AUDIO_BLOCK + lane * AUDIO_BLOCK, AUDIO_BLOCK],
        ]) {
            for (let offset = start; offset < start + size; offset += 16) {
                bytes[offset] = 0x1c;
                bytes.fill(value | (value << 4), offset + 2, offset + 16);
            }
        }
    }
    function group(offset: number, field: number, chunks: readonly Uint8Array[]): void {
        bytes.set(encoder.encode("GroupOfDataInfo"), offset);
        put32(bytes, offset + 16, field);
        put32(bytes, offset + 20, 16);
        put32(bytes, offset + 32, 18);
        put32(bytes, offset + 36, chunks.length);
        offset += 48;
        for (const chunk of chunks) {
            bytes.set(encoder.encode("Mpeg2Video"), offset);
            put32(bytes, offset + 16, field);
            put32(bytes, offset + 20, chunk.length);
            bytes.set(chunk, offset + 32);
            offset += 32 + Math.ceil(chunk.length / 16) * 16;
        }
    }
    group(firstGroup, 0, firstChunks);
    group(secondGroup, 18, [video]);
    return bytes;
}

function subtitlePair(values: readonly string[], times: readonly (readonly [number, number])[]) {
    const count = values.length;
    const names = 0x28;
    const indices = names + count * 0x28;
    const records = indices + count * 8;
    const text = records + count * 0x18;
    const strings = values.map(value => encoder.encode(`${value}\0`));
    const bin = new Uint8Array(text + strings.reduce((sum, bytes) => sum + bytes.length, 0));
    put32(bin, 0, 0x72312487);
    put32(bin, 4, count);
    [names, indices, records, text].forEach((offset, i) => put32(bin, 8 + i * 8, offset));
    let cursor = text;
    strings.forEach((bytes, i) => {
        put32(bin, records + i * 24 + 20, cursor - text);
        bin.set(bytes, cursor);
        cursor += bytes.length;
    });
    const sbt = new Uint8Array(16 + count * 16);
    const view = new DataView(sbt.buffer);
    sbt.set(encoder.encode("sbt\0"));
    put32(sbt, 4, count);
    view.setFloat32(8, times[0][0], true);
    view.setFloat32(12, times.at(-1)![1], true);
    times.forEach(([start, end], i) => {
        put32(sbt, 16 + i * 16, i);
        view.setFloat32(24 + i * 16, start, true);
        view.setFloat32(28 + i * 16, end, true);
    });
    return { bin, sbt };
}

function archive(files: readonly (readonly [string, Uint8Array])[]): Vfi {
    let sector = 1;
    const entries: VfiEntry[] = files.map(([path, bytes], i) => {
        const entry = { entryOff: 16 + i * 64, entrySize: 64, parentOff: 0,
            sector, size: bytes.length, name: path.split("/").at(-1)!, path };
        sector += Math.ceil(bytes.length / 0x800);
        return entry;
    });
    const storage = new Uint8Array(sector * 0x800);
    files.forEach(([, bytes], i) => storage.set(bytes, entries[i].sector * 0x800));
    return {
        entries,
        src: { size: storage.length, async read(offset: number, size: number) {
            return storage.slice(offset, offset + size);
        } },
        byteOffset(entry: VfiEntry) { return entry.sector * 0x800; },
        async read(entry: VfiEntry) {
            return storage.slice(entry.sector * 0x800, entry.sector * 0x800 + entry.size);
        },
        find(path: string) { return entries.find(entry => entry.path === path) ?? null; },
    } as unknown as Vfi;
}

function cache(files = new Map<string, Uint8Array>()): OpfsCache {
    return {
        key: "disc",
        async read(key: string) { return files.get(key)?.slice() ?? null; },
        async write(key: string, bytes: Uint8Array) { files.set(key, bytes.slice()); },
        async size(key: string) { return files.get(key)?.length ?? null; },
    } as unknown as OpfsCache;
}

function localizedArchive() {
    const uk = subtitlePair(["English"], [[0.01, 0.06]]);
    const fr = subtitlePair(["Français"], [[0.02, 0.07]]);
    const files: [string, Uint8Array][] = [
        ["debug/uk/movie/new_scene01.str", movie(5)],
        ["debug/uk/movie/scene01_uk.bin", uk.bin],
        ["debug/uk/movie/scene01_uk.sbt", uk.sbt],
        ["debug/uk/movie/scene01_fr.bin", fr.bin],
        ["debug/uk/movie/scene01_fr.sbt", fr.sbt],
    ];
    return { vfi: archive(files), files };
}

function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (view.getUint32(offset, true) === 0x04034b50) {
        assert.equal(view.getUint16(offset + 8, true), 0);
        const size = view.getUint32(offset + 18, true);
        const nameEnd = offset + 30 + view.getUint16(offset + 26, true);
        const start = nameEnd + view.getUint16(offset + 28, true);
        files.set(decoder.decode(bytes.subarray(offset + 30, nameEnd)), bytes.slice(start, start + size));
        offset = start + size;
    }
    return files;
}

test("PAL lane selection uses the matching preload and every end-aligned refill", () => {
    const multiplexed = movie(5);
    const selected = demuxFmv(multiplexed, "five lanes", 4);
    const reference = demuxFmv(movie(1, 4), "isolated lane");
    assert.deepEqual(selected.wav, reference.wav);
    assert.equal(new DataView(selected.wav.buffer).getInt16(44, true), 5);
    assert.deepEqual(selected.video, reference.video);
    assert.throws(() => demuxFmv(multiplexed, "five lanes", 5), /audio lane/);
    assert.throws(() => demuxFmv(movie(1), "one lane", 1), /audio lane/);
    multiplexed[0x5800 + PRELOAD * 3] = 0xf0;
    assert.throws(() => demuxFmv(multiplexed, "bad unselected lane", 0), /ADPCM filter/);
});

test("presentation cadence follows MPEG pictures across STR chunks, not the field clock", () => {
    const pal = inspectFmv(movie(5, 0, true));
    assert.equal(pal.header.fieldRate, 59.94);
    assert.equal(pal.duration, 2 / 25);
    assert.equal(movieOutputFrameDuration("progressive", pal.videoInfo.frameRate), 0.04);
    assert.equal(movieOutputFrameDuration("tt", pal.videoInfo.frameRate), 0.02);
    const ntsc = inspectFmv(movie(1, 0, false, 4));
    assert.equal(ntsc.duration, 2 / (30000 / 1001));
    assert.equal(movieOutputFrameDuration("bb", ntsc.videoInfo.frameRate), 1001 / 60000);
});

test("localized sidecars remain source-qualified and incomplete pairs are not ignored", () => {
    const fixture = localizedArchive();
    const secondMovie = ["debug/fr/movie/new_scene01.str", movie(1)] as const;
    const assets = locateFmvAssets(archive([...fixture.files, secondMovie]));
    assert.deepEqual(assets.map(asset => asset.name), [
        "debug/fr/movie/new_scene01", "debug/uk/movie/new_scene01",
    ]);
    const localized = assets[1];
    assert.ok(!("formatError" in localized));
    assert.deepEqual(localized.subtitles.map(track => track.language), ["fra", "eng"]);
    const incomplete = locateFmvAssets(archive(fixture.files.filter(([path]) => !path.endsWith("_fr.sbt"))));
    assert.ok("formatError" in incomplete[0]);
});

test("UTF-8 blank caption intervals retain cue alignment without invalid SRT/VTT blocks", () => {
    // Both PAL images contain this U+3000 blank interval in a localized SBT/BIN pair.
    const { bin, sbt } = subtitlePair(["Ça va ?", "\u3000", "Très bien."], [
        [1, 2], [10.572, 12.072], [13, 14],
    ]);
    const cues = parseFmvSubtitles(bin, sbt);
    assert.deepEqual(cues.map(cue => [cue.index, cue.text]), [[1, "Ça va ?"], [2, ""], [3, "Très bien."]]);
    assert.equal(cues[1].start, Math.fround(10.572));
    assert.equal(cues[2].start, 13);
    assert.match(decoder.decode(subtitlesToSrt(cues)), /3\n00:00:13,000 --> 00:00:14,000\nTrès bien\./);
    assert.doesNotMatch(decoder.decode(subtitlesToVtt(cues)), /\n\n2\n/);
    const invalid = bin.slice();
    invalid[invalid.length - 2] = 0xff;
    assert.throws(() => parseFmvSubtitles(invalid, sbt), /strict UTF-8/);
});

test("source cache and archives preserve every caption language and the selected audio master", async () => {
    const fixture = localizedArchive();
    const storage = cache();
    const store = new MovieStore(storage, fixture.vfi, "disc");
    const catalog = await store.catalog();
    assert.equal(catalog!.issues.length, 0);
    const entry = catalog!.entries[0];
    assert.deepEqual(entry.audioTracks.map(track => track.language), ["eng", "deu", "spa", "fra", "ita"]);
    const selection = { audioTrack: 4, subtitleId: "scene01_fr" };
    await store.prepare(entry.name, () => {}, undefined, selection);
    const offline = new MovieStore(storage, null, "disc");
    const prepared = await offline.prepare(entry.name, () => {}, undefined, selection);
    assert.equal(new DataView(prepared.wav.buffer).getInt16(44, true), 5);
    assert.equal(prepared.subtitleTracks.find(track => track.id === "scene01_fr")!.cues[0].start, Math.fround(0.02));
    assert.equal(movieSourceComplete(entry, prepared.cache), true);
    assert.equal(movieSourceComplete(entry, { ...prepared.cache,
        sourceBytes: entry.movie.size + entry.subtitleBytes - 1 }), false);
    const original = unzipStored((await offline.export(entry.name, "original", false, () => {})).bytes);
    for (const [path, bytes] of fixture.files) assert.deepEqual(original.get(path.split("/").at(-1)!), bytes);
    const masters = unzipStored((await offline.export(entry.name, "masters", true, () => {}, undefined, selection)).bytes);
    assert.deepEqual(masters.get("new_scene01-lane-4-ita.wav"), prepared.wav);
    assert.deepEqual(masters.get("new_scene01.m2v"), prepared.video);
    assert.ok(masters.has("new_scene01_fr.srt") && masters.has("new_scene01_uk.srt"));
});

test("malformed and obsolete movie catalogs rebuild without disabling writable cache", async () => {
    const { vfi } = localizedArchive();
    for (const stale of ["{", JSON.stringify({ v: 3, sourceKey: "disc", entries: [], issues: [] })]) {
        const files = new Map([["movie_meta.json", encoder.encode(stale)]]);
        const storage = cache(files);
        await assert.rejects(new MovieStore(storage, null, "disc").catalog(), /reconnect the same disc/);
        const attached = new MovieStore(storage, vfi, "disc");
        const rebuilt = await attached.catalog();
        assert.equal(attached.persistenceWarning, null);
        assert.deepEqual(await new MovieStore(storage, null, "disc").catalog(), rebuilt);
        const entry = rebuilt!.entries[0];
        await attached.prepare(entry.name, () => {});
        const sourceMeta = [...files.keys()].find(key => key.endsWith("/source_meta.json"))!;
        files.set(sourceMeta, encoder.encode("{"));
        assert.equal((await attached.cacheInfo(entry.name)).sourceBytes, 0);
        assert.equal(attached.persistenceWarning, null);
        await attached.prepare(entry.name, () => {});
        const restored = await new MovieStore(storage, null, "disc").prepare(entry.name, () => {});
        assert.equal(movieSourceComplete(entry, restored.cache), true);
    }
});
