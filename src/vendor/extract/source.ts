/* Random-access byte source over whatever holds the disc image: a browser
 * File (the user points at their ISO; slices stream off disk on demand), an
 * in-memory buffer (tests, inflated blobs), or a window into another source
 * (DATA.BIN inside the ISO). Reads past EOF return what exists, like file
 * reads -- parsers check lengths, mirroring the Python oracles. */

export interface ByteSource {
    readonly size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}

export class BytesSource implements ByteSource {
    private readonly bytes: Uint8Array;
    constructor(bytes: Uint8Array) { this.bytes = bytes; }
    get size(): number { return this.bytes.length; }
    async read(offset: number, length: number): Promise<Uint8Array> {
        return this.bytes.subarray(offset, offset + length);
    }
}

export class BlobSource implements ByteSource {
    private readonly blob: Blob;
    constructor(blob: Blob) { this.blob = blob; }
    get size(): number { return this.blob.size; }
    async read(offset: number, length: number): Promise<Uint8Array> {
        const part = this.blob.slice(offset, offset + length);
        return new Uint8Array(await part.arrayBuffer());
    }
}

/** A byte window into a parent source. */
export class SubSource implements ByteSource {
    private readonly parent: ByteSource;
    private readonly base: number;
    readonly size: number;
    constructor(parent: ByteSource, base: number, size: number) {
        this.parent = parent;
        this.base = base;
        this.size = size;
    }
    async read(offset: number, length: number): Promise<Uint8Array> {
        const off = Math.min(offset, this.size);
        const len = Math.max(0, Math.min(length, this.size - off));
        return this.parent.read(this.base + off, len);
    }
}
