import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscReportStore } from "../src/disc-report.ts";
import { inspectVfiSupport } from "../src/vendor/extract/report.ts";
import { BytesSource } from "../src/vendor/extract/source.ts";
import type { OpfsCache } from "../src/vendor/extract/opfs.ts";
import type { Vfi, VfiEntry } from "../src/vendor/extract/vfi.ts";

function localizedEffects(): Vfi {
    const header = new Uint8Array(0x20);
    header.set(new TextEncoder().encode("SShd"), 0x0c);
    const files = new Map([
        ["debug/de/sound/se/voice.hd", header],
        ["debug/de/sound/se/voice.bd", Uint8Array.of(1)],
        ["debug/fr/sound/se/voice.hd", header],
        ["debug/fr/sound/se/voice.bd", Uint8Array.of(2)],
        ["debug/it/sound/se/voice.hd", header],
        ["debug/es/sound/se/voice.bd", Uint8Array.of(3)],
    ]);
    return {
        dataOff: 0,
        src: new BytesSource(new Uint8Array()),
        entries: [...files].map(([path, bytes], index): VfiEntry => ({
            entryOff: index * 32, entrySize: 32, parentOff: 0, sector: index,
            size: bytes.length, name: path.slice(path.lastIndexOf("/") + 1), path,
        })),
        async read(entry: VfiEntry) { return files.get(entry.path)!.slice(); },
    } as unknown as Vfi;
}

test("reports inspect every language and never pair files across language directories", async () => {
    const report = await inspectVfiSupport(localizedEffects(), {
        serial: "SCES_536.42", volumeId: "",
    });
    assert.equal(report.effects.pairedBanks, 2);
    assert.equal(report.effects.inspectedBanks, 2);
    assert.deepEqual(report.effects.directories, [
        "debug/de/sound/se", "debug/es/sound/se",
        "debug/fr/sound/se", "debug/it/sound/se",
    ]);
    assert.deepEqual(report.effects.issues.map(issue => issue.path).sort(), [
        "debug/es/sound/se/voice.bd", "debug/it/sound/se/voice.hd",
    ]);
    assert.equal(report.effects.status, "partial");
});

test("PAL reports with blank volume labels resume without the ISO", async () => {
    const files = new Map<string, Uint8Array>();
    const cache = {
        key: "pal",
        async write(name: string, bytes: Uint8Array) { files.set(name, bytes.slice()); },
        async read(name: string) { return files.get(name)?.slice() ?? null; },
    } as unknown as OpfsCache;
    const attached = new DiscReportStore(cache, localizedEffects(), "pal", "SCES_536.42", "");
    await attached.generate(() => {});
    const resumed = await new DiscReportStore(cache, null, "pal", "SCES_536.42", "").cached();
    assert.ok(resumed);
    assert.equal(resumed.effects.inspectedBanks, 2);
    assert.deepEqual(resumed.effects.issues.map(issue => issue.path).sort(), [
        "debug/es/sound/se/voice.bd", "debug/it/sound/se/voice.hd",
    ]);
});
