import {
    BlobSource,
    decodeTim2,
    inflateSz,
    inspectTim2,
    memberBytes,
    openDisc,
    OpfsCache,
    unpackPck,
    scanImageTextures,
    type ImageRole,
    type ImageRoleEvidence,
    type ImageTexture,
    type Vfi,
} from "./vendor/extract/index.ts";
import type { ImageFormat } from "./vendor/extract/image-format.ts";
import type { ImageScanSkippedMember } from "./vendor/extract/images.ts";
import type { PckMember } from "./vendor/extract/pck.ts";
import {
    assertAttachedDiscIdentity,
    assertCacheSourceIdentity,
} from "./disc-identity.ts";
import { technicalReason } from "./errors.ts";
import {
    contentFingerprintMatches,
    fingerprintBytes,
    isContentFingerprint,
    type ContentFingerprint,
} from "./content-identity.ts";
import { assertZipEntryPath } from "./zip.ts";

const META = "image_meta.json";
const CONTAINER_CACHE_LIMIT = 4;


export interface ImageSourceIdentity extends ContentFingerprint {
    readonly entryOffset: number;
    readonly sourcePath: string;
}

export interface ImageCatalogIssue {
    readonly format: ImageFormat;
    readonly reason: string;
}

export type ImageCatalogSkippedMember = ImageScanSkippedMember;

export interface ImageCatalog {
    readonly v: 5;
    readonly sourceKey: string;
    readonly storage: "containers";
    readonly textures: readonly ImageTexture[];
    readonly sources: readonly ImageSourceIdentity[];
    readonly issues: readonly ImageCatalogIssue[];
    readonly skipped: readonly ImageCatalogSkippedMember[];
}

export interface ImageEntry {
    id: string;
    texture: ImageTexture;
    pictureIndex: number;
    width: number;
    height: number;
    imageType: number;
}

export type ImageProgress = (done: number, total: number, path: string) => void;
export type ImageRoleFilter = "all" | ImageRole;
export type ImageSortDirection = "asc" | "desc";

const IMAGE_NAME_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

export function sortImageEntries(entries: readonly ImageEntry[],
                                 direction: ImageSortDirection): ImageEntry[] {
    const order = direction === "asc" ? 1 : -1;
    return [...entries].sort((left, right) => {
        const name = IMAGE_NAME_COLLATOR.compare(
            left.texture.fileName,
            right.texture.fileName,
        );
        if (name !== 0) return name * order;
        const source = IMAGE_NAME_COLLATOR.compare(
            left.texture.sourcePath,
            right.texture.sourcePath,
        );
        if (source !== 0) return source * order;
        return left.pictureIndex - right.pictureIndex;
    });
}



export function imageEntries(catalog: ImageCatalog): ImageEntry[] {
    return catalog.textures.flatMap(texture => texture.pictures.map(picture => ({
        id: `${texture.id}:${picture.index}`,
        texture,
        pictureIndex: picture.index,
        width: picture.width,
        height: picture.height,
        imageType: picture.imageType,
    })));
}
export function filterImageEntries(entries: readonly ImageEntry[], query: string,
                                   role: ImageRoleFilter): ImageEntry[] {
    const normalized = query.trim().toLowerCase();
    return entries.filter(entry =>
        (role === "all" || entry.texture.role === role)
        && (!normalized
            || `${entry.texture.fileName} ${entry.texture.sourcePath} ${entry.texture.attrs}`
                .toLowerCase().includes(normalized)));
}

export function imageTreePath(entry: ImageEntry): string {
    const texture = entry.texture;
    const suffix = texture.pictures.length > 1 ? `_${entry.pictureIndex}` : "";
    const leaf = texture.fileName.replace(/\.tm2$/i, `${suffix}.tm2`);
    if (texture.memberIndex !== null) return `${texture.sourcePath}/${leaf}`;
    const slash = texture.sourcePath.lastIndexOf("/");
    return `${texture.sourcePath.slice(0, slash + 1)}${leaf}`;
}


export function imageExportPath(entry: ImageEntry, extension: "png" | "tm2"): string {
    const source = entry.texture.sourcePath.replace(/\.pck(?:\.sz)?$/i, "");
    const slash = source.lastIndexOf("/");
    const directory = entry.texture.memberIndex === null
        ? source.slice(0, Math.max(0, slash))
        : source;
    const original = entry.texture.fileName.replace(/\.tm2$/i, "");
    const suffix = entry.texture.pictures.length > 1 ? `_${entry.pictureIndex}` : "";
    const fileName = `${original}${suffix}.${extension}`;
    const path = directory ? `${directory}/${fileName}` : fileName;
    assertZipEntryPath(path);
    return path;
}

export async function imagePng(data: Uint8Array, pictureIndex: number): Promise<Uint8Array> {
    const image = decodeTim2(data, pictureIndex);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas is unavailable");
        context.putImageData(
            new ImageData(new Uint8ClampedArray(image.rgba.buffer as ArrayBuffer,
                image.rgba.byteOffset, image.rgba.byteLength), image.width, image.height),
            0,
            0,
        );
        const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(value => value
                ? resolve(value)
                : reject(new Error("PNG encoding failed")), "image/png");
        });
        return new Uint8Array(await blob.arrayBuffer());
    } finally {
        canvas.width = canvas.height = 1;
    }
}

function isImageRoleEvidence(value: unknown): value is ImageRoleEvidence {
    return value === "ui-reference"
        || value === "model-reference"
        || value === "ui-global-reference"
        || value === "model-global-reference"
        || value === "ui-package"
        || value === "model-package"
        || value === "ui-name-prefix"
        || value === "direct"
        || value === "unclassified";
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value)
        && value >= minimum;
}

interface ImageTextureLocator {
    readonly containerId: string;
    readonly entryOffset: number;
    readonly memberIndex: number | null;
}

const IMAGE_TEXTURE_ID = /^([0-9a-f]{8})-(direct|0|[1-9][0-9]*)$/i;

function imageTextureLocator(id: unknown): ImageTextureLocator | null {
    if (typeof id !== "string") return null;
    const match = IMAGE_TEXTURE_ID.exec(id);
    if (!match) return null;
    const entryOffset = Number.parseInt(match[1]!, 16);
    const memberIndex = match[2]!.toLowerCase() === "direct"
        ? null
        : Number(match[2]);
    if (!Number.isSafeInteger(entryOffset)
            || (memberIndex !== null && !Number.isSafeInteger(memberIndex)))
        return null;
    return {
        containerId: entryOffset.toString(16).padStart(8, "0"),
        entryOffset,
        memberIndex,
    };
}

function isImageFormat(value: unknown): value is ImageFormat {
    return value === "TIM2" || value === "PCK" || value === "SZ";
}


function isImageCatalogSkippedMember(
    value: unknown,
): value is ImageCatalogSkippedMember {
    if (value === null || typeof value !== "object") return false;
    const skipped = value as Record<string, unknown>;
    return isSafeInteger(skipped.entryOffset)
        && typeof skipped.sourcePath === "string"
        && skipped.sourcePath.length > 0
        && skipped.sourcePath.length <= 4096
        && /\.pck(?:\.sz)?$/i.test(skipped.sourcePath)
        && isSafeInteger(skipped.memberIndex)
        && typeof skipped.fileName === "string"
        && skipped.fileName.length > 0
        && skipped.fileName.length <= 1024
        && /\.tm2$/i.test(skipped.fileName)
        && isSafeInteger(skipped.byteLength)
        && skipped.reason === "missing-tim2-magic";
}

function isImageCatalogIssue(value: unknown): value is ImageCatalogIssue {
    if (value === null || typeof value !== "object") return false;
    const issue = value as Record<string, unknown>;
    return isImageFormat(issue.format)
        && typeof issue.reason === "string"
        && issue.reason.length > 0
        && issue.reason.length <= 320
        && technicalReason(issue.reason) === issue.reason;
}

function sourceIdentityKey(entryOffset: number, sourcePath: string): string {
    return `${entryOffset}\0${sourcePath}`;
}

function imageMemberKey(entryOffset: number, memberIndex: number): string {
    return `${entryOffset}\0${memberIndex}`;
}

function isImageCatalog(value: unknown, expectedSourceKey: string): value is ImageCatalog {
    if (value === null || typeof value !== "object") return false;
    const catalog = value as Record<string, unknown>;
    if (catalog.v !== 5
            || catalog.sourceKey !== expectedSourceKey
            || catalog.storage !== "containers"
            || !Array.isArray(catalog.textures)
            || !Array.isArray(catalog.sources)
            || !Array.isArray(catalog.issues)
            || catalog.issues.length > 4096
            || catalog.issues.some(issue => !isImageCatalogIssue(issue))
            || !Array.isArray(catalog.skipped)
            || catalog.skipped.length > 65536
            || catalog.skipped.some(item => !isImageCatalogSkippedMember(item)))
        return false;

    const sources = new Map<string, ImageSourceIdentity>();
    for (const value of catalog.sources) {
        if (value === null || typeof value !== "object") return false;
        const candidate = value as Record<string, unknown>;
        if (!isContentFingerprint(value)
                || !isSafeInteger(candidate.entryOffset)
                || typeof candidate.sourcePath !== "string"
                || candidate.sourcePath.length === 0)
            return false;
        const source = value as ImageSourceIdentity;
        const key = sourceIdentityKey(source.entryOffset, source.sourcePath);
        if (sources.has(key)) return false;
        sources.set(key, source);
    }

    const skippedMembers = new Set<string>();
    for (const value of catalog.skipped) {
        const skipped = value as ImageCatalogSkippedMember;
        const key = imageMemberKey(skipped.entryOffset, skipped.memberIndex);
        if (skippedMembers.has(key)) return false;
        skippedMembers.add(key);
    }

    const ids = new Set<string>();
    const usedSources = new Set<string>();
    for (const value of catalog.textures) {
        if (value === null || typeof value !== "object") return false;
        const texture = value as Record<string, unknown>;
        const locator = imageTextureLocator(texture.id);
        if (!locator
                || ids.has(texture.id as string)
                || locator.memberIndex !== texture.memberIndex
                || (locator.memberIndex !== null
                    && skippedMembers.has(imageMemberKey(
                        locator.entryOffset,
                        locator.memberIndex,
                    )))
                || typeof texture.sourcePath !== "string"
                || texture.sourcePath.length === 0
                || !sources.has(sourceIdentityKey(
                    locator.entryOffset,
                    texture.sourcePath,
                ))
                || typeof texture.fileName !== "string"
                || texture.fileName.length === 0
                || typeof texture.attrs !== "string"
                || !isSafeInteger(texture.byteLength, 1)
                || (texture.role !== "sprite"
                    && texture.role !== "texture"
                    && texture.role !== "other")
                || !isImageRoleEvidence(texture.roleEvidence)
                || !Array.isArray(texture.pictures)
                || texture.pictures.length === 0)
            return false;
        const memberPair =
            (texture.memberIndex === null && texture.memberName === null)
            || (isSafeInteger(texture.memberIndex)
                && typeof texture.memberName === "string"
                && texture.memberName.length > 0);
        if (!memberPair || texture.pictures.some((value, index) => {
            if (value === null || typeof value !== "object") return true;
            const picture = value as Record<string, unknown>;
            return picture.index !== index
                || !isSafeInteger(picture.width, 1)
                || !isSafeInteger(picture.height, 1)
                || !isSafeInteger(picture.imageType)
                || !isSafeInteger(picture.clutType)
                || !isSafeInteger(picture.colorCount)
                || !isSafeInteger(picture.mipmapCount, 1);
        }))
            return false;
        ids.add(texture.id as string);
        usedSources.add(sourceIdentityKey(locator.entryOffset, texture.sourcePath));
    }
    return usedSources.size === sources.size;
}

interface ImageContainer {
    bytes: Uint8Array;
    members: PckMember[] | null;
}

export class ImageStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string;
    private catalog: ImageCatalog | null = null;
    private containerCache = new Map<string, Promise<ImageContainer | null>>();
    private cacheWarning: string | null = null;

    constructor(cache: OpfsCache | null, vfi: Vfi | null,
                cacheKey: string) {
        assertCacheSourceIdentity(cache, cacheKey);
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }
    get persistenceWarning(): string | null { return this.cacheWarning; }

    async cached(): Promise<ImageCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        let raw: Uint8Array | null;
        try {
            raw = await this.cache.read(META);
        } catch (error) {
            this.useIsoAfterCacheFailure(
                error,
                "the image cache is unavailable -- reconnect the same disc to rebuild it or forget the disc cache",
            );
            return null;
        }
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch (error) {
            return this.rebuildInvalidCatalog(error);
        }
        if (!isImageCatalog(parsed, this.cacheKey)) {
            return this.rebuildInvalidCatalog(
                new Error("the cached image index has an invalid or obsolete schema"),
            );
        }
        this.catalog = parsed;
        return parsed;
    }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        assertAttachedDiscIdentity(this.cacheKey, disc.cacheKey);
        this.vfi = disc.vfi;
        this.containerCache.clear();
    }

    private rebuildInvalidCatalog(error: unknown): null {
        const message = "the cached image index is damaged or obsolete -- "
            + "reconnect the same disc to rebuild it or forget the disc cache";
        if (!this.vfi) throw new Error(message, { cause: error });
        this.catalog = null;
        this.containerCache.clear();
        this.cacheWarning = `rebuilding the image index from the attached ISO `
            + `(${technicalReason(error)})`;
        return null;
    }

    private useIsoAfterCacheFailure(error: unknown, message: string): void {
        if (!this.vfi)
            throw new Error(message, { cause: error });
        this.cacheWarning = `${message} (${technicalReason(error)}); `
            + "using the attached ISO for this session";
        console.warn(`${message}; using the attached ISO`, error);
        this.cache = null;
        this.containerCache.clear();
    }

    async extract(progress: ImageProgress): Promise<ImageCatalog> {
        const vfi = this.vfi;
        if (!vfi)
            throw new Error("no ISO attached -- choose your disc image first");
        let cache = this.cache;
        const sources: ImageSourceIdentity[] = [];
        const scan = await scanImageTextures(vfi, {
            progress,
            container: async (entry, bytes) => {
                const identity = await fingerprintBytes(bytes);
                sources.push({
                    entryOffset: entry.entryOff,
                    sourcePath: entry.path,
                    ...identity,
                });
                if (!cache) return;
                const id = entry.entryOff.toString(16).padStart(8, "0");
                try {
                    await cache.write(`image-container/${id}.bin`, bytes);
                } catch (error) {
                    this.useIsoAfterCacheFailure(
                        error,
                        "cached image storage is unavailable",
                    );
                    cache = null;
                }
            },
        });
        sources.sort((left, right) => left.entryOffset - right.entryOffset);
        const skipped = scan.skipped;
        skipped.sort((left, right) => {
            const source = IMAGE_NAME_COLLATOR.compare(
                left.sourcePath,
                right.sourcePath,
            );
            return source || left.memberIndex - right.memberIndex;
        });
        const issues = scan.issues.map(issue => ({
            format: issue.format,
            reason: technicalReason(issue.reason),
        }));
        const catalog: ImageCatalog = {
            v: 5,
            sourceKey: this.cacheKey,
            storage: "containers",
            textures: scan.textures,
            sources,
            issues,
            skipped,
        };
        if (cache) {
            try {
                await cache.write(META,
                    new TextEncoder().encode(JSON.stringify(catalog)));
                this.cacheWarning = null;
            } catch (error) {
                this.useIsoAfterCacheFailure(
                    error,
                    "cached image storage is unavailable",
                );
            }
        }
        this.containerCache.clear();
        this.catalog = catalog;
        return catalog;
    }

    private sourceIdentity(texture: ImageTexture,
                           locator: ImageTextureLocator,
                           catalog: ImageCatalog): ImageSourceIdentity {
        const source = catalog.sources.find(candidate =>
            candidate.entryOffset === locator.entryOffset
            && candidate.sourcePath === texture.sourcePath);
        if (!source)
            throw new Error("the image source identity is missing from the catalog");
        return source;
    }

    private async loadContainer(texture: ImageTexture,
                                locator: ImageTextureLocator,
                                expected: ImageSourceIdentity): Promise<ImageContainer | null> {
        let stored: Uint8Array | null;
        if (this.vfi) {
            const entry = this.vfi.entries.find(candidate =>
                candidate.entryOff === locator.entryOffset
                && candidate.path === expected.sourcePath);
            if (!entry)
                throw new Error("the image source is missing from the attached disc");
            stored = await this.vfi.read(entry);
        } else {
            if (!this.cache) return null;
            try {
                stored = await this.cache.read(
                    `image-container/${locator.containerId}.bin`,
                );
            } catch (error) {
                this.useIsoAfterCacheFailure(
                    error,
                    "the image cache is unavailable -- reconnect the same disc or forget the disc cache",
                );
                return null;
            }
        }
        if (!stored) return null;
        const actual = await fingerprintBytes(stored);
        if (!contentFingerprintMatches(actual, expected)) {
            this.catalog = null;
            this.containerCache.clear();
            throw new Error(
                "the image source content does not match this catalog -- "
                + "reconnect the same disc or forget the disc cache",
            );
        }
        const bytes = /\.sz$/i.test(texture.sourcePath)
            ? await inflateSz(stored, "image source")
            : stored;
        return {
            bytes,
            members: locator.memberIndex === null ? null : unpackPck(bytes, "image source"),
        };
    }

    private async readContainer(texture: ImageTexture,
                                locator: ImageTextureLocator,
                                expected: ImageSourceIdentity): Promise<ImageContainer | null> {
        const id = `${locator.containerId}:${expected.sha256}`;
        let pending = this.containerCache.get(id);
        if (pending) {
            this.containerCache.delete(id);
            this.containerCache.set(id, pending);
        } else {
            pending = this.loadContainer(texture, locator, expected);
            this.containerCache.set(id, pending);
            if (this.containerCache.size > CONTAINER_CACHE_LIMIT) {
                const oldest = this.containerCache.keys().next().value as string | undefined;
                if (oldest !== undefined) this.containerCache.delete(oldest);
            }
        }
        try {
            const container = await pending;
            if (!container && this.containerCache.get(id) === pending)
                this.containerCache.delete(id);
            return container;
        } catch (error) {
            if (this.containerCache.get(id) === pending) this.containerCache.delete(id);
            throw error;
        }
    }

    async read(texture: ImageTexture): Promise<Uint8Array | null> {
        const locator = imageTextureLocator(texture.id);
        if (!locator || locator.memberIndex !== texture.memberIndex)
            throw new Error("the image texture identifier is invalid");
        const catalog = this.catalog ?? await this.cached();
        if (!catalog) return null;
        const expected = this.sourceIdentity(texture, locator, catalog);
        const container = await this.readContainer(texture, locator, expected);
        if (!container) return null;

        if (locator.memberIndex === null) {
            inspectTim2(container.bytes, "image source");
            return container.bytes;
        }
        const member = container.members?.[locator.memberIndex];
        if (!member || member.name !== texture.memberName)
            throw new Error("the image member does not match this catalog");
        const bytes = memberBytes(container.bytes, member);
        inspectTim2(bytes, "image member");
        return bytes;
    }
}
