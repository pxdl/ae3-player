const MAX_TECHNICAL_REASON = 320;
const SOURCE_OFFSET = /\s+at\s+0x[0-9a-f]+:\s*/i;
const PATH_PREFIX = /^(.+?):\s+(.+)$/s;
const DISC_PATH = /(^|[\s("'`=,:;\[])(?:[A-Za-z]:[\\/]|\/|\\\\)?(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+)/g;

function hasPathSyntax(value: string): boolean {
    return value.includes("/") || value.includes("\\")
        || /^file:/i.test(value) || /^[a-z]:/i.test(value);
}

function containsLocalPath(value: string): boolean {
    const normalized = value.replaceAll("\\", "/").toLowerCase();
    return /(^|[\s("'`=,:;\[])\/(?!\/)/.test(value)
        || normalized.includes("/users/")
        || normalized.includes("/home/")
        || normalized.includes("/volumes/")
        || normalized.includes("file://")
        || /(^|[\s("'`=,:;\[])[a-z]:\//i.test(normalized)
        || /(^|[\s("'`=,:;\[])\\\\[^\\\s]+\\/i.test(value);
}

/** A bounded technical reason suitable for UI and persisted catalog errors. */
export function technicalReason(cause: unknown): string {
    const raw = cause instanceof Error ? cause.message : String(cause);
    let reason = raw.replace(/\s+/g, " ").trim();
    if (!reason) return "unknown error";

    const offset = SOURCE_OFFSET.exec(reason);
    if (offset && hasPathSyntax(reason.slice(0, offset.index)))
        reason = `disc format${reason.slice(offset.index)}`;
    else {
        const prefixed = PATH_PREFIX.exec(reason);
        if (prefixed && hasPathSyntax(prefixed[1]!))
            reason = `disc format: ${prefixed[2]}`;
    }

    if (containsLocalPath(reason))
        return "local data access failed";

    reason = reason.replace(DISC_PATH, "$1[disc asset]").trim();
    return reason.slice(0, MAX_TECHNICAL_REASON) || "unknown error";
}
