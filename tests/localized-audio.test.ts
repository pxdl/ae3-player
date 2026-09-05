import assert from "node:assert/strict";
import { test } from "node:test";

import { SeStore } from "../src/se.ts";
import { StreamStore, groupStreams } from "../src/streams.ts";
import { BytesSource, Vfi, type OpfsCache } from "../src/vendor/extract/index.ts";

const encoder = new TextEncoder();

function memoryCache(files = new Map<string, Uint8Array>()): OpfsCache {
    return {
        key: "disc",
        async read(name: string) { return files.get(name)?.slice() ?? null; },
        async size(name: string) { return files.get(name)?.byteLength ?? null; },
        async write(name: string, bytes: Uint8Array) { files.set(name, bytes.slice()); },
    } as unknown as OpfsCache;
}

// Real VFI records and sector windows, including a VFI nested in stream.bin.
function makeVfi(files: readonly (readonly [string, Uint8Array])[]): Uint8Array {
    const names = files.map(([name]) => encoder.encode(name));
    const recordSizes = names.map(name => Math.ceil((12 + name.length + 1) / 4) * 4);
    const dataSector = Math.ceil((0x20 + recordSizes.reduce((sum, size) => sum + size, 0)) / 0x800);
    const sectors = files.map(([, bytes]) => Math.ceil(bytes.length / 0x800));
    const bytes = new Uint8Array((dataSector + sectors.reduce((sum, size) => sum + size, 0)) * 0x800);
    const view = new DataView(bytes.buffer);
    bytes.set(encoder.encode("VFI\0"));
    view.setUint32(4, 1, true);
    view.setUint32(8, dataSector, true);
    view.setUint16(0x10, files.length, true);
    view.setUint32(0x14, 0x20, true);
    let record = 0x20;
    let sector = dataSector;
    files.forEach(([, data], index) => {
        view.setUint16(record, recordSizes[index]!, true);
        view.setUint32(record + 4, sector, true);
        view.setUint32(record + 8, data.length, true);
        bytes.set(names[index]!, record + 12);
        bytes.set(data, sector * 0x800);
        record += recordSizes[index]!;
        sector += sectors[index]!;
    });
    view.setUint32(0x1c, record, true);
    return bytes;
}

function makeStream(value: number): Uint8Array {
    const bytes = new Uint8Array(0x78 + 0x800);
    bytes.set(encoder.encode("EXST"));
    const view = new DataView(bytes.buffer);
    view.setUint16(6, 1, true);
    view.setUint32(8, 22050, true);
    view.setUint32(0x14, 1, true);
    bytes.fill(value, 0x78);
    return bytes;
}

test("loose subdirectories and localized nested VFI streams retain distinct bytes after cache resume", async () => {
    const de = makeStream(0x31);
    const fr = makeStream(0x72);
    const loose = makeStream(0x19);
    const minigame = makeStream(0x24);
    const dePath = "debug/de/sound/stream.bin/phone_001.x";
    const frPath = "debug/fr/sound/stream.bin/phone_001.x";
    const loosePath = "debug/uk/sound/stream/voice/phone_001.x";
    const minigamePath = "debug/uk/sound/stream/mgs_01.x";
    const vfi = await Vfi.open(new BytesSource(makeVfi([
        ["debug/de/sound/stream.bin", makeVfi([["phone_001.x", de]])],
        ["debug/fr/sound/stream.bin", makeVfi([["phone_001.x", fr]])],
        [loosePath, loose],
        [minigamePath, minigame],
    ])));
    const cache = memoryCache();
    const store = new StreamStore(cache, vfi, "disc");
    const catalog = await store.extract(() => {});
    const expected = new Map([[dePath, de], [frPath, fr], [loosePath, loose], [minigamePath, minigame]]);
    assert.deepEqual(new Set(catalog.entries.map(entry => entry.name)), new Set(expected.keys()));
    assert.deepEqual(groupStreams(catalog.entries).voice.find(group => group.key === "phone")?.entries.map(entry => entry.name), [dePath, frPath, loosePath]);
    for (const entry of catalog.entries)
        assert.deepEqual(await store.read(entry.name), expected.get(entry.name));
    await assert.rejects(store.read("phone_001.x"), /source path is invalid/);

    const resumed = new StreamStore(cache, null, "disc");
    const restored = await resumed.cached();
    assert.ok(restored);
    for (const entry of restored.entries)
        assert.deepEqual(await resumed.read(entry.name), expected.get(entry.name));
});

test("Effects pair only within the same source directory and preserve localized banks in cache", async () => {
    const de = "debug/de/sound/se/voice";
    const fr = "debug/fr/sound/se/voice";
    const files = new Map([
        [`${de}.hd`, Uint8Array.of(1, 2, 3)],
        [`${de}.bd`, Uint8Array.of(4, 5, 6)],
        [`${fr}.hd`, Uint8Array.of(7, 8, 9)],
        [`${fr}.bd`, Uint8Array.of(10, 11, 12)],
        ["debug/de/sound/se/orphan.hd", Uint8Array.of(13)],
        ["debug/fr/sound/se/orphan.bd", Uint8Array.of(14)],
    ]);
    const vfi = await Vfi.open(new BytesSource(makeVfi([...files])));
    const cache = memoryCache();
    const store = new SeStore(cache, vfi, "disc");
    const catalog = await store.extract(() => {});
    assert.deepEqual(catalog.entries.map(entry => entry.name), [de, fr]);
    for (const entry of catalog.entries) {
        const bank = await store.bank(entry);
        assert.deepEqual(bank.hd, files.get(entry.hd));
        assert.deepEqual(bank.bd, files.get(entry.bd));
    }
    const resumed = new SeStore(cache, null, "disc");
    const restored = await resumed.cached();
    assert.ok(restored);
    for (const entry of restored.entries) {
        const bank = await resumed.bank(entry);
        assert.deepEqual(bank.hd, files.get(entry.hd));
        assert.deepEqual(bank.bd, files.get(entry.bd));
    }
});

for (const [state, metadata] of [
    ["obsolete", '{"v":2,"sourceKey":"disc","entries":[]}'],
    ["malformed", '{"v":3,'],
    ["invalid schema", '{"v":3,"sourceKey":"disc","entries":[]}'],
] as const) {
    test(`${state} audio catalogs rebuild into the still-writable cache`, async () => {
        const streamPath = "debug/us/sound/stream/phone_001.x";
        const stream = makeStream(0x51);
        const hdPath = "debug/us/sound/se/voice.hd";
        const bdPath = "debug/us/sound/se/voice.bd";
        const hd = Uint8Array.of(1, 2);
        const bd = Uint8Array.of(3, 4);
        const vfi = await Vfi.open(new BytesSource(makeVfi([[streamPath, stream], [hdPath, hd], [bdPath, bd]])));
        const cache = memoryCache(new Map([
            ["stream_meta.json", encoder.encode(metadata)],
            ["se_meta.json", encoder.encode(metadata)],
        ]));
        const streams = new StreamStore(cache, vfi, "disc");
        const effects = new SeStore(cache, vfi, "disc");
        assert.equal(await streams.cached(), null);
        assert.equal(await effects.cached(), null);
        await streams.extract(() => {});
        await effects.extract(() => {});
        const resumedStreams = new StreamStore(cache, null, "disc");
        const resumedEffects = new SeStore(cache, null, "disc");
        const streamCatalog = await resumedStreams.cached();
        const seCatalog = await resumedEffects.cached();
        assert.ok(streamCatalog);
        assert.ok(seCatalog);
        assert.deepEqual(await resumedStreams.read(streamCatalog.entries[0]!.name), stream);
        assert.deepEqual(await resumedEffects.bank(seCatalog.entries[0]!), { hd, bd });
    });
}

test("cache-only malformed audio catalogs require same-disc reattachment", async () => {
    const cache = memoryCache(new Map([
        ["stream_meta.json", encoder.encode("{")],
        ["se_meta.json", encoder.encode("{")],
    ]));
    await assert.rejects(new StreamStore(cache, null, "disc").cached(), /reconnect the same disc/);
    await assert.rejects(new SeStore(cache, null, "disc").cached(), /reconnect the same disc/);
});
