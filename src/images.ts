import {
    BlobSource,
    decodeTim2,
    inflateSz,
    memberBytes,
    openDisc,
    OpfsCache,
    readImageTexture,
    unpackPck,
    scanImageTextures,
    type ImageRole,
    type ImageTexture,
    type Vfi,
} from "./vendor/extract/index.ts";

const META = "image_meta.json";
const CONTAINER_CACHE_LIMIT = 4;


export interface ImageCatalog {
    v: 3;
    storage?: "textures" | "containers";
    textures: ImageTexture[];
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
    return `${directory}/${original}${suffix}.${extension}`.replace(/^\/+/, "");
}

export async function imagePng(data: Uint8Array, pictureIndex: number): Promise<Uint8Array> {
    const image = decodeTim2(data, pictureIndex);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable");
    context.putImageData(
        new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
        0,
        0,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value
            ? resolve(value)
            : reject(new Error("PNG encoding failed")), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
}

export class ImageStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string | null;
    private catalog: ImageCatalog | null = null;
    private containerCache = new Map<string, Promise<Uint8Array | null>>();

    constructor(cache: OpfsCache | null, vfi: Vfi | null,
                cacheKey: string | null) {
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }

    async cached(): Promise<ImageCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        const raw = await this.cache.read(META);
        if (!raw) return null;
        try {
            const catalog = JSON.parse(new TextDecoder().decode(raw)) as ImageCatalog;
            if (catalog.v !== 3 || !Array.isArray(catalog.textures)
                || (catalog.storage !== undefined
                    && catalog.storage !== "textures"
                    && catalog.storage !== "containers")
                || catalog.textures.some(texture =>
                    !Array.isArray(texture.pictures)
                    || !["sprite", "texture", "other"].includes(texture.role)))
                return null;
            this.catalog = catalog;
            return catalog;
        } catch {
            return null;
        }
    }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        if (this.cacheKey && disc.cacheKey !== this.cacheKey)
            throw new Error("this ISO is a different disc than the cached one "
                            + "-- forget the disc first to switch");
        this.vfi = disc.vfi;
    }

    async extract(progress: ImageProgress): Promise<ImageCatalog> {
        if (!this.vfi)
            throw new Error("no ISO attached -- choose your disc image first");
        let cache = this.cache;
        const textures = await scanImageTextures(this.vfi, {
            progress,
            container: async (entry, bytes) => {
                if (!cache) return;
                const id = entry.entryOff.toString(16).padStart(8, "0");
                const path = `image-container/${id}.bin`;
                try {
                    if (!await cache.has(path)) await cache.write(path, bytes);
                } catch (error) {
                    console.warn("OPFS failed; images remain available from the ISO", error);
                    cache = null;
                }
            },
        });
        const catalog: ImageCatalog = { v: 3, storage: "containers", textures };
        if (cache)
            await cache.write(META,
                new TextEncoder().encode(JSON.stringify(catalog)));
        this.catalog = catalog;
        return catalog;
    }

    private async readContainer(texture: ImageTexture): Promise<Uint8Array | null> {
        if (!this.cache) return null;
        const id = texture.id.slice(0, 8);
        let pending = this.containerCache.get(id);
        if (pending) {
            this.containerCache.delete(id);
            this.containerCache.set(id, pending);
        } else {
            pending = this.cache.read(`image-container/${id}.bin`).then(stored => {
                if (!stored) return null;
                return /\.sz$/i.test(texture.sourcePath) ? inflateSz(stored) : stored;
            });
            this.containerCache.set(id, pending);
            if (this.containerCache.size > CONTAINER_CACHE_LIMIT) {
                const oldest = this.containerCache.keys().next().value as string | undefined;
                if (oldest !== undefined) this.containerCache.delete(oldest);
            }
        }
        const container = await pending;
        if (!container) {
            this.containerCache.delete(id);
            return null;
        }
        if (texture.memberIndex === null) return container;
        const members = unpackPck(container);
        const member = members?.[texture.memberIndex];
        if (!member || member.name !== texture.memberName)
            throw new Error(`${texture.sourcePath}: cached image member changed`);
        return memberBytes(container, member);
    }

    async read(texture: ImageTexture): Promise<Uint8Array | null> {
        if (this.cache) {
            const catalog = this.catalog ?? await this.cached();
            if (catalog?.storage === "containers") {
                const cached = await this.readContainer(texture);
                if (cached) return cached;
            } else {
                const cached = await this.cache.read(`image/${texture.id}.tm2`);
                if (cached) return cached;
            }
        }
        return this.vfi ? readImageTexture(this.vfi, texture) : null;
    }
}
