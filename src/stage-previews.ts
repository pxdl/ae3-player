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

const ARCHIVE = "stage-previews/stages.bin";
const META = "stage-previews/catalog.json";
const ARCHIVE_SUFFIX = "/etc/warpgate/str/stages.bin";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface StagePreviewMember {
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
    slotIndex: number;
    key: string;
    frames: StagePreviewFrame[];
    title: StagePreviewTitle;
}

export interface StagePreviewCatalog {
    v: 1;
    sourcePath: string;
    archiveSize: number;
    slotCount: number;
    slotSize: number;
    storedSlotSize: number;
    compressed: boolean;
    stages: StagePreviewEntry[];
}

interface ParsedStageArchive {
    catalog: StagePreviewCatalog;
    pack: Packfile;
}

function locateArchive(vfi: Vfi): VfiEntry | null {
    return vfi.entries.find(entry =>
        `/${entry.path}`.toLowerCase().endsWith(ARCHIVE_SUFFIX)) ?? null;
}

function memberReference(member: PackfileMember): StagePreviewMember {
    if (member.kind !== "ipc" && member.kind !== "tm2")
        throw new Error(`stage slot ${member.slotIndex}: unsupported member kind ${member.kind}`);
    return {
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
                    member: memberReference(member),
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
                title = { member: memberReference(member), picture };
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
        stages.push({ slotIndex: slot.index, key, frames, title });
    }

    return {
        pack,
        catalog: {
            v: 1,
            sourcePath,
            archiveSize: archive.length,
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
                     kind: "ipc" | "tm2"): value is StagePreviewMember {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<StagePreviewMember>;
    return candidate.slotIndex === slotIndex
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

function validCatalog(value: unknown): value is StagePreviewCatalog {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<StagePreviewCatalog>;
    if (candidate.v !== 1 || typeof candidate.sourcePath !== "string"
        || !isInteger(candidate.archiveSize, 1) || !isInteger(candidate.slotCount, 1)
        || !isInteger(candidate.slotSize, 4) || !isInteger(candidate.storedSlotSize, 4)
        || typeof candidate.compressed !== "boolean" || !Array.isArray(candidate.stages)
        || candidate.stages.length !== candidate.slotCount)
        return false;
    const keys = new Set<string>();
    return candidate.stages.every((value, slotIndex) => {
        if (typeof value !== "object" || value === null) return false;
        const stage = value as Partial<StagePreviewEntry>;
        if (stage.slotIndex !== slotIndex
            || typeof stage.key !== "string" || stage.key.length === 0
            || keys.has(stage.key) || !Array.isArray(stage.frames)
            || stage.frames.length !== 8
            || typeof stage.title !== "object" || stage.title === null
            || !validMember(stage.title.member, slotIndex, "tm2")
            || !validPicture(stage.title.picture)
            || stage.title.member.name !== `tv_${stage.key}_t`)
            return false;
        keys.add(stage.key);
        return stage.frames.every((value, index) => {
            if (typeof value !== "object" || value === null) return false;
            const frame = value as Partial<StagePreviewFrame>;
            return frame.frame === index
                && validMember(frame.member, slotIndex, "ipc")
                && frame.member.name === `tv_${stage.key}_${index.toString().padStart(2, "0")}`
                && validIpc(frame.ipc);
        });
    });
}

export class StagePreviewStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string | null;
    private archiveValue: Uint8Array | null = null;
    private packValue: Packfile | null = null;
    private catalogValue: StagePreviewCatalog | null = null;
    private catalogPending: Promise<StagePreviewCatalog | null> | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null, cacheKey: string | null) {
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        if (this.cacheKey && disc.cacheKey !== this.cacheKey)
            throw new Error("this ISO is a different disc than the cached one -- forget the disc first to switch");
        this.vfi = disc.vfi;
        this.catalogPending = null;
    }

    private async cachedCatalog(): Promise<StagePreviewCatalog | null> {
        if (!this.cache) return null;
        const raw = await this.cache.read(META);
        if (!raw) return null;
        try {
            const parsed: unknown = JSON.parse(textDecoder.decode(raw));
            return validCatalog(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    private async archive(): Promise<Uint8Array | null> {
        if (this.archiveValue) return this.archiveValue;
        if (this.cache) {
            const cached = await this.cache.read(ARCHIVE);
            if (cached) {
                this.archiveValue = cached;
                return cached;
            }
        }
        if (!this.vfi) return null;
        const entry = locateArchive(this.vfi);
        if (!entry) return null;
        const archive = await this.vfi.read(entry);
        this.archiveValue = archive;
        return archive;
    }

    private async persist(archive: Uint8Array, catalog: StagePreviewCatalog): Promise<void> {
        if (!this.cache) return;
        try {
            if (!await this.cache.has(ARCHIVE))
                await this.cache.write(ARCHIVE, archive);
            await this.cache.write(META, textEncoder.encode(JSON.stringify(catalog)));
        } catch (error) {
            console.warn("OPFS stage-preview cache failed; previews remain available for this session", error);
            this.cache = null;
        }
    }

    private async parseArchive(archive: Uint8Array, sourcePath: string): Promise<StagePreviewCatalog> {
        const parsed = await parseStagePreviewArchive(archive, sourcePath);
        this.packValue = parsed.pack;
        this.catalogValue = parsed.catalog;
        return parsed.catalog;
    }

    private async loadCatalog(): Promise<StagePreviewCatalog | null> {
        const cached = await this.cachedCatalog();
        if (cached && this.cache) {
            const archiveSize = await this.cache.size(ARCHIVE);
            if (archiveSize === cached.archiveSize) {
                this.catalogValue = cached;
                return cached;
            }
            if (archiveSize === null && !this.vfi)
                throw new Error("the cached stage-preview archive is missing -- reconnect the same disc to rebuild it or forget the disc cache");
        }

        const archive = await this.archive();
        if (!archive) return null;
        const sourcePath = cached?.sourcePath
            ?? (this.vfi ? locateArchive(this.vfi)?.path : null)
            ?? "etc/warpgate/str/stages.bin";
        const catalog = await this.parseArchive(archive, sourcePath);
        await this.persist(archive, catalog);
        return catalog;
    }

    async catalog(): Promise<StagePreviewCatalog | null> {
        if (this.catalogValue) return this.catalogValue;
        if (this.catalogPending) return this.catalogPending;
        const pending = this.loadCatalog();
        this.catalogPending = pending;
        try {
            return await pending;
        } catch (error) {
            if (this.catalogPending === pending) this.catalogPending = null;
            throw error;
        }
    }

    private async parsedPack(): Promise<Packfile> {
        if (this.packValue) return this.packValue;
        const catalog = await this.catalog();
        if (!catalog)
            throw new Error(this.vfi
                ? "stage previews are unavailable on this disc"
                : "no ISO attached -- choose your disc image first");
        const archive = await this.archive();
        if (!archive)
            throw new Error("the stage-preview archive is unavailable -- reconnect the same disc");
        const parsed = await parseStagePreviewArchive(archive, catalog.sourcePath);
        if (JSON.stringify(catalog) !== JSON.stringify(parsed.catalog)) {
            this.catalogValue = parsed.catalog;
            await this.persist(archive, parsed.catalog);
        }
        this.packValue = parsed.pack;
        return parsed.pack;
    }

    private async member(reference: StagePreviewMember): Promise<Uint8Array> {
        const pack = await this.parsedPack();
        const member = pack.slots[reference.slotIndex]?.members[reference.memberIndex];
        if (!member || member.kind !== reference.kind || member.name !== reference.name
            || member.size !== reference.size)
            throw new Error(`stage-preview member ${reference.name}.${reference.kind} changed in the cached archive`);
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

    async readArchive(): Promise<Uint8Array | null> {
        const catalog = await this.catalog();
        return catalog ? this.archive() : null;
    }
}
