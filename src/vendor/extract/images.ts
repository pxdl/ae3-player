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

export interface ImageScanOptions {
    progress?: (done: number, total: number, path: string) => void;
    texture?: (texture: ImageTexture, bytes: Uint8Array) => void | Promise<void>;
    container?: (entry: VfiEntry, bytes: Uint8Array) => void | Promise<void>;
}

function isTim2(data: Uint8Array): boolean {
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

const REFERENCE_STEM = /^[a-z0-9_.-]{1,64}$/;

function referencedNames(data: Uint8Array): Set<string> {
    const references = new Set<string>();
    let start = -1;
    for (let index = 0; index <= data.length; index++) {
        const byte = index < data.length ? data[index]! : 0;
        if (byte >= 0x20 && byte < 0x7f) {
            if (start < 0) start = index;
            continue;
        }
        if (start >= 0) {
            const stem = memberStem(ASCII.decode(data.subarray(start, index)));
            if (REFERENCE_STEM.test(stem)) references.add(stem);
            start = -1;
        }
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

async function scanImageContainer(vfi: Vfi,
                                  entry: VfiEntry): Promise<ScannedImageContainer> {
    const stored = await vfi.read(entry);
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

    const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
    const members = unpackPck(pck);
    if (!members) throw new Error(`${entry.path}: not a PCK`);
    const names = pckFileNames(members);
    const imageMembers = members.filter(member => {
        const bytes = memberBytes(pck, member);
        return typeOf(member.attrs) === "tm2" || isTim2(bytes);
    });
    const classification = classifyMembers(pck, members, imageMembers);
    const images = imageMembers.map(member => {
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
 * multi-picture textures, after cross-container role evidence is resolved.
 * No decoded pixels are retained by the scanner.
 */
export async function scanImageTextures(vfi: Vfi,
                                        options: ImageScanOptions = {}): Promise<ImageTexture[]> {
    const containers = locateImageContainers(vfi);
    const textures: ImageTexture[] = [];
    const uiReferences = new Set<string>();
    const modelReferences = new Set<string>();
    const deferred: Array<{ texture: ImageTexture; bytes: Uint8Array }> = [];
    for (let start = 0; start < containers.length; start += IMAGE_SCAN_CONCURRENCY) {
        const batch = containers.slice(start, start + IMAGE_SCAN_CONCURRENCY);
        for (let offset = 0; offset < batch.length; offset++)
            options.progress?.(start + offset, containers.length, batch[offset]!.path);
        const scanned = await Promise.all(batch.map(entry => scanImageContainer(vfi, entry)));
        for (const container of scanned) {
            for (const name of container.uiReferences) uiReferences.add(name);
            for (const name of container.modelReferences) modelReferences.add(name);
            for (const image of container.images) {
                textures.push(image.texture);
                if (options.texture && image.texture.roleEvidence === "unclassified")
                    deferred.push({ texture: image.texture, bytes: image.bytes.slice() });
            }
        }
        await Promise.all(scanned.map(async container => {
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
    return textures;
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
    const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
    const members = unpackPck(pck);
    const member = members?.[texture.memberIndex];
    if (!member || member.name !== texture.memberName)
        throw new Error(`${texture.sourcePath}: image member ${texture.memberIndex} changed`);
    const bytes = memberBytes(pck, member);
    inspectTim2(bytes, `${texture.sourcePath}#${texture.memberIndex}`);
    return bytes;
}
