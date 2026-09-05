import {
    BlobSource,
    inflateSz,
    memberBytes,
    openDisc,
    OpfsCache,
    readModelAsset,
    readModelPackage,
    scanModelAssets,
    unpackPck,
    type ModelAsset,
    type PckMember,
    type Vfi,
} from "./vendor/extract/index.ts";

const META = "model_meta.json";
const PACKAGE_CACHE_LIMIT = 3;
const MODEL_ASSET_ID = /^[0-9a-f]{8}-(?:direct|[0-9]+)$/;

export interface ModelCatalog {
    v: 2;
    assets: ModelAsset[];
}

export type ModelProgress = (done: number, total: number, path: string) => void;

export interface ModelPackage {
    data: Uint8Array;
    members: PckMember[];
}

function isModelCatalog(value: unknown): value is ModelCatalog {
    if (!value || typeof value !== "object") return false;
    const catalog = value as Partial<ModelCatalog>;
    if (catalog.v !== 2 || !Array.isArray(catalog.assets)) return false;
    const ids = new Set<string>();
    const containers = new Map<string, string>();
    for (const asset of catalog.assets) {
        if (!asset || typeof asset !== "object"
            || (asset.kind !== "model" && asset.kind !== "animation" && asset.kind !== "collision")
            || typeof asset.id !== "string" || !MODEL_ASSET_ID.test(asset.id)
            || typeof asset.sourcePath !== "string" || !asset.sourcePath
            || typeof asset.fileName !== "string" || !asset.fileName
            || typeof asset.attrs !== "string"
            || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0)
            return false;
        if (asset.memberIndex === null) {
            if (asset.memberName !== null) return false;
        } else if (!Number.isSafeInteger(asset.memberIndex) || asset.memberIndex < 0
                   || typeof asset.memberName !== "string") return false;
        if (asset.id.slice(9) !== String(asset.memberIndex ?? "direct")
            || ids.has(asset.id)) return false;
        if (asset.kind === "model" && (!Array.isArray(asset.boneNames)
            || asset.boneNames.some(name => typeof name !== "string"))) return false;
        const container = asset.id.slice(0, 8);
        const source = containers.get(container);
        if (source !== undefined && source !== asset.sourcePath) return false;
        containers.set(container, asset.sourcePath);
        ids.add(asset.id);
    }
    return true;
}

export class ModelStore {
    private cache: OpfsCache | null;
    private vfi: Vfi | null;
    private readonly cacheKey: string | null;
    private catalog: ModelCatalog | null = null;
    private packageCache = new Map<string, Promise<ModelPackage | null>>();

    constructor(cache: OpfsCache | null, vfi: Vfi | null, cacheKey: string | null) {
        this.cache = cache;
        this.vfi = vfi;
        this.cacheKey = cacheKey;
    }

    hasIso(): boolean { return this.vfi !== null; }

    /** Release expanded packages when the browser leaves this disc. */
    clearMemoryCache(): void {
        this.packageCache.clear();
    }

    async cached(progress?: ModelProgress): Promise<ModelCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        let raw: Uint8Array | null;
        try {
            raw = await this.cache.read(META);
        } catch (error) {
            console.warn("OPFS failed while reading the 3D catalog", error);
            this.cache = null;
            if (!this.vfi)
                throw new Error("the 3D cache is unavailable -- reconnect the same ISO to rebuild the catalog",
                                { cause: error });
            return this.extract(progress);
        }
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch {
            return this.rebuildCatalog(progress);
        }
        if (!isModelCatalog(parsed)) return this.rebuildCatalog(progress);
        this.catalog = parsed;
        return parsed;
    }

    private async rebuildCatalog(progress?: ModelProgress): Promise<ModelCatalog> {
        this.clearMemoryCache();
        if (this.cache) {
            try {
                await this.cache.remove(META);
            } catch (error) {
                console.warn("OPFS failed while removing the obsolete 3D catalog", error);
                this.cache = null;
            }
        }
        if (!this.vfi)
            throw new Error("the cached 3D catalog is damaged or obsolete -- reconnect the same ISO to rebuild it");
        return this.extract(progress);
    }

    async attachIso(file: File): Promise<void> {
        const disc = await openDisc(new BlobSource(file));
        if (this.cacheKey && disc.cacheKey !== this.cacheKey)
            throw new Error("this ISO is a different disc than the cached one -- forget the disc first to switch");
        this.vfi = disc.vfi;
    }

    async extract(progress?: ModelProgress): Promise<ModelCatalog> {
        if (!this.vfi) throw new Error("no ISO attached -- choose your disc image first");
        const catalog: ModelCatalog = {
            v: 2,
            assets: await scanModelAssets(this.vfi, { progress }),
        };
        if (this.cache) {
            const metadata = new TextEncoder().encode(JSON.stringify(catalog));
            try {
                await this.cache.write(META, metadata);
            } catch (error) {
                console.warn("OPFS failed; the 3D catalog remains available for this session", error);
                this.cache = null;
            }
        }
        this.catalog = catalog;
        return catalog;
    }

    private packageKey(asset: ModelAsset): string {
        return asset.id.slice(0, 8);
    }

    private rememberPackage(key: string, value: Promise<ModelPackage | null>): void {
        this.packageCache.delete(key);
        this.packageCache.set(key, value);
        if (this.packageCache.size > PACKAGE_CACHE_LIMIT) {
            const oldest = this.packageCache.keys().next().value as string | undefined;
            if (oldest !== undefined) this.packageCache.delete(oldest);
        }
    }

    private async cachedPackage(asset: ModelAsset): Promise<ModelPackage | null> {
        if (!this.cache) return null;
        const key = this.packageKey(asset);
        const raw = await this.cache.read(`model-container/${key}.bin`);
        if (!raw) return null;
        const members = unpackPck(raw);
        if (members) return { data: raw, members };
        return asset.memberIndex === null ? { data: raw, members: [] } : null;
    }

    async package(asset: ModelAsset): Promise<ModelPackage | null> {
        const key = this.packageKey(asset);
        const existing = this.packageCache.get(key);
        if (existing) {
            this.rememberPackage(key, existing);
            return existing;
        }
        const pending = (async (): Promise<ModelPackage | null> => {
            const cached = await this.cachedPackage(asset);
            if (cached) return cached;
            if (!this.vfi) return null;
            const loaded = await readModelPackage(this.vfi, asset);
            if (this.cache) {
                try {
                    await this.cache.write(`model-container/${key}.bin`, loaded.data);
                } catch (error) {
                    console.warn("OPFS failed; this model remains available from the ISO", error);
                }
            }
            return loaded;
        })();
        this.rememberPackage(key, pending);
        try {
            const result = await pending;
            if (!result && this.packageCache.get(key) === pending) this.packageCache.delete(key);
            return result;
        } catch (error) {
            if (this.packageCache.get(key) === pending) this.packageCache.delete(key);
            throw error;
        }
    }

    async read(asset: ModelAsset): Promise<Uint8Array | null> {
        const source = await this.package(asset);
        if (source) {
            if (asset.memberIndex === null) return source.data;
            const member = source.members[asset.memberIndex];
            if (!member || member.name !== asset.memberName)
                throw new Error(`${asset.sourcePath}: cached model member changed`);
            return memberBytes(source.data, member);
        }
        return this.vfi ? readModelAsset(this.vfi, asset) : null;
    }
}

export function modelAssetStem(asset: ModelAsset): string {
    return asset.fileName.replace(/\.(?:i3d|i3m|i3c)$/i, "");
}

export function modelMemberStem(member: PckMember): string {
    const slash = Math.max(member.name.lastIndexOf("/"), member.name.lastIndexOf("\\"));
    return member.name.slice(slash + 1).replace(/\.tm2$/i, "").toLowerCase();
}

export function isTim2Member(data: Uint8Array, member: PckMember): boolean {
    if (member.size < 4) return false;
    const offset = member.offset;
    return data[offset] === 0x54 && data[offset + 1] === 0x49
        && data[offset + 2] === 0x4d && data[offset + 3] === 0x32;
}

export async function expandStoredModelContainer(stored: Uint8Array,
                                                  path: string): Promise<ModelPackage> {
    const data = /\.sz$/i.test(path) ? await inflateSz(stored) : stored;
    return { data, members: unpackPck(data) ?? [] };
}
