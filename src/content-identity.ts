export interface ContentFingerprint {
    readonly bytes: number;
    readonly sha256: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isContentFingerprint(value: unknown): value is ContentFingerprint {
    if (value === null || typeof value !== "object") return false;
    const fingerprint = value as Record<string, unknown>;
    return Number.isSafeInteger(fingerprint.bytes)
        && (fingerprint.bytes as number) >= 0
        && typeof fingerprint.sha256 === "string"
        && SHA256_HEX.test(fingerprint.sha256);
}

export async function fingerprintBytes(bytes: Uint8Array): Promise<ContentFingerprint> {
    const source: Uint8Array<ArrayBuffer> = bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest("SHA-256", source);
    const sha256 = Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, "0")).join("");
    return { bytes: bytes.byteLength, sha256 };
}

export function contentFingerprintMatches(left: ContentFingerprint,
                                          right: ContentFingerprint): boolean {
    return left.bytes === right.bytes && left.sha256 === right.sha256;
}
