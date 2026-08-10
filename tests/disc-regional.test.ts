import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";

import {
    discSupportWarning,
    friendlyError,
    LAST_DISC_KEY,
    resumeSession,
    type DiscSession,
} from "../src/disc.ts";
import {
    assertAttachedDiscIdentity,
    assertCacheSourceIdentity,
} from "../src/disc-identity.ts";
import { ImageStore, type ImageCatalog } from "../src/images.ts";
import { fingerprintBytes } from "../src/content-identity.ts";
import { Exporter } from "../src/export.ts";
import {
    DiscOpenCoordinator,
    SerializedDiscCleanup,
    type DiscOpenTicket,
} from "../src/disc-open.ts";
import { MovieController } from "../src/movie-controller.ts";
import {
    MovieStore,
    scanMovieCatalog,
    type MovieCatalog,
} from "../src/movies.ts";
import { SeInspector, SeStore } from "../src/se.ts";
import { StreamDecoder, StreamPlayer } from "../src/streams.ts";
import {
    OpfsCache,
    type ImageTexture,
    type Vfi,
    type VfiEntry,
} from "../src/vendor/extract/index.ts";
async function commitDiscWhenCurrent<T>(
    coordinator: DiscOpenCoordinator,
    ticket: DiscOpenTicket,
    pending: Promise<T>,
    commit: (value: T) => void,
): Promise<void> {
    const value = await pending;
    if (coordinator.isCurrent(ticket)) commit(value);
}


const encoder = new TextEncoder();

function setU32(bytes: Uint8Array, offset: number, value: number,
                littleEndian = true): void {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .setUint32(offset, value, littleEndian);
}

function makeInspectableFmv(): Uint8Array {
    const preload = 0x20;
    const groupOffset = 0x800 + preload;
    const video = new Uint8Array(30);
    video.set([0, 0, 1, 0xb3], 0);
    setU32(video, 4, (720 << 20) | (448 << 8) | (1 << 4) | 4, false);
    video.set([0, 0, 1, 0xb5, 0x10, 0x08, 0, 0], 8);
    video.set([0, 0, 1, 0xb8], 16);
    video.set([0, 0, 1, 0x00, 0x00, 0x08], 20);
    video.set([0, 0, 1, 0xb7], 26);

    const bytes = new Uint8Array(groupOffset + 48 + 32 + 32);
    bytes.set(encoder.encode("str\0"), 0);
    setU32(bytes, 0x08, 2);
    setU32(bytes, 0x0c, 5994);
    setU32(bytes, 0x10, 1);
    setU32(bytes, 0x20, 48_000);
    setU32(bytes, 0x24, 2);
    setU32(bytes, 0x28, 0x10);
    setU32(bytes, 0x2c, 0x20);
    setU32(bytes, 0x30, preload);
    setU32(bytes, 0x34, preload);

    bytes.set(encoder.encode("GroupOfDataInfo\0"), groupOffset);
    setU32(bytes, groupOffset + 0x14, 16);
    setU32(bytes, groupOffset + 0x20, 2);
    setU32(bytes, groupOffset + 0x24, 1);

    const videoOffset = groupOffset + 48;
    bytes.set(encoder.encode("Mpeg2Video\0"), videoOffset);
    setU32(bytes, videoOffset + 0x14, video.length);
    bytes.set(video, videoOffset + 32);
    return bytes;
}


function mixedMovieVfi(): Vfi {
    const valid = makeInspectableFmv();
    const invalid = new Uint8Array(0x800);
    const validEntry: VfiEntry = {
        entryOff: 16,
        entrySize: 16,
        parentOff: 0,
        sector: 1,
        size: valid.length,
        name: "new_play01.str",
        path: "regional/private/movie/new_play01.str",
    };
    const invalidEntry: VfiEntry = {
        entryOff: 80,
        entrySize: 16,
        parentOff: 0,
        sector: 5,
        size: invalid.length,
        name: "broken.str",
        path: "regional/private/movie/broken.str",
    };
    const storage = new Uint8Array(0x3000);
    storage.set(valid, validEntry.sector * 0x800);
    storage.set(invalid, invalidEntry.sector * 0x800);
    const entries = [validEntry, invalidEntry];
    return {
        entries,
        src: {
            size: storage.length,
            async read(offset: number, size: number): Promise<Uint8Array> {
                return storage.slice(offset, offset + size);
            },
        },
        byteOffset(entry: VfiEntry): number {
            return entry.sector * 0x800;
        },
        async read(entry: VfiEntry): Promise<Uint8Array> {
            const offset = entry.sector * 0x800;
            return storage.slice(offset, offset + entry.size);
        },
        find(path: string): VfiEntry | null {
            return entries.find(entry => entry.path === path) ?? null;
        },
    } as unknown as Vfi;
}

interface CacheDouble {
    key: string;
    read(name: string): Promise<Uint8Array | null>;
    has(name: string): Promise<boolean>;
    write(name: string, data: Uint8Array): Promise<void>;
    size(name: string): Promise<number | null>;
    remove(name: string, recursive?: boolean): Promise<void>;
}

function cacheDouble(overrides: Partial<CacheDouble> = {}): OpfsCache {
    return Object.assign({
        key: "disc",
        async read(): Promise<Uint8Array | null> { return null; },
        async has(): Promise<boolean> { return false; },
        async write(): Promise<void> {},
        async size(): Promise<number | null> { return null; },
        async remove(): Promise<void> {},
    }, overrides) as unknown as OpfsCache;
}

function makeTim2(): Uint8Array {
    const imageSize = 1;
    const clutSize = 256 * 4;
    const bytes = new Uint8Array(0x10 + 0x30 + imageSize + clutSize);
    const picture = 0x10;
    const view = new DataView(bytes.buffer);
    bytes.set(encoder.encode("TIM2"), 0);
    bytes[4] = 4;
    bytes[6] = 1;
    view.setUint32(picture, 0x30 + imageSize + clutSize, true);
    view.setUint32(picture + 4, clutSize, true);
    view.setUint32(picture + 8, imageSize, true);
    view.setUint16(picture + 12, 0x30, true);
    view.setUint16(picture + 14, 256, true);
    bytes[picture + 17] = 1;
    bytes[picture + 18] = 0x83;
    bytes[picture + 19] = 5;
    view.setUint16(picture + 20, 1, true);
    view.setUint16(picture + 22, 1, true);
    return bytes;
}

function imageFixture(): {
    bytes: Uint8Array;
    texture: ImageTexture;
    vfi: Vfi;
} {
    const bytes = makeTim2();
    const entry: VfiEntry = {
        entryOff: 0x10,
        entrySize: 16,
        parentOff: 0,
        sector: 0,
        size: bytes.length,
        name: "test.tm2",
        path: "debug/test/static/test.tm2",
    };
    const texture: ImageTexture = {
        id: "00000010-direct",
        sourcePath: entry.path,
        memberIndex: null,
        memberName: null,
        fileName: entry.name,
        attrs: "tm2",
        byteLength: bytes.length,
        role: "other",
        roleEvidence: "direct",
        pictures: [{
            index: 0,
            width: 1,
            height: 1,
            imageType: 5,
            clutType: 0x83,
            colorCount: 256,
            mipmapCount: 1,
        }],
    };
    const vfi = {
        entries: [entry],
        async read(candidate: VfiEntry): Promise<Uint8Array> {
            assert.equal(candidate, entry);
            return bytes;
        },
        find(path: string): VfiEntry | null {
            return path === entry.path ? entry : null;
        },
    } as unknown as Vfi;
    return { bytes, texture, vfi };
}
function mixedImageVfi(): { readonly valid: Uint8Array; readonly vfi: Vfi } {
    const valid = makeTim2();
    const malformed = new Uint8Array(16);
    const entries: VfiEntry[] = [
        {
            entryOff: 0x10,
            entrySize: 16,
            parentOff: 0,
            sector: 0,
            size: valid.length,
            name: "valid.tm2",
            path: "debug/test/static/valid.tm2",
        },
        {
            entryOff: 0x20,
            entrySize: 16,
            parentOff: 0,
            sector: 1,
            size: malformed.length,
            name: "placeholder.tm2",
            path: "debug/test/static/placeholder.tm2",
        },
    ];
    const byOffset = new Map([
        [entries[0]!.entryOff, valid],
        [entries[1]!.entryOff, malformed],
    ]);
    const vfi = {
        entries,
        async read(entry: VfiEntry): Promise<Uint8Array> {
            return byOffset.get(entry.entryOff)!;
        },
    } as unknown as Vfi;
    return { valid, vfi };
}

async function imageCatalogFor(texture: ImageTexture,
                               bytes: Uint8Array,
                               sourceKey = "disc"): Promise<ImageCatalog> {
    return {
        v: 4,
        sourceKey,
        storage: "containers",
        textures: [texture],
        sources: [{
            entryOffset: Number.parseInt(texture.id.slice(0, 8), 16),
            sourcePath: texture.sourcePath,
            ...await fingerprintBytes(bytes),
        }],
        issues: [],
    };
}


function effectsFixture(): {
    entry: { name: string; hd: string; bd: string; bytes: number };
    hd: Uint8Array;
    bd: Uint8Array;
    vfi: Vfi;
} {
    const hd = Uint8Array.of(1, 2, 3);
    const bd = Uint8Array.of(4, 5, 6, 7);
    const entries: VfiEntry[] = [
        {
            entryOff: 0x10,
            entrySize: 16,
            parentOff: 0,
            sector: 1,
            size: hd.length,
            name: "effect.hd",
            path: "debug/test/sound/se/effect.hd",
        },
        {
            entryOff: 0x20,
            entrySize: 16,
            parentOff: 0,
            sector: 2,
            size: bd.length,
            name: "effect.bd",
            path: "debug/test/sound/se/effect.bd",
        },
    ];
    const byName = new Map([
        ["effect.hd", hd],
        ["effect.bd", bd],
    ]);
    const vfi = {
        entries,
        async read(candidate: VfiEntry): Promise<Uint8Array> {
            return byName.get(candidate.name)!;
        },
    } as unknown as Vfi;
    return {
        entry: { name: "effect", hd: "effect.hd", bd: "effect.bd", bytes: 7 },
        hd,
        bd,
        vfi,
    };
}

function incompleteSubtitleVfi(): Vfi {
    const movie = makeInspectableFmv();
    const play: VfiEntry = {
        entryOff: 16,
        entrySize: 16,
        parentOff: 0,
        sector: 1,
        size: movie.length,
        name: "new_play01.str",
        path: "debug/test/movie/new_play01.str",
    };
    const scene: VfiEntry = {
        entryOff: 80,
        entrySize: 16,
        parentOff: 0,
        sector: 5,
        size: movie.length,
        name: "new_scene01.str",
        path: "debug/test/movie/new_scene01.str",
    };
    const subtitle: VfiEntry = {
        entryOff: 144,
        entrySize: 16,
        parentOff: 0,
        sector: 9,
        size: 1,
        name: "scene01.bin",
        path: "debug/test/movie/scene01.bin",
    };
    const storage = new Uint8Array(0x6000);
    storage.set(movie, play.sector * 0x800);
    storage.set(movie, scene.sector * 0x800);
    const entries = [play, scene, subtitle];
    return {
        entries,
        src: {
            size: storage.length,
            async read(offset: number, size: number): Promise<Uint8Array> {
                return storage.slice(offset, offset + size);
            },
        },
        byteOffset(entry: VfiEntry): number {
            return entry.sector * 0x800;
        },
        async read(entry: VfiEntry): Promise<Uint8Array> {
            const offset = entry.sector * 0x800;
            return storage.slice(offset, offset + entry.size);
        },
        find(path: string): VfiEntry | null {
            return entries.find(entry => entry.path === path) ?? null;
        },
    } as unknown as Vfi;
}

function unreadableSubtitleVfi(): Vfi {
    const movie = makeInspectableFmv();
    const entries: VfiEntry[] = [
        {
            entryOff: 16,
            entrySize: 16,
            parentOff: 0,
            sector: 1,
            size: movie.length,
            name: "new_scene01.str",
            path: "debug/test/movie/new_scene01.str",
        },
        {
            entryOff: 80,
            entrySize: 16,
            parentOff: 0,
            sector: 5,
            size: 4,
            name: "scene01.bin",
            path: "debug/test/movie/scene01.bin",
        },
        {
            entryOff: 144,
            entrySize: 16,
            parentOff: 0,
            sector: 6,
            size: 4,
            name: "scene01.sbt",
            path: "debug/test/movie/scene01.sbt",
        },
    ];
    const storage = new Uint8Array(0x4000);
    storage.set(movie, entries[0]!.sector * 0x800);
    return {
        entries,
        src: {
            size: storage.length,
            async read(offset: number, size: number): Promise<Uint8Array> {
                return storage.slice(offset, offset + size);
            },
        },
        byteOffset(entry: VfiEntry): number {
            return entry.sector * 0x800;
        },
        async read(entry: VfiEntry): Promise<Uint8Array> {
            if (entry !== entries[0])
                throw new Error("subtitle source offline");
            const offset = entry.sector * 0x800;
            return storage.slice(offset, offset + entry.size);
        },
        find(path: string): VfiEntry | null {
            return entries.find(entry => entry.path === path) ?? null;
        },
    } as unknown as Vfi;
}

function installLocalStorage(storage: Storage): () => void {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: storage,
    });
    return () => {
        if (prior)
            Object.defineProperty(globalThis, "localStorage", prior);
        else
            Reflect.deleteProperty(globalThis, "localStorage");
    };
}

function installHistoryState(state: unknown): () => void {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "history");
    let current = state;
    Object.defineProperty(globalThis, "history", {
        configurable: true,
        value: {
            get state(): unknown { return current; },
            replaceState(next: unknown): void { current = next; },
        } as unknown as History,
    });
    return () => {
        if (prior)
            Object.defineProperty(globalThis, "history", prior);
        else
            Reflect.deleteProperty(globalThis, "history");
    };
}

class SeWorkerDouble {
    static readonly instances: SeWorkerDouble[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: {
        message: string;
        preventDefault(): void;
    }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    posted: unknown = null;
    postError: Error | null = null;
    terminated = false;
    errorPrevented = false;

    constructor(..._args: unknown[]) {
        SeWorkerDouble.instances.push(this);
    }

    postMessage(message: unknown): void {
        if (this.postError) throw this.postError;
        this.posted = message;
    }

    terminate(): void {
        this.terminated = true;
    }

    emitMessage(data: unknown): void {
        this.onmessage?.({ data });
    }

    emitError(message: string): void {
        this.onerror?.({
            message,
            preventDefault: () => {
                this.errorPrevented = true;
            },
        });
    }

    emitMessageError(): void {
        this.onmessageerror?.();
    }
}

function postedWorkerId(worker: SeWorkerDouble): number {
    assert.ok(worker.posted !== null && typeof worker.posted === "object");
    const id = Reflect.get(worker.posted, "id");
    assert.equal(typeof id, "number");
    return id;
}

function installWorkerDouble(): () => void {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    SeWorkerDouble.instances.length = 0;
    Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: SeWorkerDouble,
    });
    return () => {
        if (prior)
            Object.defineProperty(globalThis, "Worker", prior);
        else
            Reflect.deleteProperty(globalThis, "Worker");
    };
}

test("movie catalog loading is deferred until FMV tab activation", async () => {
    const pending = Promise.withResolvers<MovieCatalog | null>();
    let catalogCalls = 0;
    const session = {
        movies: {
            catalog(): Promise<MovieCatalog | null> {
                catalogCalls++;
                return pending.promise;
            },
            hasIso(): boolean { return true; },
        },
    } as unknown as DiscSession;
    const controller = new MovieController({
        changed() {},
        pauseOtherMedia() {},
        deliver() {},
    });

    await controller.connect(session);
    try {
        assert.equal(catalogCalls, 0);
        controller.setActive(true);
        assert.equal(catalogCalls, 1);
        pending.resolve({ v: 1, entries: [], issues: [] });
        await waitForImmediate();
        assert.equal(controller.snapshot().catalog?.entries.length, 0);
    } finally {
        pending.resolve({ v: 1, entries: [], issues: [] });
        await waitForImmediate();
        await controller.dispose();
    }
});

test("explicit open wins when delayed resume resolves first", async () => {
    const coordinator = new DiscOpenCoordinator();
    let active: string | null = null;
    const resume = Promise.withResolvers<string>();
    const explicit = Promise.withResolvers<string>();
    const resumeTicket = coordinator.begin();
    const resumeCommit = commitDiscWhenCurrent(
        coordinator, resumeTicket, resume.promise, value => { active = value; });

    const explicitTicket = coordinator.begin();
    active = null;
    const explicitCommit = commitDiscWhenCurrent(
        coordinator, explicitTicket, explicit.promise, value => { active = value; });
    resume.resolve("resumed");
    await resumeCommit;
    assert.equal(active, null);
    explicit.resolve("explicit");
    await explicitCommit;
    assert.equal(active, "explicit");
});

test("delayed resume cannot overwrite an explicit open that resolves first", async () => {
    const coordinator = new DiscOpenCoordinator();
    let active: string | null = null;
    const resume = Promise.withResolvers<string>();
    const explicit = Promise.withResolvers<string>();
    const resumeTicket = coordinator.begin();
    const resumeCommit = commitDiscWhenCurrent(
        coordinator, resumeTicket, resume.promise, value => { active = value; });

    const explicitTicket = coordinator.begin();
    active = null;
    const explicitCommit = commitDiscWhenCurrent(
        coordinator, explicitTicket, explicit.promise, value => { active = value; });
    explicit.resolve("explicit");
    await explicitCommit;
    assert.equal(active, "explicit");
    resume.resolve("resumed");
    await resumeCommit;
    assert.equal(active, "explicit");
});

test("superseding open waits for prior disc cleanup before parsing", async () => {
    const coordinator = new DiscOpenCoordinator();
    const cleanup = new SerializedDiscCleanup();
    const firstClose = Promise.withResolvers<void>();
    const events: string[] = [];

    async function open(name: string, close: Promise<void>): Promise<void> {
        const ticket = coordinator.begin();
        await cleanup.run(async () => {
            events.push(`reset:${name}`);
            await close;
        });
        if (coordinator.isCurrent(ticket)) events.push(`parse:${name}`);
    }

    const first = open("first", firstClose.promise);
    await waitForImmediate();
    const second = open("second", Promise.resolve());
    await waitForImmediate();
    assert.deepEqual(events, ["reset:first"]);

    firstClose.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["reset:first", "reset:second", "parse:second"]);
});

test("new disc movie preparation is not blocked by an aborted prior task", async () => {
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const pending = new Promise<never>(() => {});
    let firstPreparations = 0;
    let secondPreparations = 0;
    const sessionFor = (prepare: () => Promise<never>): DiscSession => ({
        movies: {
            async catalog(): Promise<MovieCatalog> { return catalog; },
            hasIso(): boolean { return true; },
            async cacheInfo(): Promise<{
                sourceBytes: number;
                exportBytes: number;
                totalBytes: number;
            }> {
                return { sourceBytes: 0, exportBytes: 0, totalBytes: 0 };
            },
            prepare,
        },
    } as unknown as DiscSession);
    const first = sessionFor(() => {
        firstPreparations++;
        return pending;
    });
    const second = sessionFor(() => {
        secondPreparations++;
        return pending;
    });
    const controller = new MovieController({
        changed() {},
        pauseOtherMedia() {},
        deliver() {},
    });

    controller.setActive(true);
    await controller.connect(first);
    await waitForImmediate();
    assert.equal(firstPreparations, 1);

    await controller.connect(second);
    await waitForImmediate();
    assert.equal(secondPreparations, 1);
    await controller.dispose();
});
test("failed movie source attachment keeps its scoped error and catalog", async context => {

    context.mock.method(console, "error", () => {});
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const session = {
        movies: {
            async catalog(): Promise<MovieCatalog> { return catalog; },
            hasIso(): boolean { return false; },
            async cacheInfo(): Promise<{ sourceBytes: number; exportBytes: number;
                                        totalBytes: number }> {
                return { sourceBytes: 0, exportBytes: 0, totalBytes: 0 };
            },
            async attachIso(): Promise<never> {
                throw new Error("this ISO is a different disc than the cached one");
            },
        },
    } as unknown as DiscSession;
    const controller = new MovieController({
        changed() {},
        pauseOtherMedia() {},
        deliver() {},
    });

    try {
        await controller.connect(session);
        controller.setActive(true);
        await waitForImmediate();
        await controller.attachIso({} as File);
        const snapshot = controller.snapshot();
        assert.equal(snapshot.error, true);
        assert.match(snapshot.status, /different disc/);
        assert.equal(snapshot.catalog?.entries.length, 1);
    } finally {
        await controller.dispose();
    }
});

test("failed attached movie scan offers source reattachment", async context => {
    context.mock.method(console, "error", () => {});
    const session = {
        movies: {
            async catalog(): Promise<never> {
                throw new Error("movie source offline");
            },
            hasIso(): boolean { return true; },
        },
    } as unknown as DiscSession;
    const controller = new MovieController({
        changed() {},
        pauseOtherMedia() {},
        deliver() {},
    });

    try {
        await controller.connect(session);
        controller.setActive(true);
        await waitForImmediate();
        const snapshot = controller.snapshot();
        assert.equal(snapshot.error, true);
        assert.equal(snapshot.catalog, null);
        assert.equal(snapshot.hasIso, true);
        assert.equal(snapshot.sourceRequired, true);
        assert.match(snapshot.status, /movie source offline/);
    } finally {
        await controller.dispose();
    }
});

test("movie scan preserves valid assets beside an unsupported container", async () => {
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    assert.deepEqual(catalog.entries.map(entry => entry.name), ["new_play01"],
                     JSON.stringify(catalog.issues));
    assert.equal(catalog.issues.length, 1);
    assert.equal(catalog.issues[0]?.name, "broken");
    assert.match(catalog.issues[0]?.reason ?? "", /bad str magic/);
    assert.doesNotMatch(catalog.issues[0]?.reason ?? "", /regional|private|movie\//i);
});

test("incomplete subtitle discovery isolates one movie and keeps neighbors", async () => {
    const catalog = await scanMovieCatalog(incompleteSubtitleVfi(), "disc");
    assert.deepEqual(catalog.entries.map(entry => entry.name), ["new_play01"]);
    assert.deepEqual(catalog.issues.map(issue => issue.name), ["new_scene01"]);
    assert.match(catalog.issues[0]!.reason, /incomplete subtitle pair/);
    assert.doesNotMatch(catalog.issues[0]!.reason, /debug[\\/]test|scene01\.bin/i);
});

test("movie scanning propagates operational source failures", async () => {
    const base = mixedMovieVfi();
    const failures: Array<{
        reason: RegExp;
        read(offset: number, size: number): Promise<Uint8Array>;
    }> = [
        {
            reason: /movie source offline/,
            async read(): Promise<Uint8Array> {
                throw new Error("movie source offline");
            },
        },
        {
            reason: /short read/,
            async read(offset: number, size: number): Promise<Uint8Array> {
                const data = await base.src.read(offset, size);
                return data.subarray(0, Math.max(0, data.length - 1));
            },
        },
        {
            reason: /disc source was removed/,
            async read(): Promise<Uint8Array> {
                throw new DOMException(
                    "disc source was removed",
                    "NotReadableError",
                );
            },
        },
    ];
    for (const failure of failures) {
        const failing = {
            entries: base.entries,
            src: {
                size: base.src.size,
                read: failure.read,
            },
            byteOffset(entry: VfiEntry): number {
                return base.byteOffset(entry);
            },
            read(entry: VfiEntry): Promise<Uint8Array> {
                return failure.read(base.byteOffset(entry), entry.size);
            },
            find(path: string): VfiEntry | null {
                return base.find(path);
            },
        } as unknown as Vfi;
        await assert.rejects(scanMovieCatalog(failing, "disc"), failure.reason);
    }
});

test("subtitle source failures remain scan-fatal", async () => {
    await assert.rejects(
        scanMovieCatalog(unreadableSubtitleVfi(), "disc"),
        /subtitle source offline/,
    );
});

test("operational movie-cache reads fall back to the attached disc", async context => {
    context.mock.method(console, "warn", () => {});
    const cache = cacheDouble({
        async read(): Promise<Uint8Array | null> {
            throw new Error("OPFS read denied");
        },
    });
    const store = new MovieStore(cache, mixedMovieVfi(), "disc");
    const catalog = await store.catalog();
    assert.equal(catalog?.entries.length, 1);
    assert.match(
        store.persistenceWarning ?? "",
        /movie cache is unavailable.*using the attached ISO/i,
    );
});

test("attached movie playback survives cache accounting and cleanup failures", async context => {
    context.mock.method(console, "warn", () => {});
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const measured = new MovieStore(cacheDouble({
        async size(): Promise<number | null> {
            throw new Error("OPFS size denied");
        },
    }), mixedMovieVfi(), "disc", catalog);
    assert.deepEqual(await measured.cacheInfo("new_play01"), {
        sourceBytes: 0,
        exportBytes: 0,
        totalBytes: 0,
    });
    assert.match(measured.persistenceWarning ?? "", /using the attached ISO/i);

    const corrupted = new MovieStore(cacheDouble({
        async read(name: string): Promise<Uint8Array | null> {
            return name.endsWith("/source_meta.json")
                ? encoder.encode("{")
                : null;
        },
    }), mixedMovieVfi(), "disc", catalog);
    assert.deepEqual(await corrupted.cacheInfo("new_play01"), {
        sourceBytes: 0,
        exportBytes: 0,
        totalBytes: 0,
    });
    assert.match(corrupted.persistenceWarning ?? "", /using the attached ISO/i);

    const cleanup = new MovieStore(cacheDouble({
        async remove(): Promise<void> {
            throw new Error("OPFS remove denied");
        },
    }), mixedMovieVfi(), "disc", catalog);
    const prepared = await cleanup.prepare("new_play01", () => {});
    assert.ok(prepared.video.byteLength > 0);
    assert.match(cleanup.persistenceWarning ?? "", /playback remains available/i);
});
test("movie cache rejects incomplete, impossible, and intersecting metadata", async () => {
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const entry = catalog.entries[0]!;
    const issue = catalog.issues[0]!;
    const incomplete = {

        v: 1,
        entries: [{
            ...entry,
            video: { ...entry.video, frameRate: undefined },
        }],
        issues: [],
    };
    const duplicate = {
        v: 1,
        entries: [entry, entry],
        issues: [],
    };
    const zeroSized = {
        v: 1,
        entries: [{
            ...entry,
            movie: { ...entry.movie, size: 0 },
            sourceBytes: 0,
        }],
        issues: [],
    };
    const entryIssueIntersection = {
        v: 1,
        entries: [entry],
        issues: [{ ...issue, name: entry.name }],
    };
    for (const metadata of [
        incomplete,
        duplicate,
        zeroSized,
        entryIssueIntersection,
    ]) {
        const raw = encoder.encode(JSON.stringify(metadata));
        const store = new MovieStore(cacheDouble({
            async read(): Promise<Uint8Array> { return raw; },
        }), null, "disc");
        await assert.rejects(store.catalog(), /movie index is damaged/);
    }
});

test("complete persisted movie metadata remains reusable without an ISO", async () => {
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const raw = encoder.encode(JSON.stringify(catalog));
    const store = new MovieStore(cacheDouble({
        async read(): Promise<Uint8Array> { return raw; },
    }), null, "disc");
    const cached = await store.catalog();
    assert.deepEqual(cached?.entries.map(entry => entry.name), ["new_play01"]);
    assert.deepEqual(cached?.issues.map(issue => issue.name), ["broken"]);
});

test("movie source requirement stays conservative while cache state resolves", async () => {
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const pending = Promise.withResolvers<{
        sourceBytes: number;
        exportBytes: number;
        totalBytes: number;
    }>();
    const session = {
        movies: {
            async catalog(): Promise<MovieCatalog> { return catalog; },
            hasIso(): boolean { return false; },
            cacheInfo(): Promise<{
                sourceBytes: number;
                exportBytes: number;
                totalBytes: number;
            }> {
                return pending.promise;
            },
        },
    } as unknown as DiscSession;
    const controller = new MovieController({
        changed() {},
        pauseOtherMedia() {},
        deliver() {},
    });

    try {
        await controller.connect(session);
        controller.setActive(true);
        await waitForImmediate();
        const snapshot = controller.snapshot();
        assert.equal(snapshot.catalog?.entries.length, 1);
        assert.equal(snapshot.cache, null);
        assert.equal(snapshot.sourceRequired, true);
    } finally {
        pending.resolve({ sourceBytes: 0, exportBytes: 0, totalBytes: 0 });
        await waitForImmediate();
        await controller.dispose();
    }
});

test("source attachment is blocked while an older catalog load is pending", async () => {
    const catalog = await scanMovieCatalog(mixedMovieVfi(), "disc");
    const pending = Promise.withResolvers<MovieCatalog | null>();
    let attachCalls = 0;
    const session = {
        movies: {
            catalog(): Promise<MovieCatalog | null> { return pending.promise; },
            hasIso(): boolean { return false; },
            async attachIso(): Promise<void> { attachCalls++; },
            async cacheInfo(): Promise<{
                sourceBytes: number;
                exportBytes: number;
                totalBytes: number;
            }> {
                return { sourceBytes: 0, exportBytes: 0, totalBytes: 0 };
            },
        },
    } as unknown as DiscSession;
    const controller = new MovieController({
        changed() {},
        pauseOtherMedia() {},
        deliver() {},
    });

    try {
        await controller.connect(session);
        controller.setActive(true);
        const attachment = controller.attachIso({} as File);
        await waitForImmediate();
        assert.equal(attachCalls, 0);
        await attachment;
    } finally {
        pending.resolve(catalog);
        await waitForImmediate();
        await controller.dispose();
    }
});

test("cache-only Images and Effects failures remain actionable", async () => {
    const failing = cacheDouble({
        async read(): Promise<Uint8Array | null> {
            throw new Error("OPFS read denied");
        },
    });
    await assert.rejects(
        new ImageStore(failing, null, "disc").cached(),
        /image cache is unavailable.*reconnect the same disc/i,
    );
    await assert.rejects(
        new SeStore(failing, null, "disc").cached(),
        /Effects cache is unavailable.*reconnect the same disc/,
    );
    const malformed = cacheDouble({
        async read(): Promise<Uint8Array> {
            return encoder.encode("{\"v\":1,\"entries\":[{}]}");
        },
    });
    await assert.rejects(
        new ImageStore(malformed, null, "disc").cached(),
        /image index is damaged.*reconnect the same disc/i,
    );
    await assert.rejects(
        new SeStore(malformed, null, "disc").cached(),
        /Effects index is damaged.*reconnect the same disc/,
    );
});

test("cache-only image payload failures request source reattachment", async () => {
    const fixture = imageFixture();
    const catalog = await imageCatalogFor(fixture.texture, fixture.bytes);
    const metadata = encoder.encode(JSON.stringify(catalog));
    const cache = cacheDouble({
        async read(name: string): Promise<Uint8Array | null> {
            if (name === "image_meta.json") return metadata;
            throw new Error("OPFS image container read denied");
        },
    });
    const store = new ImageStore(cache, null, "disc");
    assert.ok(await store.cached());
    await assert.rejects(
        store.read(fixture.texture),
        /image cache is unavailable.*reconnect the same disc/i,
    );
});

test("Images and Effects reject impossible persisted catalogs", async () => {
    const fixture = imageFixture();
    const texture = fixture.texture;
    const picture = texture.pictures[0]!;
    const base = await imageCatalogFor(texture, fixture.bytes);
    const invalidTextures = [
        { ...texture, pictures: [] },
        { ...texture, pictures: [{ ...picture, index: 1 }] },
        { ...texture, pictures: [picture, picture] },
        { ...texture, sourcePath: "" },
        { ...texture, byteLength: 0 },
        { ...texture, roleEvidence: "unsupported" },
    ];
    for (const invalid of invalidTextures) {
        const raw = encoder.encode(JSON.stringify({
            ...base,
            textures: [invalid],
        }));
        await assert.rejects(
            new ImageStore(cacheDouble({
                async read(): Promise<Uint8Array> { return raw; },
            }), null, "disc").cached(),
            /image index is damaged.*reconnect the same disc/i,
        );
    }

    const emptyEffects = encoder.encode(JSON.stringify({ v: 1, entries: [] }));
    await assert.rejects(
        new SeStore(cacheDouble({
            async read(): Promise<Uint8Array> { return emptyEffects; },
        }), null, "disc").cached(),
        /Effects index is damaged.*reconnect the same disc/,
    );
});
test("image catalogs reject lossy texture IDs before container lookup", async () => {
    const fixture = imageFixture();
    const base = await imageCatalogFor(fixture.texture, fixture.bytes);
    const invalidTextures = [
        { ...fixture.texture, id: "000000010-direct" },
        { ...fixture.texture, id: "0000001g-direct" },
        { ...fixture.texture, id: "00000010-direct0" },
        { ...fixture.texture, id: "00000010-00",
          memberIndex: 0, memberName: "test.tm2" },
        { ...fixture.texture, id: "00000010-01",
          memberIndex: 1, memberName: "test.tm2" },
        { ...fixture.texture, id: "00000010-0" },
        { ...fixture.texture, id: "00000010-direct",
          memberIndex: 0, memberName: "test.tm2" },
        { ...fixture.texture, id: "00000010-9007199254740992",
          memberIndex: 9_007_199_254_740_992, memberName: "test.tm2" },
    ];

    for (const texture of invalidTextures) {
        const reads: string[] = [];
        const raw = encoder.encode(JSON.stringify({
            ...base,
            textures: [texture],
        }));
        await assert.rejects(
            new ImageStore(cacheDouble({
                async read(name: string): Promise<Uint8Array> {
                    reads.push(name);
                    return raw;
                },
            }), null, "disc").cached(),
            /image index is damaged.*reconnect the same disc/i,
        );
        assert.deepEqual(reads, ["image_meta.json"]);
    }
});

test("image source fingerprints reject same-layout payload changes", async () => {
    const fixture = imageFixture();
    const catalog = await imageCatalogFor(fixture.texture, fixture.bytes);
    const changed = fixture.bytes.slice();
    changed[changed.length - 1] ^= 1;
    const metadata = encoder.encode(JSON.stringify(catalog));
    const store = new ImageStore(cacheDouble({
        async read(name: string): Promise<Uint8Array | null> {
            if (name === "image_meta.json") return metadata;
            if (name === "image-container/00000010.bin") return changed;
            return null;
        },
    }), null, "disc");
    const restored = await store.cached();
    assert.ok(restored);
    await assert.rejects(
        store.read(restored.textures[0]!),
        /image source content does not match this catalog/,
    );
});

test("malformed image containers persist as issues beside valid neighbors", async () => {
    const fixture = mixedImageVfi();
    const files = new Map<string, Uint8Array>();
    const cache = cacheDouble({
        async read(name: string): Promise<Uint8Array | null> {
            return files.get(name) ?? null;
        },
        async has(name: string): Promise<boolean> {
            return files.has(name);
        },
        async write(name: string, data: Uint8Array): Promise<void> {
            files.set(name, data.slice());
        },
    });
    const attached = new ImageStore(cache, fixture.vfi, "disc");
    const extracted = await attached.extract(() => {});
    assert.equal(extracted.textures.length, 1);
    assert.equal(extracted.issues.length, 1);
    assert.equal(extracted.issues[0]!.format, "TIM2");
    assert.doesNotMatch(extracted.issues[0]!.reason,
        /debug[\\/]test|placeholder\.tm2|\/Users\//i);
    assert.deepEqual(
        await attached.read(extracted.textures[0]!),
        fixture.valid,
    );

    const resumed = new ImageStore(cache, null, "disc");
    const cached = await resumed.cached();
    assert.ok(cached);
    assert.deepEqual(cached.issues, extracted.issues);
    assert.deepEqual(
        await resumed.read(cached.textures[0]!),
        fixture.valid,
    );
});


test("attached Images and Effects fall back after cache read failures",
     async context => {
    context.mock.method(console, "warn", () => {});
    const failing = (): OpfsCache => cacheDouble({
        async read(): Promise<Uint8Array | null> {
            throw new Error("OPFS read denied");
        },
    });
    const image = imageFixture();
    const imageStore = new ImageStore(failing(), image.vfi, "disc");
    assert.equal(await imageStore.cached(), null);
    const imageCatalog = await imageStore.extract(() => {});
    const imageBytes = await imageStore.read(imageCatalog.textures[0]!);
    assert.deepEqual(imageBytes, image.bytes);
    assert.match(imageStore.persistenceWarning ?? "",
        /OPFS read denied.*using the attached ISO for this session/);

    const effects = effectsFixture();
    const effectsStore = new SeStore(failing(), effects.vfi, "disc");
    assert.equal(await effectsStore.cached(), null);
    const effectsCatalog = await effectsStore.extract(() => {});
    const bank = await effectsStore.bank(effectsCatalog.entries[0]!);
    assert.deepEqual(bank.hd, effects.hd);
    assert.deepEqual(bank.bd, effects.bd);
    assert.match(effectsStore.persistenceWarning ?? "",
        /OPFS read denied.*using the attached ISO for this session/);
});

test("Images survive data and metadata cache-write failures", async context => {
    context.mock.method(console, "warn", () => {});
    const dataFixture = imageFixture();
    const dataStore = new ImageStore(cacheDouble({
        async has(): Promise<boolean> { return false; },
        async write(): Promise<void> {
            throw new Error("container write denied");
        },
    }), dataFixture.vfi, "disc");
    const dataCatalog = await dataStore.extract(() => {});
    assert.equal(dataCatalog.textures.length, 1);
    assert.deepEqual(
        await dataStore.read(dataCatalog.textures[0]!),
        dataFixture.bytes,
    );

    const metadataFixture = imageFixture();
    const metadataStore = new ImageStore(cacheDouble({
        async has(): Promise<boolean> { return true; },
        async write(name: string): Promise<void> {
            if (name === "image_meta.json")
                throw new Error("metadata write denied");
            assert.match(name, /^image-container\/[0-9a-f]{8}\.bin$/);
        },
    }), metadataFixture.vfi, "disc");
    const metadataCatalog = await metadataStore.extract(() => {});
    assert.equal(metadataCatalog.textures.length, 1);
    assert.deepEqual(
        await metadataStore.read(metadataCatalog.textures[0]!),
        metadataFixture.bytes,
    );
});

test("Effects survive data and metadata cache-write failures", async context => {
    context.mock.method(console, "warn", () => {});
    const dataFixture = effectsFixture();
    const dataStore = new SeStore(cacheDouble({
        async has(): Promise<boolean> { return false; },
        async write(): Promise<void> {
            throw new Error("bank write denied");
        },
    }), dataFixture.vfi, "disc");
    const dataCatalog = await dataStore.extract(() => {});
    assert.equal(dataCatalog.entries.length, 1);
    assert.deepEqual(await dataStore.bank(dataCatalog.entries[0]!), {
        hd: dataFixture.hd,
        bd: dataFixture.bd,
    });

    const metadataFixture = effectsFixture();
    const metadataStore = new SeStore(cacheDouble({
        async has(): Promise<boolean> { return true; },
        async write(name: string): Promise<void> {
            assert.equal(name, "se_meta.json");
            throw new Error("metadata write denied");
        },
    }), metadataFixture.vfi, "disc");
    const metadataCatalog = await metadataStore.extract(() => {});
    assert.equal(metadataCatalog.entries.length, 1);
    assert.deepEqual(await metadataStore.bank(metadataCatalog.entries[0]!), {
        hd: metadataFixture.hd,
        bd: metadataFixture.bd,
    });
});

test("Effects worker rejects malformed responses and recovers after failure", async () => {
    const restore = installWorkerDouble();
    const inspector = new SeInspector();
    const files = () => ({
        hd: Uint8Array.of(1),
        bd: Uint8Array.of(2),
    });
    try {
        const malformed = inspector.inspect(files());
        const firstWorker = SeWorkerDouble.instances[0]!;
        firstWorker.emitMessage({
            t: "unexpected",
            id: postedWorkerId(firstWorker),
        });
        await assert.rejects(malformed, /invalid SE worker response/);
        assert.equal(firstWorker.terminated, true);

        const crashed = inspector.inspect(files());
        const secondWorker = SeWorkerDouble.instances[1]!;
        secondWorker.emitError("worker crashed");
        await assert.rejects(crashed, /worker crashed/);
        assert.equal(secondWorker.errorPrevented, true);
        assert.equal(secondWorker.terminated, true);

        const recovered = inspector.inspect(files());
        const thirdWorker = SeWorkerDouble.instances[2]!;
        thirdWorker.emitMessage({
            t: "se-inspect-done",
            id: postedWorkerId(thirdWorker),
            inspection: {
                requests: Uint16Array.of(7),
                details: [Array<null>(7).fill(null)],
                ticksPerSecond: 480,
            },
        });
        const inspection = await recovered;
        assert.deepEqual(inspection.requests, Uint16Array.of(7));

        const measured = inspector.measure(
            { ...files(), irx: null, libsd: null },
            0,
            0,
            true,
            30,
        );
        thirdWorker.emitMessage({
            t: "se-measure-done",
            id: postedWorkerId(thirdWorker),
            measure: { frames: 480, sustained: false, estimated: false },
        });
        assert.deepEqual(await measured, {
            frames: 480,
            sustained: false,
            estimated: false,
        });

        thirdWorker.postError = new Error("worker post denied");
        await assert.rejects(inspector.inspect(files()), /worker post denied/);

        thirdWorker.postError = null;
        const invalidTicks = inspector.inspect(files());
        thirdWorker.emitMessage({
            t: "se-inspect-done",
            id: postedWorkerId(thirdWorker),
            inspection: {
                requests: Uint16Array.of(1),
                details: [[null]],
                ticksPerSecond: Number.NaN,
            },
        });
        await assert.rejects(invalidTicks, /invalid SE worker response/);
        assert.equal(thirdWorker.terminated, true);

        const mismatchedDetails = inspector.inspect(files());
        const fourthWorker = SeWorkerDouble.instances[3]!;
        fourthWorker.emitMessage({
            t: "se-inspect-done",
            id: postedWorkerId(fourthWorker),
            inspection: {
                requests: Uint16Array.of(1),
                details: [[]],
                ticksPerSecond: 480,
            },
        });
        await assert.rejects(mismatchedDetails, /invalid SE worker response/);
        assert.equal(fourthWorker.terminated, true);

        const impossibleDetail = inspector.inspect(files());
        const fifthWorker = SeWorkerDouble.instances[4]!;
        fifthWorker.emitMessage({
            t: "se-inspect-done",
            id: postedWorkerId(fifthWorker),
            inspection: {
                requests: Uint16Array.of(1),
                details: [[{
                    durationTicks: 1,
                    exactFrames: 1,
                    consoleFrames: 1,
                    notes: 0,
                    controls: 0,
                    activeVoices: 0,
                    loopingVoices: 1,
                    sustainedVoices: 0,
                    sustained: false,
                    sourceEndExactFrame: 1,
                    sourceEndConsoleFrame: 1,
                    loop: null,
                    events: [],
                }]],
                ticksPerSecond: 480,
            },
        });
        await assert.rejects(impossibleDetail, /invalid SE worker response/);
        assert.equal(fifthWorker.terminated, true);

        const invalidMeasure = inspector.measure(
            { ...files(), irx: null, libsd: null },
            0,
            0,
            true,
            30,
        );
        const sixthWorker = SeWorkerDouble.instances[5]!;
        sixthWorker.emitMessage({
            t: "se-measure-done",
            id: postedWorkerId(sixthWorker),
            measure: { frames: -1, sustained: false, estimated: false },
        });

        await assert.rejects(invalidMeasure, /invalid SE worker response/);
        assert.equal(sixthWorker.terminated, true);

        const undecodable = inspector.inspect(files());
        const seventhWorker = SeWorkerDouble.instances[6]!;
        seventhWorker.emitMessageError();
        await assert.rejects(undecodable, /invalid SE worker response/);
        assert.equal(seventhWorker.terminated, true);
    } finally {
        inspector.dispose();
        restore();
    }
});

test("stream worker rejects unknown IDs and message deserialization failures", async () => {
    const restore = installWorkerDouble();
    const decoder = new StreamDecoder();
    try {
        const unknown = decoder.decode("call.vag", Uint8Array.of(1));
        const firstWorker = SeWorkerDouble.instances[0]!;
        firstWorker.emitMessage({
            t: "stream-done",
            id: postedWorkerId(firstWorker) + 1,
        });
        await assert.rejects(unknown, /invalid stream worker response/);
        assert.equal(firstWorker.terminated, true);

        const undecodable = decoder.decode("call.vag", Uint8Array.of(1));
        const secondWorker = SeWorkerDouble.instances[1]!;
        secondWorker.emitMessageError();
        await assert.rejects(undecodable, /invalid stream worker response/);
        assert.equal(secondWorker.terminated, true);
    } finally {
        decoder.dispose();
        restore();
    }
});
test("stream playback reports AudioContext resume failures", async () => {
    const priorContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
    const priorBuffer = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer");
    let stopped = false;
    class AudioBufferDouble {
        constructor(_options: unknown) {}
        copyToChannel(): void {}
    }
    class AudioContextDouble {
        readonly destination = {};
        readonly currentTime = 0;
        resume(): Promise<void> {
            return Promise.reject(new Error("audio output denied"));
        }
        createBufferSource() {
            return {
                buffer: null,
                onended: null,
                connect() {},
                start() {},
                stop() { stopped = true; },
            };
        }
    }
    Object.defineProperty(globalThis, "AudioContext", {
        configurable: true,
        value: AudioContextDouble,
    });
    Object.defineProperty(globalThis, "AudioBuffer", {
        configurable: true,
        value: AudioBufferDouble,
    });
    const player = new StreamPlayer();
    const failure = Promise.withResolvers<Error>();
    player.onerror = failure.resolve;
    player.load({
        name: "voice.x",
        header: {
            channels: 1,
            rate: 48000,
            loop: 0,
            loop_start: -1,
            length: 1,
            vol_l: Array<number>(8).fill(0),
            vol_r: Array<number>(8).fill(0),
            reverb: Array<number>(8).fill(0),
        },
        sectors: 1,
        padFrames: 0,
        samplesPerChannel: 1,
        pcm: Int16Array.of(0),
    }, true);
    try {
        player.play();
        assert.match((await failure.promise).message, /audio output denied/);
        assert.equal(player.playing(), false);
        assert.equal(stopped, true);
    } finally {
        player.stop();
        if (priorContext)
            Object.defineProperty(globalThis, "AudioContext", priorContext);
        else
            Reflect.deleteProperty(globalThis, "AudioContext");
        if (priorBuffer)
            Object.defineProperty(globalThis, "AudioBuffer", priorBuffer);
        else
            Reflect.deleteProperty(globalThis, "AudioBuffer");
    }
});

test("audio exporter retires workers after malformed responses", () => {
    const restore = installWorkerDouble();
    const exporter = new Exporter();
    const failures: string[] = [];
    exporter.onstatus = (message, error) => {
        if (error) failures.push(message);
    };
    const song = {
        hd: Uint8Array.of(1),
        bd: Uint8Array.of(2),
        mid: Uint8Array.of(3),
        irx: null,
        libsd: null,
    };
    const opts = {
        songvol: 44,
        revDepth: 0,
        exact: true,
        bright: true,
        loop: 0,
    };
    try {
        exporter.start("song", "", song, opts);
        const firstWorker = SeWorkerDouble.instances[0]!;
        firstWorker.emitMessage({ t: "done", frames: 0, wav: null });
        assert.equal(exporter.busy, false);
        assert.equal(firstWorker.terminated, true);
        assert.match(failures.at(-1) ?? "", /invalid audio export worker response/);

        exporter.start("song", "", song, opts);
        const secondWorker = SeWorkerDouble.instances[1]!;
        secondWorker.emitMessageError();
        assert.equal(exporter.busy, false);
        assert.equal(secondWorker.terminated, true);

        exporter.kit("song", song);
        const thirdWorker = SeWorkerDouble.instances[2]!;
        thirdWorker.emitMessage({
            t: "kit-done",
            entries: [{ name: "sample.wav", wav: new Uint8Array(44) }],
        });
        assert.equal(exporter.busy, false);
        assert.equal(thirdWorker.terminated, true);
    } finally {
        exporter.dispose();
        restore();
    }
});

test("resume surfaces localStorage operational failures", async () => {
    const storage = {
        getItem(): string | null {
            throw new Error("localStorage access denied");
        },
    } as unknown as Storage;
    const restore = installLocalStorage(storage);
    try {
        await assert.rejects(resumeSession(), /localStorage access denied/);
    } finally {
        restore();
    }
});

test("ephemeral disc reload does not resume a stale cached pointer", async () => {
    let pointerReads = 0;
    const storage = {
        getItem(): string | null {
            pointerReads++;
            return "stale-disc";
        },
    } as unknown as Storage;
    const restoreStorage = installLocalStorage(storage);
    const restoreHistory = installHistoryState({ ae3EphemeralDisc: true });
    try {
        assert.equal(await resumeSession(), null);
        assert.equal(pointerReads, 0);
    } finally {
        restoreHistory();
        restoreStorage();
    }
});

test("resume surfaces OPFS operational failures", async context => {
    const storage = {
        getItem(key: string): string | null {
            assert.equal(key, LAST_DISC_KEY);
            return "disc";
        },
    } as unknown as Storage;
    const restore = installLocalStorage(storage);
    context.mock.method(OpfsCache, "supported", () => true);
    context.mock.method(OpfsCache, "open", async (): Promise<OpfsCache> =>
        cacheDouble({
            async read(): Promise<Uint8Array | null> {
                throw new Error("OPFS session metadata read denied");
            },
        }));
    try {
        await assert.rejects(
            resumeSession(),
            /OPFS session metadata read denied/,
        );
    } finally {
        restore();
    }
});

test("resume reports damaged current metadata and ignores old versions", async context => {
    const storage = {
        getItem(): string | null { return "disc"; },
    } as unknown as Storage;
    const restore = installLocalStorage(storage);
    const payloads = [
        encoder.encode("{"),
        encoder.encode(JSON.stringify({
            v: 1,
            serial: null,
            volumeId: "APE3",
            songs: [],
            hasIrx: false,
            hasLibsd: false,
        })),
    ];
    context.mock.method(OpfsCache, "supported", () => true);
    context.mock.method(OpfsCache, "open", async (): Promise<OpfsCache> =>
        cacheDouble({
            async read(): Promise<Uint8Array | null> {
                return payloads.shift() ?? null;
            },
        }));
    try {
        await assert.rejects(resumeSession(), /cached disc metadata is damaged/);
        assert.equal(await resumeSession(), null);
    } finally {
        restore();
    }
});

test("resume accepts a complete persisted session shape", async context => {
    const storage = {
        getItem(): string | null { return "disc"; },
    } as unknown as Storage;
    const restore = installLocalStorage(storage);
    const metadata = encoder.encode(JSON.stringify({
        v: 2,
        sourceKey: "disc",
        serial: "SCUS_975.01",
        volumeId: "APE3",
        songs: [{
            name: "song",
            mid: "song.mid",
            hd: "song.hd",
            bd: "song.bd",
            songvol: 64,
            volumeScale: 1,
        }],
        hasIrx: true,
        hasLibsd: true,
        assets: [
            "bgm/song.hd",
            "bgm/song.bd",
            "bgm/song.mid",
            "irx/sg2iopm1.irx",
            "irx/libsd.irx",
        ].map((name, index) => ({
            name,
            bytes: index + 1,
            sha256: index.toString(16).repeat(64),
        })),
    }));
    context.mock.method(OpfsCache, "supported", () => true);
    context.mock.method(OpfsCache, "open", async (): Promise<OpfsCache> =>
        cacheDouble({
            async read(): Promise<Uint8Array> { return metadata; },
        }));
    try {
        const resumed = await resumeSession();
        assert.equal(resumed?.serial, "SCUS_975.01");
        assert.deepEqual(resumed?.songs.map(song => song.name), ["song"]);
        assert.equal(resumed?.persistenceWarning, null);
    } finally {
        restore();
    }
});

test("every non-US or unknown build keeps a conservative support warning", () => {
    assert.equal(discSupportWarning("SCUS_975.01"), "");
    for (const serial of [
        "PCPX_966.57",
        "SCKA_200.62",
        "SCES_536.42",
        null,
    ]) {
        const warning = discSupportWarning(serial);
        assert.match(warning, /partially tested|untested/);
        if (serial) assert.match(warning, new RegExp(serial.replace(".", "\\.")));
    }
});

test("friendly errors retain technical detail without exposing source paths", () => {
    const local = friendlyError(new Error(
        "/Users/example/Downloads/Ape Escape 3.iso: permission denied",
    ));
    assert.doesNotMatch(local, /\/Users|Downloads|Ape Escape 3\.iso/);
    assert.match(local, /permission denied|local data/i);

    const spacedPosix = friendlyError(new Error(
        "could not read /tmp/Ape Escape 3.iso",
    ));
    assert.equal(spacedPosix, "local data access failed");

    const internal = friendlyError(new Error(
        "debug/uk/movie/new_play01.str at 0x830: expected GroupOfDataInfo, found empty",
    ));
    assert.doesNotMatch(internal, /debug\/uk|new_play01\.str/);
    assert.match(internal, /0x830.*expected GroupOfDataInfo/);

    const punctuated = friendlyError(new Error(
        "parser failed: debug/uk/movie/new_play02.str: bad header",
    ));
    assert.doesNotMatch(punctuated, /debug[\\/]uk|new_play02/);
    assert.match(punctuated, /parser failed.*bad header/);

    const windowsRelative = friendlyError(new Error(
        "parser failed; debug\\kr\\movie\\new_scene01.str: bad header",
    ));
    assert.doesNotMatch(windowsRelative, /debug|new_scene01/);
    assert.match(windowsRelative, /bad header/);

    for (const source of [
        "file:///Users/example/Downloads/Ape%20Escape%203.iso: denied",
        "open failed: C:\\Users\\example\\disc.iso: denied",
        "open failed: \\\\server\\share\\secret\\disc.iso: denied",
    ]) {
        const reason = friendlyError(new Error(source));
        assert.doesNotMatch(
            reason,
            /file:|Users|Downloads|C:\\|server|share|secret|disc\.iso/i,
        );
    }
});

test("cache and attached-source guards reject cross-disc reuse", () => {
    const cache = { key: "disc-a" };
    assert.doesNotThrow(() => {
        assertCacheSourceIdentity(cache, "disc-a");
        assertAttachedDiscIdentity("disc-a", "disc-a");
    });
    assert.throws(
        () => assertCacheSourceIdentity(null, null as never),
        /identity is unavailable/,
    );
    assert.throws(
        () => assertAttachedDiscIdentity(null as never, "disc-a"),
        /identity is unavailable/,
    );
    assert.throws(() => {
        new MovieStore(null, null, null as never);
    }, /identity is unavailable/);
    assert.throws(() => {
        new ImageStore(null, null, null as never);
    }, /identity is unavailable/);
    assert.throws(() => {
        new SeStore(null, null, null as never);
    }, /identity is unavailable/);
    assert.throws(
        () => assertCacheSourceIdentity(cache, "disc-b"),
        /different disc session/,
    );
    assert.throws(
        () => assertAttachedDiscIdentity("disc-a", "disc-b"),
        /different disc/,
    );
    assert.throws(() => {
        new MovieStore(cache as never, null, "disc-b");
    }, /different disc session/);
    assert.throws(() => {
        new ImageStore(cache as never, null, "disc-b");
    }, /different disc session/);
    assert.throws(() => {
        new SeStore(cache as never, null, "disc-b");
    }, /different disc session/);
});
