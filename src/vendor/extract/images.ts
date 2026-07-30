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
    "ui-reference" | "model-reference" | "ui-package" | "model-package"
    | "direct" | "unclassified";

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

function referencedTextureNames(data: Uint8Array,
                                textureNames: ReadonlySet<string>): Set<string> {
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
            if (textureNames.has(stem)) references.add(stem);
            start = -1;
        }
    }
    return references;
}

function classifyMembers(pck: Uint8Array, members: PckMember[],
                         textures: PckMember[]): Map<number, {
                             role: ImageRole;
                             evidence: ImageRoleEvidence;
                         }> {
    const names = new Set(textures.map(member => memberStem(member.name)));
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
        for (const name of referencedTextureNames(memberBytes(pck, member), names))
            target.add(name);
    }

    return new Map(textures.map(member => {
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
        return [member.index, { role, evidence }];
    }));
}

/** VFI payloads that can contain source TIM2 textures. */
export function locateImageContainers(vfi: Vfi): VfiEntry[] {
    return vfi.entries.filter(entry =>
        /\.tm2$/i.test(entry.path) || /\.pck(?:\.sz)?$/i.test(entry.path));
}

/**
 * Inspect every direct TIM2 and every TIM2 member of every PCK in DATA.BIN.
 * The callback receives each original source texture once, including
 * multi-picture textures. No decoded pixels are retained by the scanner.
 */
export async function scanImageTextures(vfi: Vfi,
                                        options: ImageScanOptions = {}): Promise<ImageTexture[]> {
    const containers = locateImageContainers(vfi);
    const textures: ImageTexture[] = [];
    for (let containerIndex = 0; containerIndex < containers.length; containerIndex++) {
        const entry = containers[containerIndex]!;
        options.progress?.(containerIndex, containers.length, entry.path);
        const stored = await vfi.read(entry);
        if (/\.tm2$/i.test(entry.path)) {
            const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
            const texture: ImageTexture = {
                id: textureId(entry, null), sourcePath: entry.path,
                memberIndex: null, memberName: null, fileName, attrs: "tm2",
                byteLength: stored.length, role: "other", roleEvidence: "direct",
                pictures: inspectTim2(stored, entry.path),
            };
            textures.push(texture);
            await options.texture?.(texture, stored);
            continue;
        }

        const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
        const members = unpackPck(pck);
        if (!members) throw new Error(`${entry.path}: not a PCK`);
        const names = pckFileNames(members);
        const imageMembers = members.filter(member => {
            const bytes = memberBytes(pck, member);
            return typeOf(member.attrs) === "tm2" || isTim2(bytes);
        });
        const roles = classifyMembers(pck, members, imageMembers);
        for (const member of imageMembers) {
            const bytes = memberBytes(pck, member);
            const label = `${entry.path}#${member.index}:${member.name}`;
            const classification = roles.get(member.index)!;
            const texture: ImageTexture = {
                id: textureId(entry, member.index), sourcePath: entry.path,
                memberIndex: member.index, memberName: member.name,
                fileName: names[member.index]!, attrs: member.attrs,
                byteLength: bytes.length,
                role: classification.role,
                roleEvidence: classification.evidence,
                pictures: inspectTim2(bytes, label),
            };
            textures.push(texture);
            await options.texture?.(texture, bytes);
        }
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
