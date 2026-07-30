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

export interface ModelCatalog {
    v: 2;
    assets: ModelAsset[];
}

export type ModelProgress = (done: number, total: number, path: string) => void;

export interface ModelPackage {
    data: Uint8Array;
    members: PckMember[];
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

    async cached(): Promise<ModelCatalog | null> {
        if (this.catalog) return this.catalog;
        if (!this.cache) return null;
        const raw = await this.cache.read(META);
        if (!raw) return null;
        try {
            const catalog = JSON.parse(new TextDecoder().decode(raw)) as ModelCatalog;
            if (catalog.v !== 2 || !Array.isArray(catalog.assets)
                || catalog.assets.some(asset =>
                    !["model", "animation", "collision"].includes(asset.kind)
                    || (asset.kind === "model" && !Array.isArray(asset.boneNames))))
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
            throw new Error("this ISO is a different disc than the cached one -- forget the disc first to switch");
        this.vfi = disc.vfi;
    }

    async extract(progress: ModelProgress): Promise<ModelCatalog> {
        if (!this.vfi) throw new Error("no ISO attached -- choose your disc image first");
        const catalog: ModelCatalog = {
            v: 2,
            assets: await scanModelAssets(this.vfi, { progress }),
        };
        if (this.cache) {
            try {
                await this.cache.write(META,
                    new TextEncoder().encode(JSON.stringify(catalog)));
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
        const result = await pending;
        if (!result) this.packageCache.delete(key);
        return result;
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
