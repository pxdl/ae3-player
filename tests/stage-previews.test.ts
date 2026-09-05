import assert from "node:assert/strict";
import { test } from "node:test";

import { isStagePreviewDecoderResponse } from "../src/stage-preview-decoder-protocol.ts";
import {
    parseStagePreviewArchive,
    StagePreviewStore,
} from "../src/stage-previews.ts";
import {
    inspectIpc,
    ipcToIpum,
    parsePackfile,
    type Vfi,
    type VfiEntry,
    type OpfsCache,
} from "../src/vendor/extract/index.ts";

const PACK_HEADER_SIZE = 0x40;
const MEMBER_HEADER_SIZE = 0x30;
const SLOT_SIZE = 0x400;
const encoder = new TextEncoder();

function setU16(data: Uint8Array, offset: number, value: number): void {
    new DataView(data.buffer, data.byteOffset, data.byteLength)
        .setUint16(offset, value, true);
}

function setU32(data: Uint8Array, offset: number, value: number): void {
    new DataView(data.buffer, data.byteOffset, data.byteLength)
        .setUint32(offset, value, true);
}

function makeIpc(frameByte = 0x49): Uint8Array {
    const ipc = new Uint8Array(0x20);
    ipc.set(encoder.encode("ipc\0"));
    setU16(ipc, 4, 1);
    setU16(ipc, 6, 0x1004);
    setU16(ipc, 8, 256);
    setU16(ipc, 10, 256);
    setU16(ipc, 12, 0x62);
    setU16(ipc, 14, 1);
    ipc[0x10] = frameByte;
    ipc.set([0, 0, 1, 0xb0], 0x14);
    return ipc;
}

function makeTim2(red = 0x10): Uint8Array {
    const tim2 = new Uint8Array(0x44);
    tim2.set(encoder.encode("TIM2"));
    tim2[4] = 4;
    setU16(tim2, 6, 1);
    setU32(tim2, 0x10, 0x34);
    setU32(tim2, 0x18, 4);
    setU16(tim2, 0x1c, 0x30);
    tim2[0x21] = 1;
    tim2[0x23] = 3;
    setU16(tim2, 0x24, 1);
    setU16(tim2, 0x26, 1);
    tim2.set([red, 0x20, 0x30, 0x80], 0x40);
    return tim2;
}

function makeStagePack(frameOrder: readonly number[] = [3, 0, 7, 2, 1, 6, 5, 4],
                       frameByte = 0x49, titleByte = 0x10): Uint8Array {
    const archive = new Uint8Array(PACK_HEADER_SIZE + SLOT_SIZE);
    archive.set(encoder.encode("packfile"));
    setU32(archive, 0x10, 1);
    setU32(archive, 0x14, SLOT_SIZE);

    let offset = PACK_HEADER_SIZE;
    const member = (kind: string, name: string, payload: Uint8Array): void => {
        archive.set(encoder.encode(kind), offset);
        setU32(archive, offset + 4, payload.length);
        archive.set(encoder.encode(name), offset + 0x10);
        archive.set(payload, offset + MEMBER_HEADER_SIZE);
        offset += MEMBER_HEADER_SIZE + payload.length;
    };
    for (const frame of frameOrder)
        member("ipc", `tv_test_${frame.toString().padStart(2, "0")}`, makeIpc(frameByte));
    member("tm2", "tv_test_t", makeTim2(titleByte));
    archive.set(encoder.encode("end\0"), offset);
    return archive;
}

function localizedStages(): { vfi: Vfi; files: Map<string, Uint8Array> } {
    const files = new Map([
        ["debug/de/etc/warpgate/str/stages.bin", makeStagePack(undefined, 0x31, 0x41)],
        ["debug/fr/etc/warpgate/str/stages.bin", makeStagePack(undefined, 0x32, 0x42)],
    ]);
    const entries = [...files].map(([path, bytes], index): VfiEntry => ({
        entryOff: index * 0x20, entrySize: 0x20, parentOff: 0,
        sector: index, size: bytes.length, name: "stages.bin", path,
    }));
    const vfi = {
        entries,
        async read(entry: VfiEntry) { return files.get(entry.path)!.slice(); },
    } as unknown as Vfi;
    return { vfi, files };
}

function stageCache(files = new Map<string, Uint8Array>()): OpfsCache {
    return {
        key: "disc",
        async read(name: string) { return files.get(name)?.slice() ?? null; },
        async size(name: string) { return files.get(name)?.length ?? null; },
        async write(name: string, bytes: Uint8Array) { files.set(name, bytes.slice()); },
    } as unknown as OpfsCache;
}

test("localized stage archives keep identical slot names separate through selection and cached exports", async () => {
    const { vfi, files } = localizedStages();
    const cache = stageCache();
    const store = new StagePreviewStore(cache, vfi, "disc");
    for (const reader of [store, new StagePreviewStore(cache, null, "disc")]) {
        const catalog = await reader.catalog();
        assert.ok(catalog);
        assert.deepEqual(catalog.archives.map(archive => archive.sourcePath), [...files.keys()]);
        assert.equal(new Set(catalog.archives.map(archive => archive.stages[0]!.id)).size, 2);
        for (const [index, archive] of catalog.archives.entries()) {
            const stage = archive.stages[0]!;
            assert.deepEqual(stage.frames.map(frame => frame.frame), [0, 1, 2, 3, 4, 5, 6, 7]);
            for (const frame of stage.frames)
                assert.deepEqual(await reader.readFrame(frame), makeIpc(0x31 + index));
            assert.deepEqual(await reader.readTitle(stage.title), makeTim2(0x41 + index));
            assert.deepEqual(await reader.readArchive(archive.sourcePath), files.get(archive.sourcePath));
        }
    }
});

for (const [state, metadata] of [
    ["obsolete", '{"v":1,"sourcePath":"debug/de/etc/warpgate/str/stages.bin"}'],
    ["malformed", '{"v":2,'],
    ["invalid schema", '{"v":2,"sourceKey":"disc","archives":[]}'],
] as const) {
    test(`${state} stage catalogs rebuild all sources without disabling cache`, async () => {
        const { vfi, files } = localizedStages();
        const cache = stageCache(new Map([
            ["stage-previews/catalog.json", encoder.encode(metadata)],
            ["stage-previews/stages.bin", files.values().next().value!],
        ]));
        await new StagePreviewStore(cache, vfi, "disc").catalog();
        const resumed = new StagePreviewStore(cache, null, "disc");
        const catalog = await resumed.catalog();
        assert.ok(catalog);
        assert.deepEqual(catalog.archives.map(archive => archive.sourcePath), [...files.keys()]);
        for (const archive of catalog.archives)
            assert.deepEqual(await resumed.readArchive(archive.sourcePath), files.get(archive.sourcePath));
    });
}

test("cache-only stage metadata corruption requests the same ISO", async () => {
    const cache = stageCache(new Map([["stage-previews/catalog.json", encoder.encode("{")]]));
    await assert.rejects(new StagePreviewStore(cache, null, "disc").catalog(), /reconnect the same disc/);
});

test("stage source exports reject another language's same-size cached bytes", async () => {
    const { vfi, files } = localizedStages();
    const saved = new Map<string, Uint8Array>();
    const cache = stageCache(saved);
    const catalog = await new StagePreviewStore(cache, vfi, "disc").catalog();
    assert.ok(catalog);
    const [de, fr] = catalog.archives;
    saved.set(`stage-previews-v2/${de!.sourcePath}`, files.get(fr!.sourcePath)!);
    const resumed = new StagePreviewStore(cache, null, "disc");
    await assert.rejects(resumed.readArchive(de!.sourcePath), /content does not match the catalog/);
    assert.deepEqual(await resumed.readArchive(fr!.sourcePath), files.get(fr!.sourcePath));
});


test("stage archive validates members and restores authored frame order", async () => {
    const parsed = await parseStagePreviewArchive(makeStagePack(), "regional/stages.bin");
    assert.equal(parsed.catalog.sourcePath, "regional/stages.bin");
    assert.equal(parsed.catalog.slotCount, 1);
    assert.equal(parsed.catalog.stages.length, 1);
    const stage = parsed.catalog.stages[0]!;
    assert.equal(stage.key, "test");
    assert.deepEqual(stage.frames.map(frame => frame.frame), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(stage.frames[0]!.ipc.ipuFlags, 0x62);
    assert.deepEqual(stage.title.picture, {
        index: 0,
        width: 1,
        height: 1,
        imageType: 3,
        clutType: 0,
        colorCount: 0,
        mipmapCount: 1,
    });
});

test("IPC bridge preserves the macroblock stream and inserts the control byte", () => {
    const ipc = makeIpc(0x49);
    const info = inspectIpc(ipc);
    const ipum = ipcToIpum(ipc);
    assert.equal(info.control, 0x62);
    assert.equal(info.frameDataSize, 8);
    assert.equal(ipum[0x10], 0x62);
    assert.equal(ipum[0x11], 0x49);
    assert.deepEqual(ipum.subarray(-4), new Uint8Array([0, 0, 1, 0xb0]));
});

test("stage archive rejects duplicate frames, member overrun, and nonzero padding", async () => {
    const duplicate = makeStagePack([0, 1, 2, 3, 4, 5, 6, 6]);
    await assert.rejects(parseStagePreviewArchive(duplicate), /repeats frame 06/);

    const overrun = makeStagePack();
    setU32(overrun, PACK_HEADER_SIZE + 4, 0xffff_ffff);
    await assert.rejects(parseStagePreviewArchive(overrun), /exceeds its packfile slot/);

    const padded = makeStagePack();
    padded[padded.length - 1] = 1;
    await assert.rejects(parseStagePreviewArchive(padded), /nonzero data after end/);
});

test("IPC validation rejects missing, repeated, and padded frame delimiters", () => {
    const missing = makeIpc();
    missing.fill(0, 0x14, 0x18);
    assert.throws(() => inspectIpc(missing), /contains 0 IPU frame delimiters/);

    const repeated = makeIpc();
    repeated.set([0, 0, 1, 0xb0], 0x18);
    assert.throws(() => inspectIpc(repeated), /contains 2 IPU frame delimiters/);

    const padded = makeIpc();
    padded[0x1f] = 1;
    assert.throws(() => inspectIpc(padded), /nonzero data after its frame delimiter/);
});

test("packfile rejects malformed compressed slot metadata", async () => {
    const archive = new Uint8Array(PACK_HEADER_SIZE + 0x20);
    archive.set(encoder.encode("packfile"));
    setU32(archive, 0x10, 1);
    setU32(archive, 0x14, SLOT_SIZE);
    setU32(archive, 0x18, 0x20);
    setU32(archive, archive.length - 0x10, 9);
    await assert.rejects(parsePackfile(archive), /invalid compressed size 9/);
});

test("missing regional stage archive is a soft unavailable result", async () => {
    const vfi = { entries: [] } as unknown as Vfi;
    const store = new StagePreviewStore(null, vfi, "disc");
    assert.equal(store.hasIso(), true);
    assert.equal(await store.catalog(), null);
});

test("decoder protocol rejects malformed worker payloads", () => {
    assert.equal(isStagePreviewDecoderResponse({
        type: "decoded",
        requestId: 1,
        generation: 2,
        width: 256,
        height: 256,
        rgba: new ArrayBuffer(256 * 256 * 4),
    }), true);
    assert.equal(isStagePreviewDecoderResponse({
        type: "decoded",
        requestId: 1,
        generation: 2,
        width: 16,
        height: 16,
        rgba: new ArrayBuffer(4),
    }), false);
    assert.equal(isStagePreviewDecoderResponse({
        type: "error",
        requestId: 1,
        generation: 2,
        stage: "unknown",
        message: "bad",
    }), false);
});
