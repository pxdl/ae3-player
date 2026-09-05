import { inflateSz } from "./sz.ts";
import {
    memberBytes,
    pckFileNames,
    typeOf,
    unpackPck,
    type PckMember,
} from "./pck.ts";
import { inspectTim2, type Tim2PictureInfo } from "./tim2.ts";
import { type Vfi, type VfiEntry } from "./vfi.ts";
import { ImageFormatError, type ImageFormat } from "./image-format.ts";

export type ImageRole = "sprite" | "texture" | "other";
export type ImageRoleEvidence =
    "ui-reference" | "model-reference" | "ui-global-reference"
    | "model-global-reference" | "ui-package" | "model-package"
    | "ui-name-prefix" | "direct" | "unclassified";

export interface ImageTexture {
    id: string;
    sourcePath: string;
    memberIndex: number | null;
    memberName: string | null;
    fileName: string;
    attrs: string;
    byteLength: number;
    role: ImageRole;
    roleEvidence: ImageRoleEvidence;
    pictures: Tim2PictureInfo[];
}

export interface ImageScanIssue {
    /** Sanitized VFI path of the failed container, bounded for display. */
    path: string;
    /** Container format whose structural validation failed. */
    format: ImageFormat;
    /** Sanitized parser context and reason, bounded for display. */
    reason: string;
}

export interface ImageScanSkippedMember {
    readonly entryOffset: number;
    readonly sourcePath: string;
    readonly memberIndex: number;
    readonly fileName: string;
    readonly byteLength: number;
    readonly reason: "missing-tim2-magic";
}

export interface ImageScanResult {
    textures: ImageTexture[];
    issues: ImageScanIssue[];
    skipped: ImageScanSkippedMember[];
}

export interface ImageScanOptions {
    progress?: (done: number, total: number, path: string) => void;
    texture?: (texture: ImageTexture, bytes: Uint8Array) => void | Promise<void>;
    container?: (entry: VfiEntry, bytes: Uint8Array) => void | Promise<void>;
}

function hasTim2Magic(data: Uint8Array): boolean {
    return data.length >= 4 && data[0] === 0x54 && data[1] === 0x49
        && data[2] === 0x4d && data[3] === 0x32;
}

function textureId(entry: VfiEntry, memberIndex: number | null): string {
    return `${entry.entryOff.toString(16).padStart(8, "0")}-${memberIndex ?? "direct"}`;
}

const ASCII = new TextDecoder("ascii");

function memberStem(name: string): string {
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    return name.slice(slash + 1).replace(/\.tm2$/i, "").toLowerCase();
}

/* Geometry bytes produce millions of short printable runs. Validate stems in
 * place and reuse the at most 60,879 one-to-three-character normalized stems
 * instead of allocating a decoder result for every run. */
const SHORT_REFERENCE_STEMS = new Map<number, string>();

function referencedNames(data: Uint8Array): Set<string> {
    const references = new Set<string>();
    let start = 0;
    let valid = true;
    for (let index = 0; index <= data.length; index++) {
        const byte = index < data.length ? data[index]! : 0;
        if (byte >= 0x20 && byte < 0x7f) {
            if (byte === 0x2f || byte === 0x5c) {
                start = index + 1;
                valid = true;
            } else {
                const lower = byte | 0x20;
                valid &&= (lower >= 0x61 && lower <= 0x7a)
                    || (byte >= 0x30 && byte <= 0x39)
                    || byte === 0x5f || byte === 0x2e || byte === 0x2d;
            }
            continue;
        }
        if (valid) {
            let end = index;
            if (end - start >= 4 && data[end - 4] === 0x2e
                    && (data[end - 3]! | 0x20) === 0x74
                    && (data[end - 2]! | 0x20) === 0x6d
                    && data[end - 1] === 0x32)
                end -= 4;
            const length = end - start;
            if (length > 0 && length <= 64) {
                let stem: string;
                if (length <= 3) {
                    let key = 0;
                    for (let offset = start; offset < end; offset++) {
                        const character = data[offset]!;
                        key = (key << 7) | (character >= 0x41 && character <= 0x5a
                            ? character + 0x20 : character);
                    }
                    const cached = SHORT_REFERENCE_STEMS.get(key);
                    if (cached !== undefined) stem = cached;
                    else {
                        stem = ASCII.decode(data.subarray(start, end)).toLowerCase();
                        SHORT_REFERENCE_STEMS.set(key, stem);
                    }
                } else {
                    stem = ASCII.decode(data.subarray(start, end)).toLowerCase();
                }
                references.add(stem);
            }
        }
        start = index + 1;
        valid = true;
    }
    return references;
}

interface MemberClassifications {
    roles: Map<number, { role: ImageRole; evidence: ImageRoleEvidence }>;
    uiReferences: Set<string>;
    modelReferences: Set<string>;
}

function classifyMembers(pck: Uint8Array, members: PckMember[],
                         textures: PckMember[]): MemberClassifications {
    const uiReferences = new Set<string>();
    const modelReferences = new Set<string>();
    let hasUi = false;
    let hasModel = false;
    for (const member of members) {
        const type = typeOf(member.attrs);
        if (type !== "uis" && type !== "i3d") continue;
        if (type === "uis") hasUi = true;
        else hasModel = true;
        const target = type === "uis" ? uiReferences : modelReferences;
        for (const name of referencedNames(memberBytes(pck, member)))
            target.add(name);
    }

    const roles = new Map(textures.map(member => {
        const name = memberStem(member.name);
        const uiReference = uiReferences.has(name);
        const modelReference = modelReferences.has(name);
        let role: ImageRole = "other";
        let evidence: ImageRoleEvidence = "unclassified";
        if (uiReference && !modelReference) {
            role = "sprite";
            evidence = "ui-reference";
        } else if (modelReference && !uiReference) {
            role = "texture";
            evidence = "model-reference";
        } else if (hasUi && !hasModel) {
            role = "sprite";
            evidence = "ui-package";
        } else if (hasModel && !hasUi) {
            role = "texture";
            evidence = "model-package";
        }
        return [member.index, { role, evidence }] as const;
    }));
    return { roles, uiReferences, modelReferences };
}

/** VFI payloads that can contain source TIM2 textures. */
export function locateImageContainers(vfi: Vfi): VfiEntry[] {
    return vfi.entries.filter(entry =>
        /\.tm2$/i.test(entry.path) || /\.pck(?:\.sz)?$/i.test(entry.path));
}

interface ScannedImageContainer {
    entry: VfiEntry;
    stored: Uint8Array;
    images: Array<{ texture: ImageTexture; bytes: Uint8Array }>;
    uiReferences: Set<string>;
    modelReferences: Set<string>;
}

const IMAGE_SCAN_CONCURRENCY = 8;

const MAX_ISSUE_TEXT = 256;

function boundedIssueText(value: string, fallback: string): string {
    const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
        .replace(/(?:^|\s)(?:[A-Za-z]:[\\/]|\/)[^\s)]+/g, "$1<path>")
        .slice(0, MAX_ISSUE_TEXT);
    return text || fallback;
}

function issuePath(path: string): string {
    const normalized = path.replace(/\\/g, "/")
        .replace(/^[A-Za-z]:\/+/, "")
        .replace(/^\/+/, "");
    const segments = normalized.split("/")
        .filter(segment => segment.length > 0 && segment !== "." && segment !== "..")
        .map(segment => segment.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?"));
    return boundedIssueText(segments.join("/"), "image-container");
}

function imageIssue(entry: VfiEntry, error: ImageFormatError): ImageScanIssue {
    return {
        path: issuePath(entry.path),
        format: error.format,
        reason: boundedIssueText(
            `${error.source}: ${error.detail} (offset 0x${error.offset.toString(16)})`,
            "invalid image container format",
        ),
    };
}

async function scanImageContainer(entry: VfiEntry, stored: Uint8Array,
                                  skipped: ImageScanSkippedMember[]): Promise<ScannedImageContainer> {
    if (/\.tm2$/i.test(entry.path)) {
        const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        return {
            entry,
            stored,
            images: [{
                texture: {
                    id: textureId(entry, null), sourcePath: entry.path,
                    memberIndex: null, memberName: null, fileName, attrs: "tm2",
                    byteLength: stored.length, role: "other", roleEvidence: "direct",
                    pictures: inspectTim2(stored, entry.path),
                },
                bytes: stored,
            }],
            uiReferences: new Set(),
            modelReferences: new Set(),
        };
    }

    const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored, entry.path) : stored;
    const members = unpackPck(pck, entry.path);
    if (!members)
        throw new ImageFormatError(entry.path, 0, "not a PCK", "PCK");
    const names = pckFileNames(members);
    const tim2Members: PckMember[] = [];
    for (const member of members) {
        if (hasTim2Magic(memberBytes(pck, member))) {
            tim2Members.push(member);
        } else if (typeOf(member.attrs).toLowerCase() === "tm2") {
            skipped.push({
                entryOffset: entry.entryOff,
                sourcePath: entry.path,
                memberIndex: member.index,
                fileName: names[member.index]!,
                byteLength: member.size,
                reason: "missing-tim2-magic",
            });
        }
    }
    const classification = classifyMembers(pck, members, tim2Members);
    const images = tim2Members.map(member => {
        const bytes = memberBytes(pck, member);
        const label = `${entry.path}#${member.index}:${member.name}`;
        const role = classification.roles.get(member.index)!;
        return {
            texture: {
                id: textureId(entry, member.index), sourcePath: entry.path,
                memberIndex: member.index, memberName: member.name,
                fileName: names[member.index]!, attrs: member.attrs,
                byteLength: bytes.length,
                role: role.role,
                roleEvidence: role.evidence,
                pictures: inspectTim2(bytes, label),
            },
            bytes,
        };
    });
    return {
        entry, stored, images,
        uiReferences: classification.uiReferences,
        modelReferences: classification.modelReferences,
    };
}

type ImageScanOutcome =
    | { container: ScannedImageContainer; skipped: ImageScanSkippedMember[] }
    | { issue: ImageScanIssue; skipped: ImageScanSkippedMember[] };

async function scanImageOutcome(vfi: Vfi, entry: VfiEntry): Promise<ImageScanOutcome> {
    const stored = await vfi.read(entry);
    const skipped: ImageScanSkippedMember[] = [];
    try {
        return { container: await scanImageContainer(entry, stored, skipped), skipped };
    } catch (error) {
        if (!(error instanceof ImageFormatError)) throw error;
        return { issue: imageIssue(entry, error), skipped };
    }
}

function refineUnclassified(textures: ImageTexture[],
                            uiReferences: ReadonlySet<string>,
                            modelReferences: ReadonlySet<string>): void {
    for (const texture of textures) {
        if (texture.roleEvidence !== "unclassified") continue;
        const name = memberStem(texture.memberName ?? texture.fileName);
        const uiReference = uiReferences.has(name);
        const modelReference = modelReferences.has(name);
        if (uiReference && !modelReference) {
            texture.role = "sprite";
            texture.roleEvidence = "ui-global-reference";
        } else if (modelReference && !uiReference) {
            texture.role = "texture";
            texture.roleEvidence = "model-global-reference";
        } else if (!uiReference && !modelReference && name.startsWith("ui_")) {
            texture.role = "sprite";
            texture.roleEvidence = "ui-name-prefix";
        }
    }
}

/**
 * Inspect every direct TIM2 and every TIM2 member of every PCK in DATA.BIN.
 * The callback receives each original source texture once, including
 * multi-picture textures. Unclassified roles are deferred until cross-container
 * evidence is resolved; already-classified textures may be delivered per batch.
 * No decoded pixels are retained by the scanner.
 * Declared TM2 members lacking the signature are reported from the same PCK
 * walk, even if a different member subsequently fails TIM2 validation.
 * A proven TIM2/PCK/SZ format violation after a successful VFI read is
 * returned as one bounded issue for that container; source/I/O, resource,
 * abort, callback, and unexpected failures still reject the scan.
 */
export async function scanImageTextures(vfi: Vfi,
                                        options: ImageScanOptions = {}): Promise<ImageScanResult> {
    const containers = locateImageContainers(vfi);
    const textures: ImageTexture[] = [];
    const issues: ImageScanIssue[] = [];
    const skipped: ImageScanSkippedMember[] = [];
    const uiReferences = new Set<string>();
    const modelReferences = new Set<string>();
    const deferred: Array<{ texture: ImageTexture; bytes: Uint8Array }> = [];
    for (let start = 0; start < containers.length; start += IMAGE_SCAN_CONCURRENCY) {
        const batch = containers.slice(start, start + IMAGE_SCAN_CONCURRENCY);
        for (let offset = 0; offset < batch.length; offset++)
            options.progress?.(start + offset, containers.length, batch[offset]!.path);
        const scanned = await Promise.all(batch.map(entry => scanImageOutcome(vfi, entry)));
        const successful: ScannedImageContainer[] = [];
        for (const outcome of scanned) {
            skipped.push(...outcome.skipped);
            if ("issue" in outcome) {
                issues.push(outcome.issue);
                continue;
            }
            const container = outcome.container;
            successful.push(container);
            for (const name of container.uiReferences) uiReferences.add(name);
            for (const name of container.modelReferences) modelReferences.add(name);
            for (const image of container.images) {
                textures.push(image.texture);
                if (options.texture && image.texture.roleEvidence === "unclassified")
                    deferred.push({ texture: image.texture, bytes: image.bytes.slice() });
            }
        }
        await Promise.all(successful.map(async container => {
            if (container.images.length === 0) return;
            await options.container?.(container.entry, container.stored);
            for (const image of container.images)
                if (image.texture.roleEvidence !== "unclassified")
                    await options.texture?.(image.texture, image.bytes);
        }));
    }
    refineUnclassified(textures, uiReferences, modelReferences);
    if (options.texture) {
        for (let start = 0; start < deferred.length; start += IMAGE_SCAN_CONCURRENCY)
            await Promise.all(deferred.slice(start, start + IMAGE_SCAN_CONCURRENCY)
                .map(image => options.texture!(image.texture, image.bytes)));
    }
    options.progress?.(containers.length, containers.length, "done");
    return { textures, issues, skipped };
}

/** Re-read one source TIM2 represented by a scan result. */
export async function readImageTexture(vfi: Vfi,
                                       texture: ImageTexture): Promise<Uint8Array> {
    const entry = vfi.entries.find(candidate =>
        candidate.entryOff === Number.parseInt(texture.id.slice(0, 8), 16)
        && candidate.path === texture.sourcePath);
    if (!entry) throw new Error(`${texture.sourcePath}: image container is missing`);
    const stored = await vfi.read(entry);
    if (texture.memberIndex === null) {
        inspectTim2(stored, texture.sourcePath);
        return stored;
    }
    const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored, entry.path) : stored;
    const members = unpackPck(pck, entry.path);
    const member = members?.[texture.memberIndex];
    if (!member || member.name !== texture.memberName)
        throw new Error(`${texture.sourcePath}: image member ${texture.memberIndex} changed`);
    const bytes = memberBytes(pck, member);
    inspectTim2(bytes, `${texture.sourcePath}#${texture.memberIndex}`);
    return bytes;
}
