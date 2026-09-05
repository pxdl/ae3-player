import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import {
    filterImageEntries,
    imageEntries,
    imageExportPath,
    sortImageEntries,
    imageTreePath,
    ImageStore,
    type ImageCatalog,
} from "../src/images.ts";
import { storeZip, storeZipBlob } from "../src/zip.ts";
import { fingerprintBytes } from "../src/content-identity.ts";
import { scanImageTextures } from "../src/vendor/extract/images.ts";
import type { OpfsCache } from "../src/vendor/extract/opfs.ts";
import type { Vfi, VfiEntry } from "../src/vendor/extract/vfi.ts";

const catalog: ImageCatalog = {
    v: 5,
    sourceKey: "disc",
    storage: "containers",
    textures: [
        {
            id: "00000010-direct",
            sourcePath: "debug/us/static/logo.tm2",
            memberIndex: null,
            memberName: null,
            fileName: "logo.tm2",
            attrs: "tm2",
            byteLength: 128,
            role: "other",
            roleEvidence: "direct",
            pictures: [
                { index: 0, width: 64, height: 32, imageType: 5,
                  clutType: 3, colorCount: 256, mipmapCount: 1 },
            ],
        },
        {
            id: "00000020-3",
            sourcePath: "debug/us/stage/zero/ui.pck.sz",
            memberIndex: 3,
            memberName: "cursor",
            fileName: "cursor.tm2",
            attrs: "tm2 pictname=cursor",
            byteLength: 256,
            role: "sprite",
            roleEvidence: "ui-reference",
            pictures: [
                { index: 0, width: 16, height: 16, imageType: 4,
                  clutType: 3, colorCount: 16, mipmapCount: 1 },
                { index: 1, width: 8, height: 8, imageType: 4,
                  clutType: 3, colorCount: 16, mipmapCount: 1 },
            ],
        },
    ],
    sources: [
        {
            entryOffset: 0x10,
            sourcePath: "debug/us/static/logo.tm2",
            bytes: 128,
            sha256: "0".repeat(64),
        },
        {
            entryOffset: 0x20,
            sourcePath: "debug/us/stage/zero/ui.pck.sz",
            bytes: 256,
            sha256: "1".repeat(64),
        },
    ],
    issues: [],
    skipped: [],
};

test("image catalog expands every TIM2 picture", () => {
    const entries = imageEntries(catalog);
    assert.deepEqual(entries.map(entry => [entry.id, entry.width, entry.height]), [
        ["00000010-direct:0", 64, 32],
        ["00000020-3:0", 16, 16],
        ["00000020-3:1", 8, 8],
    ]);
});

test("image export paths preserve package hierarchy and picture identity", () => {
    const entries = imageEntries(catalog);
    assert.equal(imageExportPath(entries[0]!, "png"),
                 "debug/us/static/logo.png");
    assert.equal(imageExportPath(entries[1]!, "png"),
                 "debug/us/stage/zero/ui/cursor_0.png");
    assert.equal(imageExportPath(entries[2]!, "tm2"),
                 "debug/us/stage/zero/ui/cursor_1.tm2");
});
test("image export paths reject untrusted source and member names", () => {
    const direct = imageEntries(catalog)[0]!;
    const unsafe = [
        { ...direct, texture: {
            ...direct.texture,
            fileName: "../escape.tm2",
        } },
        { ...direct, texture: {
            ...direct.texture,
            sourcePath: "/absolute/logo.tm2",
        } },
        { ...direct, texture: {
            ...direct.texture,
            sourcePath: "logo.tm2",
            fileName: "C:/escape.tm2",
        } },
        { ...direct, texture: {
            ...direct.texture,
            fileName: "\\\\server\\share\\escape.tm2",
        } },
        { ...direct, texture: {
            ...direct.texture,
            fileName: "bad\0name.tm2",
        } },
    ];
    for (const entry of unsafe)
        assert.throws(() => imageExportPath(entry, "png"), /ZIP entry path/);
});


test("image filters use semantic roles and source metadata", () => {
    const entries = imageEntries(catalog);
    assert.deepEqual(filterImageEntries(entries, "", "sprite").map(entry => entry.id),
                     ["00000020-3:0", "00000020-3:1"]);
    assert.deepEqual(filterImageEntries(entries, "ZERO", "all").map(entry => entry.id),
                     ["00000020-3:0", "00000020-3:1"]);
    assert.deepEqual(filterImageEntries(entries, "logo", "sprite"), []);
});

test("image sorting is stable across category subsets and picture rows", () => {
    const entries = imageEntries(catalog);
    assert.deepEqual(sortImageEntries(entries, "asc").map(entry => entry.id), [
        "00000020-3:0",
        "00000020-3:1",
        "00000010-direct:0",
    ]);
    assert.deepEqual(sortImageEntries(entries, "desc").map(entry => entry.id), [
        "00000010-direct:0",
        "00000020-3:0",
        "00000020-3:1",
    ]);
    const sprites = filterImageEntries(entries, "", "sprite");
    assert.deepEqual(sortImageEntries(sprites, "desc").map(entry => entry.id), [
        "00000020-3:0",
        "00000020-3:1",
    ]);
    assert.deepEqual(entries.map(entry => entry.id), [
        "00000010-direct:0",
        "00000020-3:0",
        "00000020-3:1",
    ]);
});

test("image tree paths retain source packages", () => {
    const entries = imageEntries(catalog);
    assert.equal(imageTreePath(entries[0]!), "debug/us/static/logo.tm2");
    assert.equal(imageTreePath(entries[1]!),
                 "debug/us/stage/zero/ui.pck.sz/cursor_0.tm2");
});

test("large image ZIP uses valid store-only Blob parts", async () => {
    const blob = storeZipBlob([
        ["a.bin", Uint8Array.of(1, 2, 3)],
        ["nested/b.bin", Uint8Array.of(4, 5)],
    ]);
    assert.equal(blob.type, "application/zip");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint16(6, true), 0x0800);
    assert.equal(new TextDecoder().decode(bytes.subarray(30, 35)), "a.bin");
    assert.deepEqual([...bytes.subarray(35, 38)], [1, 2, 3]);
    assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
    assert.equal(view.getUint16(bytes.length - 14, true), 2);
});
test("every ZIP writer rejects non-canonical or unsafe entry paths", () => {
    const payload = Uint8Array.of(1);
    const unsafe = [
        "",
        "/absolute.bin",
        "C:/drive.bin",
        "\\\\server\\share\\file.bin",
        "dir\\file.bin",
        "file:alternate-stream.bin",
        "dir/../escape.bin",
        "dir/./file.bin",
        "dir//file.bin",
        "nul\0file.bin",
        "control\u001ffile.bin",
        "e\u0301.bin",
        `${"a".repeat(256)}.bin`,
        `${Array.from({ length: 20 }, () => "a".repeat(220)).join("/")}.bin`,
        "\ud800.bin",
    ];
    const writers = [
        (path: string): unknown => storeZip([[path, payload]]),
        (path: string): unknown => storeZipBlob([[path, payload]]),
    ];
    for (const writer of writers) {
        for (const path of unsafe)
            assert.throws(() => writer(path), /ZIP entry path/);
    }
});

test("byte-array ZIP rejects entry counts beyond ZIP32", () => {
    const empty = new Uint8Array();
    const entries: [string, Uint8Array][] = Array.from(
        { length: 0x10000 },
        (_, index) => [`f${index}`, empty],
    );
    assert.throws(
        () => storeZip(entries),
        /ZIP32 supports at most 65535/,
    );
});

function makeImageTim2(): Uint8Array {
    const bytes = new Uint8Array(0x44);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("TIM2"));
    bytes[4] = 4;
    bytes[6] = 1;
    view.setUint32(0x10, 0x34, true);
    view.setUint32(0x18, 4, true);
    view.setUint16(0x1c, 0x30, true);
    bytes[0x21] = 1;
    bytes[0x23] = 3;
    view.setUint16(0x24, 1, true);
    view.setUint16(0x26, 1, true);
    bytes.set([12, 34, 56, 128], 0x40);
    return bytes;
}

function makeImagePck(members: readonly {
    name: string;
    attrs: string;
    data: Uint8Array;
}[]): Uint8Array {
    const encoder = new TextEncoder();
    let offset = 12 + members.length * 16;
    const records = members.map(member => {
        const name = encoder.encode(`${member.name}\0`);
        const attrs = encoder.encode(`${member.attrs}\0`);
        const nameOffset = offset;
        const attrsOffset = nameOffset + name.length;
        const dataOffset = attrsOffset + attrs.length;
        offset = dataOffset + member.data.length;
        return { ...member, name, attrs, nameOffset, attrsOffset, dataOffset };
    });
    const bytes = new Uint8Array(offset);
    const view = new DataView(bytes.buffer);
    bytes.set([0x50, 0x43, 0x4b, 0]);
    view.setUint32(4, 12, true);
    view.setUint32(8, records.length, true);
    for (const [index, member] of records.entries()) {
        const row = 12 + index * 16;
        view.setUint32(row, member.nameOffset, true);
        view.setUint32(row + 4, member.attrsOffset, true);
        view.setUint32(row + 8, member.dataOffset, true);
        view.setUint32(row + 12, member.data.length, true);
        bytes.set(member.name, member.nameOffset);
        bytes.set(member.attrs, member.attrsOffset);
        bytes.set(member.data, member.dataOffset);
    }
    return bytes;
}

function imageSourceFixture(files: readonly [string, Uint8Array][]): Vfi {
    const entries: VfiEntry[] = files.map(([path, data], index) => ({
        entryOff: (index + 1) * 0x10,
        entrySize: 16,
        parentOff: 0,
        sector: index,
        size: data.length,
        name: path.slice(path.lastIndexOf("/") + 1),
        path,
    }));
    return {
        entries,
        async read(entry: VfiEntry): Promise<Uint8Array> {
            return files[entries.indexOf(entry)]![1];
        },
    } as unknown as Vfi;
}

function imageCacheFixture(files = new Map<string, Uint8Array>()): OpfsCache {
    return {
        key: "disc",
        async read(name: string): Promise<Uint8Array | null> {
            return files.get(name)?.slice() ?? null;
        },
        async write(name: string, bytes: Uint8Array): Promise<void> {
            files.set(name, bytes.slice());
        },
    } as unknown as OpfsCache;
}

test("image extraction inflates once while preserving declared skips and magic-discovered images",
     async context => {
    const image = makeImageTim2();
    const pck = makeImagePck([
        { name: "sprite", attrs: "tm2", data: image },
        { name: "sprite", attrs: "tm2", data: new Uint8Array(16) },
        { name: "embedded", attrs: "bin", data: image },
    ]);
    const zlib = deflateSync(pck);
    const stored = new Uint8Array(4 + zlib.length - 2);
    new DataView(stored.buffer).setUint32(0, pck.length, true);
    stored.set(zlib.subarray(2), 4);
    const sourcePath = "debug/test/ui.pck.sz";
    const vfi = imageSourceFixture([[sourcePath, stored]]);
    const cache = imageCacheFixture();
    let inflations = 0;
    context.mock.method(globalThis, "DecompressionStream",
        new Proxy(DecompressionStream, {
            construct(target, args) {
                inflations++;
                return Reflect.construct(target, args);
            },
        }));

    const extracted = await new ImageStore(cache, vfi, "disc").extract(() => {});
    assert.equal(inflations, 1);
    assert.deepEqual(extracted.textures.map(texture => [texture.id, texture.fileName]), [
        ["00000010-0", "sprite.tm2"],
        ["00000010-2", "embedded.bin"],
    ]);
    assert.deepEqual(extracted.skipped, [{
        entryOffset: 0x10,
        sourcePath,
        memberIndex: 1,
        fileName: "sprite.001.tm2",
        byteLength: 16,
        reason: "missing-tim2-magic",
    }]);
    assert.deepEqual(extracted.issues, []);
    assert.deepEqual(extracted.sources, [{
        entryOffset: 0x10, sourcePath, ...await fingerprintBytes(stored),
    }]);
    const offline = new ImageStore(cache, null, "disc");
    const restored = await offline.cached();
    assert.ok(restored);
    for (const texture of restored.textures)
        assert.deepEqual(await offline.read(texture), image);
});

test("a malformed TIM2 does not erase another member's declared-skip diagnostic", async () => {
    const brokenImage = makeImageTim2().subarray(0, 16);
    const brokenPackage = makeImagePck([
        { name: "absent", attrs: "tm2", data: new Uint8Array(16) },
        { name: "broken", attrs: "tm2", data: brokenImage },
    ]);
    const skippedOnly = makeImagePck([
        { name: "absent", attrs: "tm2", data: new Uint8Array(16) },
    ]);
    const scan = await scanImageTextures(imageSourceFixture([
        ["debug/one/mixed.pck", brokenPackage],
        ["debug/two/empty.pck", skippedOnly],
        ["debug/three/valid.tm2", makeImageTim2()],
    ]));
    assert.deepEqual(scan.textures.map(texture => texture.id), ["00000030-direct"]);
    assert.deepEqual(scan.issues.map(issue => [issue.path, issue.format]), [
        ["debug/one/mixed.pck", "TIM2"],
    ]);
    assert.deepEqual(scan.skipped.map(member => [
        member.sourcePath, member.memberIndex, member.fileName, member.byteLength,
    ]), [
        ["debug/one/mixed.pck", 0, "absent.tm2", 16],
        ["debug/two/empty.pck", 0, "absent.tm2", 16],
    ]);
});

test("image reference classification preserves path, case, short-name, and global matching", async () => {
    const encoder = new TextEncoder();
    const image = makeImageTim2();
    const tooLong = "q".repeat(65);
    const mixed = makeImagePck([
        { name: "layout", attrs: "uis", data: encoder.encode(
            `invalid prefix/path\\AB.Tm2\0A\0folder/XYZ.TM2\0${tooLong}.tm2\0`) },
        { name: "model", attrs: "i3d", data: encoder.encode("AA\0path/T_M.TM2\0") },
        ...["a", "aa", "ab", "t_m", tooLong].map(name =>
            ({ name, attrs: "tm2", data: image })),
    ]);
    const separate = makeImagePck([{ name: "xyz", attrs: "tm2", data: image }]);
    const scan = await scanImageTextures(imageSourceFixture([
        ["debug/test/mixed.pck", mixed],
        ["debug/test/separate.pck", separate],
    ]));
    assert.deepEqual(scan.textures.map(texture => [
        texture.memberName, texture.role, texture.roleEvidence,
    ]), [
        ["a", "sprite", "ui-reference"],
        ["aa", "texture", "model-reference"],
        ["ab", "sprite", "ui-reference"],
        ["t_m", "texture", "model-reference"],
        [tooLong, "other", "unclassified"],
        ["xyz", "sprite", "ui-global-reference"],
    ]);
});

test("damaged and obsolete image catalogs rebuild into a cache readable without the ISO", async () => {
    const encoder = new TextEncoder();
    const image = makeImageTim2();
    for (const invalid of ["{", JSON.stringify({ ...catalog, v: 4 })]) {
        const cache = imageCacheFixture(new Map([
            ["image_meta.json", encoder.encode(invalid)],
        ]));
        await assert.rejects(new ImageStore(cache, null, "disc").cached(), /reconnect the same disc/);
        const attached = new ImageStore(cache,
            imageSourceFixture([["debug/test/image.tm2", image]]), "disc");
        assert.equal(await attached.cached(), null);
        await attached.extract(() => {});
        const offline = new ImageStore(cache, null, "disc");
        const rebuilt = await offline.cached();
        assert.ok(rebuilt);
        assert.deepEqual(await offline.read(rebuilt.textures[0]!), image);
    }
});
