import assert from "node:assert/strict";
import { test } from "node:test";

import {
    filterImageEntries,
    imageEntries,
    imageExportPath,
    imageTreePath,
    type ImageCatalog,
} from "../src/images.ts";
import { storeZipBlob } from "../src/zip.ts";

const catalog: ImageCatalog = {
    v: 2,
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

test("image filters use semantic roles and source metadata", () => {
    const entries = imageEntries(catalog);
    assert.deepEqual(filterImageEntries(entries, "", "sprite").map(entry => entry.id),
                     ["00000020-3:0", "00000020-3:1"]);
    assert.deepEqual(filterImageEntries(entries, "ZERO", "all").map(entry => entry.id),
                     ["00000020-3:0", "00000020-3:1"]);
    assert.deepEqual(filterImageEntries(entries, "logo", "sprite"), []);
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
