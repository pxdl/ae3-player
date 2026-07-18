/* OPFS-backed extraction cache (browser only). Point the app at the ISO
 * once; extracted assets land in origin-private storage keyed per disc
 * (Ae3Disc.cacheKey), and later visits skip straight to the player. The
 * "forget my disc" button is forget(). Nothing here runs under Node -- the
 * dev differ exercises the parsers, not this cache. */

const ROOT_DIR = "ae3-extract";

function sanitize(key: string): string {
    return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function baseDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

function isMissing(e: unknown): boolean {
    return e instanceof DOMException
        && (e.name === "NotFoundError" || e.name === "TypeMismatchError");
}

export class OpfsCache {
    private readonly dir: FileSystemDirectoryHandle;
    readonly key: string;

    private constructor(dir: FileSystemDirectoryHandle, key: string) {
        this.dir = dir;
        this.key = key;
    }

    static supported(): boolean {
        return typeof navigator !== "undefined"
            && typeof navigator.storage?.getDirectory === "function";
    }

    static async open(key: string): Promise<OpfsCache> {
        if (!OpfsCache.supported())
            throw new Error("OPFS is not available in this environment");
        const base = await baseDir();
        const dir = await base.getDirectoryHandle(sanitize(key), { create: true });
        return new OpfsCache(dir, key);
    }

    /** Names may contain '/'; intermediate directories are created on write. */
    private async fileHandle(name: string, create: boolean):
            Promise<FileSystemFileHandle> {
        const parts = name.split("/").filter(p => p.length > 0);
        if (parts.length === 0) throw new Error(`bad cache entry name: ${name}`);
        let dir = this.dir;
        for (const p of parts.slice(0, -1))
            dir = await dir.getDirectoryHandle(p, { create });
        return dir.getFileHandle(parts[parts.length - 1], { create });
    }

    async write(name: string, data: Uint8Array): Promise<void> {
        const fh = await this.fileHandle(name, true);
        const w = await fh.createWritable();
        await w.write(data as unknown as BufferSource);
        await w.close();
    }

    async read(name: string): Promise<Uint8Array | null> {
        try {
            const fh = await this.fileHandle(name, false);
            return new Uint8Array(await (await fh.getFile()).arrayBuffer());
        } catch (e) {
            if (isMissing(e)) return null;
            throw e;
        }
    }

    async has(name: string): Promise<boolean> {
        try {
            await this.fileHandle(name, false);
            return true;
        } catch (e) {
            if (isMissing(e)) return false;
            throw e;
        }
    }

    /** Drop this disc's whole cache subtree. */
    async forget(): Promise<void> {
        const base = await baseDir();
        try {
            await base.removeEntry(sanitize(this.key), { recursive: true });
        } catch (e) {
            if (!isMissing(e)) throw e;
        }
    }

    /** Drop every cached disc. */
    static async forgetAll(): Promise<void> {
        const root = await navigator.storage.getDirectory();
        try {
            await root.removeEntry(ROOT_DIR, { recursive: true });
        } catch (e) {
            if (!isMissing(e)) throw e;
        }
    }
}
