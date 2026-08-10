export interface DiscCacheIdentity {
    readonly key: string;
}

const CACHE_MISMATCH = "cached assets belong to a different disc session "
    + "-- clear data before switching discs";
const SOURCE_MISMATCH = "this ISO is a different disc than the cached one "
    + "-- clear data before switching discs";
const IDENTITY_UNAVAILABLE = "disc source identity is unavailable "
    + "-- reconnect the disc before using cached assets";

function requireIdentity(key: string): void {
    if (typeof key !== "string" || key.length === 0)
        throw new Error(IDENTITY_UNAVAILABLE);
}


/** Refuse a cache namespace that was not derived from this session's source. */
export function assertCacheSourceIdentity(cache: DiscCacheIdentity | null,
                                          sourceKey: string): void {
    requireIdentity(sourceKey);
    if (cache) requireIdentity(cache.key);
    if (cache && cache.key !== sourceKey)
        throw new Error(CACHE_MISMATCH);
}

/** Refuse to attach source containers from another disc to a cached catalog. */
export function assertAttachedDiscIdentity(expectedKey: string,
                                           attachedKey: string): void {
    requireIdentity(expectedKey);
    requireIdentity(attachedKey);
    if (expectedKey !== attachedKey)
        throw new Error(SOURCE_MISMATCH);
}
