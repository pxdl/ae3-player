import assert from "node:assert/strict";
import { test } from "node:test";

import {
    filterImageEntries,
    imageEntries,
    imageExportPath,
    sortImageEntries,
    imageTreePath,
    type ImageCatalog,
} from "../src/images.ts";
import { storeZip, storeZipBlob } from "../src/zip.ts";

const catalog: ImageCatalog = {
    v: 4,
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
