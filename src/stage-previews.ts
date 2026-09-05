import {
    BlobSource,
    decodeTim2,
    inspectIpc,
    openDisc,
    OpfsCache,
    packfileMemberBytes,
    parsePackfile,
    type IpcInfo,
    type Packfile,
    type PackfileMember,
    type Tim2PictureInfo,
    type Vfi,
    type VfiEntry,
} from "./vendor/extract/index.ts";
import { assertAttachedDiscIdentity, assertCacheSourceIdentity } from "./disc-identity.ts";
import {
    contentFingerprintMatches, fingerprintBytes, isContentFingerprint,
    type ContentFingerprint,
} from "./content-identity.ts";
import { assertZipEntryPath } from "./zip.ts";

const META = "stage-previews/catalog.json";
const ARCHIVE_SUFFIX = "/etc/warpgate/str/stages.bin";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface StagePreviewMember {
    sourcePath: string;
    slotIndex: number;
    memberIndex: number;
    kind: "ipc" | "tm2";
    name: string;
    size: number;
}

export interface StagePreviewFrame {
    frame: number;
    member: StagePreviewMember;
    ipc: IpcInfo;
}

export interface StagePreviewTitle {
    member: StagePreviewMember;
    picture: Tim2PictureInfo;
}

export interface StagePreviewEntry {
    id: string;
    sourcePath: string;
    slotIndex: number;
    key: string;
    frames: StagePreviewFrame[];
    title: StagePreviewTitle;
}

export interface StagePreviewArchive {
    sourcePath: string;
    archiveSize: number;
    fingerprint: ContentFingerprint;
    slotCount: number;
    slotSize: number;
    storedSlotSize: number;
    compressed: boolean;
    stages: StagePreviewEntry[];
}

export interface StagePreviewCatalog {
    v: 2;
    sourceKey: string;
    archives: StagePreviewArchive[];
}

interface ParsedStageArchive {
    catalog: StagePreviewArchive;
    pack: Packfile;
}

function locateArchives(vfi: Vfi): VfiEntry[] {
    const entries = vfi.entries.filter(entry =>
        `/${entry.path}`.toLowerCase().endsWith(ARCHIVE_SUFFIX));
    const paths = new Set<string>();
    for (const entry of entries) {
        assertZipEntryPath(entry.path);
        if (paths.has(entry.path))
            throw new Error(`duplicate stage archive source ${entry.path}`);
        paths.add(entry.path);
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function memberReference(member: PackfileMember, sourcePath: string): StagePreviewMember {
    if (member.kind !== "ipc" && member.kind !== "tm2")
        throw new Error(`stage slot ${member.slotIndex}: unsupported member kind ${member.kind}`);
    return {
        sourcePath,
        slotIndex: member.slotIndex,
        memberIndex: member.index,
        kind: member.kind,
        name: member.name,
        size: member.size,
    };
}

function frameNumber(name: string): { key: string; frame: number } | null {
    const match = /^tv_(.+)_(\d{2})$/.exec(name);
    if (!match) return null;
    return { key: match[1]!, frame: Number(match[2]) };
}

function titleKey(name: string): string | null {
    return /^tv_(.+)_t$/.exec(name)?.[1] ?? null;
}

function pathFor(sourcePath: string, name: string, kind: string): string {
    return `${sourcePath}:${name}.${kind}`;
}

export async function parseStagePreviewArchive(
    archive: Uint8Array,
    sourcePath = "etc/warpgate/str/stages.bin",
): Promise<ParsedStageArchive> {
    assertZipEntryPath(sourcePath);
    const pack = await parsePackfile(archive, sourcePath);
    if (!pack.reservedZero)
        throw new Error(`${sourcePath}: packfile header reserved bytes are nonzero`);
    if (pack.slots.length === 0)
        throw new Error(`${sourcePath}: stage packfile contains no slots`);

    const seenKeys = new Set<string>();
    const stages: StagePreviewEntry[] = [];
    for (const slot of pack.slots) {
        if (!slot.storagePaddingZero)
            throw new Error(`${sourcePath}: slot ${slot.index} has malformed compressed storage padding`);
        if (!slot.paddingZero)
            throw new Error(`${sourcePath}: slot ${slot.index} has nonzero data after end\0`);

        let key: string | null = null;
        let title: StagePreviewTitle | null = null;
        const frames: StagePreviewFrame[] = [];
        const seenFrames = new Set<number>();
        for (const member of slot.members) {
            if (!member.reservedZero)
                throw new Error(`${sourcePath}: slot ${slot.index} member ${member.index} has nonzero reserved bytes`);
            const frame = frameNumber(member.name);
            const memberTitleKey = titleKey(member.name);
            if (frame) {
                if (member.kind !== "ipc")
                    throw new Error(`${pathFor(sourcePath, member.name, member.kind)}: numbered stage member is not IPC`);
                if (frame.frame < 0 || frame.frame > 7)
                    throw new Error(`${pathFor(sourcePath, member.name, member.kind)}: frame index must be 00 through 07`);
                if (seenFrames.has(frame.frame))
                    throw new Error(`${sourcePath}: slot ${slot.index} repeats frame ${frame.frame.toString().padStart(2, "0")}`);
                if (key !== null && key !== frame.key)
                    throw new Error(`${sourcePath}: slot ${slot.index} mixes stage keys ${key} and ${frame.key}`);
                key = frame.key;
                seenFrames.add(frame.frame);
                const bytes = packfileMemberBytes(pack, member);
                const ipc = inspectIpc(bytes, pathFor(sourcePath, member.name, member.kind));
                if (ipc.width !== 256 || ipc.height !== 256)
                    throw new Error(`${pathFor(sourcePath, member.name, member.kind)}: expected a 256x256 still, got ${ipc.width}x${ipc.height}`);
                frames.push({
                    frame: frame.frame,
                    member: memberReference(member, sourcePath),
                    ipc,
                });
                continue;
            }
            if (memberTitleKey !== null) {
                if (member.kind !== "tm2")
                    throw new Error(`${pathFor(sourcePath, member.name, member.kind)}: title member is not TIM2`);
                if (title)
                    throw new Error(`${sourcePath}: slot ${slot.index} contains more than one title TIM2`);
                if (key !== null && key !== memberTitleKey)
                    throw new Error(`${sourcePath}: slot ${slot.index} mixes stage keys ${key} and ${memberTitleKey}`);
                key = memberTitleKey;
                const image = decodeTim2(
                    packfileMemberBytes(pack, member),
                    0,
                    pathFor(sourcePath, member.name, member.kind),
                );
                const { rgba: _rgba, ...picture } = image;
                title = { member: memberReference(member, sourcePath), picture };
                continue;
            }
            throw new Error(`${sourcePath}: slot ${slot.index} has unexpected member ${member.name}.${member.kind}`);
        }

        if (key === null)
            throw new Error(`${sourcePath}: slot ${slot.index} has no stage key`);
        if (frames.length !== 8 || seenFrames.size !== 8)
            throw new Error(`${sourcePath}: stage ${key} has ${frames.length} IPC frames; expected 8`);
        for (let frame = 0; frame < 8; frame++) {
            if (!seenFrames.has(frame))
                throw new Error(`${sourcePath}: stage ${key} is missing frame ${frame.toString().padStart(2, "0")}`);
        }
        if (!title)
            throw new Error(`${sourcePath}: stage ${key} is missing its _t TIM2 title`);
        if (seenKeys.has(key))
            throw new Error(`${sourcePath}: stage key ${key} appears in more than one slot`);
        seenKeys.add(key);
        frames.sort((left, right) => left.frame - right.frame);
        stages.push({
            id: `${sourcePath}:${key}`, sourcePath,
            slotIndex: slot.index, key, frames, title,
        });
    }

    return {
        pack,
        catalog: {
            sourcePath,
            archiveSize: archive.length,
            fingerprint: await fingerprintBytes(archive),
            slotCount: pack.slotCount,
            slotSize: pack.slotSize,
            storedSlotSize: pack.storedSlotSize,
            compressed: pack.compressed,
            stages,
        },
    };
}

function isInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function validMember(value: unknown, slotIndex: number,
                     kind: "ipc" | "tm2", sourcePath: string): value is StagePreviewMember {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<StagePreviewMember>;
    return candidate.slotIndex === slotIndex
        && candidate.sourcePath === sourcePath
        && isInteger(candidate.memberIndex)
        && candidate.kind === kind
        && typeof candidate.name === "string"
        && isInteger(candidate.size);
}

function validPicture(value: unknown): value is Tim2PictureInfo {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<Tim2PictureInfo>;
    return isInteger(candidate.index)
        && isInteger(candidate.width, 1)
        && isInteger(candidate.height, 1)
        && isInteger(candidate.imageType)
        && isInteger(candidate.clutType)
        && isInteger(candidate.colorCount)
        && isInteger(candidate.mipmapCount);
}

const IPC_NUMBER_FIELDS: readonly (keyof IpcInfo)[] = [
    "version", "format", "width", "height", "control", "ipuFlags",
    "decodeCommand", "qwordCount", "payloadOffset", "payloadSize",
    "frameDataSize", "paddingSize",
];

function validIpc(value: unknown): value is IpcInfo {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<IpcInfo>;
    return IPC_NUMBER_FIELDS.every(field => isInteger(candidate[field]));
}

function validArchive(value: unknown): value is StagePreviewArchive {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<StagePreviewArchive>;
    if (typeof candidate.sourcePath !== "string"
        || !isInteger(candidate.archiveSize, 1) || !isInteger(candidate.slotCount, 1)
        || !isContentFingerprint(candidate.fingerprint)
        || candidate.fingerprint.bytes !== candidate.archiveSize
        || !isInteger(candidate.slotSize, 4) || !isInteger(candidate.storedSlotSize, 4)
        || typeof candidate.compressed !== "boolean" || !Array.isArray(candidate.stages)
        || candidate.stages.length !== candidate.slotCount)
        return false;
    try {
        assertZipEntryPath(candidate.sourcePath);
    } catch {
        return false;
    }
    const sourcePath = candidate.sourcePath;
    const keys = new Set<string>();
    return candidate.stages.every((value, slotIndex) => {
        if (typeof value !== "object" || value === null) return false;
        const stage = value as Partial<StagePreviewEntry>;
        if (stage.slotIndex !== slotIndex
            || typeof stage.key !== "string" || stage.key.length === 0
            || stage.sourcePath !== sourcePath || stage.id !== `${sourcePath}:${stage.key}`
            || keys.has(stage.key) || !Array.isArray(stage.frames)
            || stage.frames.length !== 8
            || typeof stage.title !== "object" || stage.title === null
            || !validMember(stage.title.member, slotIndex, "tm2", sourcePath)
            || !validPicture(stage.title.picture)
            || stage.title.member.name !== `tv_${stage.key}_t`)
            return false;
        keys.add(stage.key);
        return stage.frames.every((value, index) => {
            if (typeof value !== "object" || value === null) return false;
            const frame = value as Partial<StagePreviewFrame>;
            return frame.frame === index
                && validMember(frame.member, slotIndex, "ipc", sourcePath)
                && frame.member.name === `tv_${stage.key}_${index.toString().padStart(2, "0")}`
                && validIpc(frame.ipc);
        });
    });
}

function validCatalog(value: unknown, sourceKey: string): value is StagePreviewCatalog {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<StagePreviewCatalog>;
    if (candidate.v !== 2 || candidate.sourceKey !== sourceKey
            || !Array.isArray(candidate.archives) || candidate.archives.length === 0)
        return false;
    const sources = new Set<string>();
    return candidate.archives.every(archive => {
        if (!validArchive(archive) || sources.has(archive.sourcePath)
                || !`/${archive.sourcePath}`.toLowerCase().endsWith(ARCHIVE_SUFFIX))
            return false;
        sources.add(archive.sourcePath);
        return true;
    });
}

export class StagePreviewStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string;
    private packValue: { sourcePath: string; pack: Packfile } | null = null;
    private packPending: { sourcePath: string; promise: Promise<Packfile> } | null = null;
    private catalogValue: StagePreviewCatalog | null = null;
    private catalogPending: Promise<StagePreviewCatalog | null> | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null, cacheKey: string) {
        assertCacheSourceIdentity(cache, cacheKey);
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        assertAttachedDiscIdentity(this.cacheKey, disc.cacheKey);
        this.vfi = disc.vfi;
        this.catalogValue = null;
        this.catalogPending = null;
        this.packValue = null;
        this.packPending = null;
    }

    private async cachedCatalog(): Promise<StagePreviewCatalog | null> {
        if (!this.cache) return null;
        let raw: Uint8Array | null;
        try {
            raw = await this.cache.read(META);
        } catch (error) {
            if (!this.vfi)
                throw new Error("the stage-preview cache is unavailable -- reconnect the same disc", { cause: error });
            console.warn("Stage-preview cache unavailable; using the attached ISO", error);
            this.cache = null;
            return null;
        }
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(textDecoder.decode(raw));
        } catch {
            if (!this.vfi)
                throw new Error("the cached stage-preview index is damaged -- reconnect the same disc to rebuild it");
            return null;
        }
        // The old single-archive cache cannot prove that a disc has no other languages.
        if (typeof parsed === "object" && parsed !== null && "v" in parsed && parsed.v === 1)
            return null;
        if (validCatalog(parsed, this.cacheKey)) return parsed;
        if (!this.vfi)
            throw new Error("the cached stage-preview index is damaged -- reconnect the same disc to rebuild it");
        return null;
    }

    private async persist(path: string, bytes: Uint8Array): Promise<void> {
        if (!this.cache) return;
        try {
            await this.cache.write(path, bytes);
        } catch (error) {
            console.warn("OPFS stage-preview cache failed; previews remain available for this session", error);
            this.cache = null;
        }
    }

    private async loadCatalog(): Promise<StagePreviewCatalog | null> {
        const cached = await this.cachedCatalog();
        const sources = this.vfi ? locateArchives(this.vfi) : null;
        if (cached && this.cache) {
            let complete = sources === null || (sources.length === cached.archives.length
                && sources.every(source => cached.archives.some(archive =>
                    archive.sourcePath === source.path && archive.archiveSize === source.size)));
            try {
                for (const archive of cached.archives) {
                    if (await this.cache.size(`stage-previews-v2/${archive.sourcePath}`) !== archive.archiveSize)
                        complete = false;
                }
            } catch (error) {
                if (!this.vfi)
                    throw new Error("the stage-preview cache is unavailable -- reconnect the same disc", { cause: error });
                console.warn("Stage-preview cache unavailable; using the attached ISO", error);
                this.cache = null;
                complete = false;
            }
            if (complete) {
                this.catalogValue = cached;
                return cached;
            }
            if (!this.vfi)
                throw new Error("a cached stage-preview archive is missing or incomplete -- reconnect the same disc to rebuild it");
        }
        if (!this.vfi || !sources?.length) return null;
        const archives: StagePreviewArchive[] = [];
        for (const source of sources) {
            const bytes = await this.vfi.read(source);
            const parsed = await parseStagePreviewArchive(bytes, source.path);
            archives.push(parsed.catalog);
            // Keep only one decoded pack, not five localized archive copies.
            this.packValue ??= { sourcePath: source.path, pack: parsed.pack };
            await this.persist(`stage-previews-v2/${source.path}`, bytes);
        }
        const catalog: StagePreviewCatalog = { v: 2, sourceKey: this.cacheKey, archives };
        await this.persist(META, textEncoder.encode(JSON.stringify(catalog)));
        this.catalogValue = catalog;
        return catalog;
    }

    async catalog(): Promise<StagePreviewCatalog | null> {
        if (this.catalogValue) return this.catalogValue;
        if (this.catalogPending) return this.catalogPending;
        const pending = this.loadCatalog();
        this.catalogPending = pending;
        try {
            return await pending;
        } finally {
            if (this.catalogPending === pending) this.catalogPending = null;
        }
    }

    private async parsedPack(sourcePath: string): Promise<Packfile> {
        if (this.packValue?.sourcePath === sourcePath) return this.packValue.pack;
        if (this.packPending?.sourcePath === sourcePath) return this.packPending.promise;
        const pending = (async () => {
            const archive = await this.readArchive(sourcePath);
            if (!archive)
                throw new Error("the stage-preview archive is unavailable -- reconnect the same disc");
            const parsed = await parseStagePreviewArchive(archive, sourcePath);
            this.packValue = { sourcePath, pack: parsed.pack };
            return parsed.pack;
        })();
        this.packPending = { sourcePath, promise: pending };
        try {
            return await pending;
        } finally {
            if (this.packPending?.promise === pending) this.packPending = null;
        }
    }

    private async member(reference: StagePreviewMember): Promise<Uint8Array> {
        const pack = await this.parsedPack(reference.sourcePath);
        const member = pack.slots[reference.slotIndex]?.members[reference.memberIndex];
        if (!member || member.kind !== reference.kind || member.name !== reference.name
            || member.size !== reference.size)
            throw new Error(`stage-preview member ${reference.name}.${reference.kind} changed in ${reference.sourcePath}`);
        return packfileMemberBytes(pack, member);
    }

    async readFrame(frame: StagePreviewFrame): Promise<Uint8Array> {
        return this.member(frame.member);
    }

    async readTitle(title: StagePreviewTitle): Promise<Uint8Array> {
        return this.member(title.member);
    }

    async decodeTitle(title: StagePreviewTitle): Promise<ImageData> {
        const image = decodeTim2(await this.readTitle(title), 0, title.member.name);
        return new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height);
    }

    async readArchive(sourcePath: string): Promise<Uint8Array | null> {
        const catalog = await this.catalog();
        const archive = catalog?.archives.find(candidate => candidate.sourcePath === sourcePath);
        if (!archive) return null;
        let bytes: Uint8Array | null = null;
        if (this.vfi) {
            const source = this.vfi.entries.find(entry => entry.path === sourcePath);
            if (source) bytes = await this.vfi.read(source);
        } else if (this.cache) {
            bytes = await this.cache.read(`stage-previews-v2/${sourcePath}`);
        }
        if (bytes && !contentFingerprintMatches(archive.fingerprint, await fingerprintBytes(bytes)))
            throw new Error(`${sourcePath}: stage archive content does not match the catalog -- reconnect the same disc to rebuild it`);
        return bytes;
    }
}
