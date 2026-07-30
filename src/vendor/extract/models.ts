import { inflateSz } from "./sz.ts";
import { memberBytes, pckFileNames, unpackPck, type PckMember } from "./pck.ts";
import { type Vfi, type VfiEntry } from "./vfi.ts";

export type ModelAssetKind = "model" | "animation" | "collision";

export interface ModelAsset {
    id: string;
    kind: ModelAssetKind;
    sourcePath: string;
    memberIndex: number | null;
    memberName: string | null;
    fileName: string;
    attrs: string;
    byteLength: number;
    /** Exact skeleton names, present on model assets for animation matching. */
    boneNames?: string[];
}

export interface ModelScanOptions {
    progress?: (done: number, total: number, path: string) => void;
    asset?: (asset: ModelAsset, bytes: Uint8Array) => void | Promise<void>;
    container?: (entry: VfiEntry, bytes: Uint8Array) => void | Promise<void>;
}

export interface DecodedBone {
    name: string;
    parent: number;
    /** Column-major matrix, ready for WebGL/glTF consumers. */
    worldMatrix: Float32Array;
}

export interface DecodedMesh {
    name: string;
    material: string;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    skinIndices: Uint16Array;
    skinWeights: Float32Array;
    jointBones: Uint16Array;
    /** One column-major MAT4 per jointBones entry. */
    inverseBindMatrices: Float32Array;
}

export interface DecodedModel {
    kind: "model";
    materials: string[];
    bones: DecodedBone[];
    meshes: DecodedMesh[];
    vertexCount: number;
    triangleCount: number;
}

export interface DecodedAnimationTrack {
    name: string;
    times: Float32Array;
    /** xyzw quaternions, four values per key. */
    rotations: Float32Array;
}

export interface DecodedAnimation {
    kind: "animation";
    duration: number;
    tracks: DecodedAnimationTrack[];
}

export interface DecodedCollision {
    kind: "collision";
    material: string;
    positions: Float32Array;
    indices: Uint32Array;
    triangleCount: number;
}

export interface ModelInspection {
    materials: string[];
    boneNames: string[];
    boneParents: number[];
    nodeCount: number;
}

const MODEL_EXTENSIONS = /\.(?:i3d|i3m|i3c)$/i;
const CONTAINER_EXTENSIONS = /\.pck(?:\.sz)?$/i;
const SCAN_CONCURRENCY = 8;
const BASE = 0x10;
const NODE_SIZE = 0x10;
const BLACKLIST = new Set([
    0x04, 0x16, 0x24, 0x2c, 0x2e, 0x2f, 0x36,
    0x3f, 0x40, 0x41, 0x48, 0x4e, 0x51,
]);
const IDENTITY = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);
const ASCII = new TextDecoder("ascii");

interface Node {
    off: number;
    data: number;
    type: number;
    count: number;
    children: Node[];
}

interface ParsedModel {
    data: Uint8Array;
    root: Node;
    nodes: Node[];
    materials: string[];
    bones: Node[];
    boneNames: string[];
    boneParents: number[];
    boneWorld: Float32Array[];
}

function viewOf(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function requireRange(data: Uint8Array, offset: number, size: number,
                      label: string): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
        || offset < 0 || size < 0 || offset + size > data.length)
        throw new Error(`${label}: range 0x${offset.toString(16)}+0x${size.toString(16)} exceeds 0x${data.length.toString(16)}`);
}

function u8(data: Uint8Array, offset: number, label: string): number {
    requireRange(data, offset, 1, label);
    return data[offset]!;
}

function u16(data: Uint8Array, offset: number, label: string): number {
    requireRange(data, offset, 2, label);
    return viewOf(data).getUint16(offset, true);
}

function i16(data: Uint8Array, offset: number, label: string): number {
    requireRange(data, offset, 2, label);
    return viewOf(data).getInt16(offset, true);
}

function u32(data: Uint8Array, offset: number, label: string): number {
    requireRange(data, offset, 4, label);
    return viewOf(data).getUint32(offset, true);
}

function f32(data: Uint8Array, offset: number, label: string): number {
    requireRange(data, offset, 4, label);
    return viewOf(data).getFloat32(offset, true);
}

function cstr(data: Uint8Array, offset: number, label: string): string {
    if (offset < 0 || offset >= data.length)
        throw new Error(`${label}: string offset 0x${offset.toString(16)} is outside the file`);
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    if (end === data.length) throw new Error(`${label}: unterminated string at 0x${offset.toString(16)}`);
    return ASCII.decode(data.subarray(offset, end));
}

function tagKind(data: Uint8Array): ModelAssetKind | null {
    if (data.length < 8) return null;
    const tag = ASCII.decode(data.subarray(0, 8));
    if (tag === "I3D_BIN\0") return "model";
    if (tag === "I3D_I3M\0") return "animation";
    if (tag === "I3D_I3C\0") return "collision";
    return null;
}

function assetId(entry: VfiEntry, memberIndex: number | null): string {
    return `${entry.entryOff.toString(16).padStart(8, "0")}-${memberIndex ?? "direct"}`;
}

function directFileName(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

function catalogAsset(entry: VfiEntry, kind: ModelAssetKind, bytes: Uint8Array,
                      memberIndex: number | null, memberName: string | null,
                      fileName: string, attrs: string): ModelAsset {
    const asset: ModelAsset = {
        id: assetId(entry, memberIndex), kind, sourcePath: entry.path,
        memberIndex, memberName, fileName, attrs, byteLength: bytes.length,
    };
    if (kind === "model")
        asset.boneNames = inspectI3dModel(bytes, `${entry.path}:${fileName}`).boneNames;
    return asset;
}

/** VFI payloads that can contain visual models, skeletal animations, or collision. */
export function locateModelContainers(vfi: Vfi): VfiEntry[] {
    return vfi.entries.filter(entry =>
        CONTAINER_EXTENSIONS.test(entry.path) || MODEL_EXTENSIONS.test(entry.path));
}

interface ScannedContainer {
    entry: VfiEntry;
    stored: Uint8Array;
    assets: Array<{ asset: ModelAsset; bytes: Uint8Array }>;
}

async function scanContainer(vfi: Vfi, entry: VfiEntry): Promise<ScannedContainer> {
    const stored = await vfi.read(entry);
    if (MODEL_EXTENSIONS.test(entry.path)) {
        const kind = tagKind(stored);
        if (!kind) throw new Error(`${entry.path}: extension says I3D but the tag is unknown`);
        const fileName = directFileName(entry.path);
        return { entry, stored, assets: [{
            asset: catalogAsset(entry, kind, stored, null, null, fileName, kind),
            bytes: stored,
        }] };
    }

    const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
    const members = unpackPck(pck);
    if (!members) throw new Error(`${entry.path}: not a PCK`);
    const names = pckFileNames(members);
    const assets: ScannedContainer["assets"] = [];
    for (const member of members) {
        const bytes = memberBytes(pck, member);
        const kind = tagKind(bytes);
        if (!kind) continue;
        assets.push({
            asset: catalogAsset(entry, kind, bytes, member.index, member.name,
                                names[member.index]!, member.attrs),
            bytes,
        });
    }
    return { entry, stored, assets };
}

/** Inspect all I3D-family assets without retaining their payloads. */
export async function scanModelAssets(vfi: Vfi,
                                      options: ModelScanOptions = {}): Promise<ModelAsset[]> {
    const containers = locateModelContainers(vfi);
    const assets: ModelAsset[] = [];
    for (let start = 0; start < containers.length; start += SCAN_CONCURRENCY) {
        const batch = containers.slice(start, start + SCAN_CONCURRENCY);
        for (let index = 0; index < batch.length; index++)
            options.progress?.(start + index, containers.length, batch[index]!.path);
        const scanned = await Promise.all(batch.map(entry => scanContainer(vfi, entry)));
        for (const container of scanned) {
            if (container.assets.length > 0)
                await options.container?.(container.entry, container.stored);
            for (const item of container.assets) {
                assets.push(item.asset);
                await options.asset?.(item.asset, item.bytes);
            }
        }
    }
    options.progress?.(containers.length, containers.length, "done");
    return assets;
}

function findEntry(vfi: Vfi, asset: ModelAsset): VfiEntry {
    const entryOff = Number.parseInt(asset.id.slice(0, 8), 16);
    const entry = vfi.entries.find(candidate =>
        candidate.entryOff === entryOff && candidate.path === asset.sourcePath);
    if (!entry) throw new Error(`${asset.sourcePath}: model container is missing`);
    return entry;
}

/** Re-read one original I3D-family payload represented by a scan result. */
export async function readModelAsset(vfi: Vfi, asset: ModelAsset): Promise<Uint8Array> {
    const entry = findEntry(vfi, asset);
    const stored = await vfi.read(entry);
    if (asset.memberIndex === null) {
        if (tagKind(stored) !== asset.kind)
            throw new Error(`${asset.sourcePath}: model kind changed`);
        return stored;
    }
    const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
    const members = unpackPck(pck);
    const member = members?.[asset.memberIndex];
    if (!member || member.name !== asset.memberName)
        throw new Error(`${asset.sourcePath}: model member ${asset.memberIndex} changed`);
    const bytes = memberBytes(pck, member);
    if (tagKind(bytes) !== asset.kind)
        throw new Error(`${asset.sourcePath}: model member kind changed`);
    return bytes;
}

/** Read and expand the source package for sibling textures/animations. */
export async function readModelPackage(vfi: Vfi, asset: ModelAsset): Promise<{
    data: Uint8Array;
    members: PckMember[];
}> {
    const entry = findEntry(vfi, asset);
    const stored = await vfi.read(entry);
    const data = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
    const members = unpackPck(data);
    if (!members) {
        if (asset.memberIndex === null) return { data, members: [] };
        throw new Error(`${asset.sourcePath}: not a PCK`);
    }
    return { data, members };
}

function parseNode(data: Uint8Array, offset: number, depth: number,
                   seen: Set<number>, nodes: Node[], label: string): Node {
    if (depth > 64 || seen.has(offset))
        throw new Error(`${label}: cyclic or too-deep node tree at 0x${offset.toString(16)}`);
    requireRange(data, offset, NODE_SIZE, label);
    seen.add(offset);
    const payloadOffset = u32(data, offset, label);
    const packed = u32(data, offset + 4, label);
    const childrenOffset = u32(data, offset + 8, label);
    const type = (packed >>> 24) & 0x7f;
    const count = packed & 0x00ff_ffff;
    if (type > 0x59 || BLACKLIST.has(type))
        throw new Error(`${label}: invalid node type 0x${type.toString(16)} at 0x${offset.toString(16)}`);
    const node: Node = { off: offset - BASE, data: payloadOffset, type, count, children: [] };
    nodes.push(node);
    if (childrenOffset !== 0 && count !== 0) {
        const start = BASE + childrenOffset;
        requireRange(data, start, count * NODE_SIZE, label);
        for (let index = 0; index < count; index++)
            node.children.push(parseNode(data, start + index * NODE_SIZE,
                                         depth + 1, seen, nodes, label));
    }
    return node;
}

function byType(node: Node, type: number, output: Node[] = []): Node[] {
    if (node.type === type) output.push(node);
    for (const child of node.children) byType(child, type, output);
    return output;
}

function matrixAt(data: Uint8Array, offset: number, label: string): Float32Array {
    requireRange(data, offset, 0x40, label);
    const matrix = new Float32Array(16);
    for (let index = 0; index < 16; index++) matrix[index] = f32(data, offset + index * 4, label);
    return matrix;
}

function parseModel(data: Uint8Array, label: string): ParsedModel {
    if (tagKind(data) !== "model") throw new Error(`${label}: not an I3D_BIN model`);
    if (u32(data, 8, label) !== 0x0010_0001) throw new Error(`${label}: unsupported I3D_BIN version`);
    if (u32(data, 0x0c, label) !== 0) throw new Error(`${label}: expected on-disk I3D offsets`);
    const nodes: Node[] = [];
    const root = parseNode(data, BASE, 0, new Set(), nodes, label);
    if (root.type !== 0x52) throw new Error(`${label}: root node is not type 0x52`);

    const materials = byType(root, 0x25).map(node => {
        const target = node.children[0]?.children[0];
        if (!target || target.data === 0) return "";
        const payload = BASE + target.data;
        return cstr(data, payload + u32(data, payload + 0x18, label), label);
    });
    const bones = byType(root, 0x2a);
    const rootPayload = BASE + root.data;
    const transformTable = rootPayload + u32(data, rootPayload + 0x14, label);
    const boneWorld = bones.map((_, index) => matrixAt(data, transformTable + index * 0x40, label));
    const boneParents = bones.map(node => {
        const parent = u16(data, BASE + node.data, label);
        return parent === 0xffff ? -1 : parent;
    });

    const boneNames = new Array<string>(bones.length).fill("");
    if (bones.length > 0) {
        const permutation = rootPayload + u32(data, rootPayload + 0x1c, label);
        requireRange(data, permutation, bones.length * 2, label);
        let nameOffset = permutation + bones.length * 2;
        for (let sortedIndex = 0; sortedIndex < bones.length; sortedIndex++) {
            const boneIndex = u16(data, permutation + sortedIndex * 2, label);
            if (boneIndex >= bones.length)
                throw new Error(`${label}: bone-name permutation index ${boneIndex} is invalid`);
            const name = cstr(data, nameOffset, label);
            boneNames[boneIndex] = name;
            nameOffset += name.length + 1;
        }
    }
    return { data, root, nodes, materials, bones, boneNames, boneParents, boneWorld };
}

export function inspectI3dModel(data: Uint8Array, label = "I3D model"): ModelInspection {
    const parsed = parseModel(data, label);
    return {
        materials: parsed.materials,
        boneNames: parsed.boneNames,
        boneParents: parsed.boneParents,
        nodeCount: parsed.nodes.length,
    };
}

function parseVif(data: Uint8Array, start: number, label: string): Float32Array {
    requireRange(data, start, 0x10, label);
    const memory = new Float32Array(0x1000 * 4);
    const packetEnd = start + u8(data, start + 4, label) * 0x10 + 0x10;
    requireRange(data, start, packetEnd - start, label);
    let offset = start + 0x10;
    let row = [0, 0, 0, 0];
    let column = [1, 1, 1, 1];
    let cycleLength = 1;
    let writeLength = 1;
    let mask = new Array<number>(16).fill(0);

    while (offset < packetEnd) {
        const immediate = u16(data, offset, label);
        const count = u8(data, offset + 2, label);
        const command = u8(data, offset + 3, label) & 0x7f;
        offset += 4;
        if (command === 0) continue;
        if (command === 0x01) {
            cycleLength = immediate & 0xff;
            writeLength = (immediate >>> 8) & 0xff;
            continue;
        }
        if (command === 0x30 || command === 0x31) {
            const values = [0, 1, 2, 3].map(index => f32(data, offset + index * 4, label));
            if (command === 0x30) row = values;
            else column = values;
            offset += 0x10;
            continue;
        }
        if (command === 0x20) {
            const bits = u32(data, offset, label);
            mask = Array.from({ length: 16 }, (_, index) => (bits >>> (index * 2)) & 3);
            offset += 4;
            continue;
        }
        if ((command >>> 5) !== 0b11)
            throw new Error(`${label}: unsupported VIF command 0x${command.toString(16)}`);

        const address = immediate & 0x3ff;
        const format = command & 0x0f;
        const width = new Map([[0x0, 4], [0x4, 8], [0x8, 12], [0xc, 16]]).get(format);
        if (!width) throw new Error(`${label}: unsupported VIF UNPACK format 0x${format.toString(16)}`);
        const components = width / 4;
        const useMask = (command & 0x10) !== 0;
        let sourceIndex = 0;
        for (let index = 0; index < count; index++) {
            const values = [0, 0, 0, 0];
            if (cycleLength >= writeLength || index % writeLength < cycleLength) {
                for (let component = 0; component < components; component++)
                    values[component] = f32(data, offset + sourceIndex * width + component * 4, label);
                sourceIndex++;
            }
            const destination = cycleLength >= writeLength
                ? cycleLength * Math.floor(index / writeLength) + index % writeLength : 0;
            if (address + destination >= 0x1000)
                throw new Error(`${label}: VIF write exceeds VU memory`);
            for (let component = 0; component < 4; component++) {
                const mode = useMask ? mask[component + Math.min(index, 3) * 4]! : 0;
                memory[(address + destination) * 4 + component] = mode === 0
                    ? values[component]! : mode === 1 ? row[component]!
                    : mode === 2 ? column[Math.min(3, index)]! : 0;
            }
        }
        offset += sourceIndex * width;
    }
    return memory;
}

function readVec4Buffer(data: Uint8Array, payload: number, count: number,
                        label: string): Float32Array {
    const output = new Float32Array(count * 4);
    if (u8(data, payload + 8, label) === 1) {
        output.set(parseVif(data, payload, label).subarray(0, count * 4));
        return output;
    }
    requireRange(data, payload + 0x10, count * 0x10, label);
    for (let index = 0; index < count * 4; index++)
        output[index] = f32(data, payload + 0x10 + index * 4, label);
    return output;
}

interface TriangleCorner { vertex: number; uv: number }

function decodePiece(parsed: ParsedModel, pieceNode: Node, name: string,
                     material: string, rigidBone: number, boneList: number[],
                     bindOffset: number, label: string): DecodedMesh {
    const { data } = parsed;
    const vertexNode = pieceNode.children[4]?.children[0];
    if (!vertexNode) throw new Error(`${label}: ${name} has no vertex node`);
    const vertexPayload = BASE + vertexNode.data;
    const vertexCount = u8(data, vertexPayload + 6, label);
    const sourcePositions = readVec4Buffer(data, vertexPayload, vertexCount, label);
    const normalNode = pieceNode.children[2]?.children[0];
    const sourceNormals = normalNode
        ? readVec4Buffer(data, BASE + normalNode.data,
                         u8(data, BASE + normalNode.data + 6, label), label)
        : null;
    if (sourceNormals && sourceNormals.length / 4 !== vertexCount)
        throw new Error(`${label}: ${name} normal count does not match its vertices`);

    const influences: Array<Array<[number, number]>> = Array.from({ length: vertexCount }, () => []);
    const weightNodes = byType(pieceNode, 0x31);
    const isSkinned = weightNodes.length > 0 && bindOffset > 0;
    if (isSkinned) {
        for (const weightNode of weightNodes) {
            const payload = BASE + weightNode.data;
            const records = payload + u32(data, payload, label);
            const joint = u16(data, payload + 4, label);
            if (joint >= boneList.length) throw new Error(`${label}: local joint ${joint} exceeds bone list`);
            const count = u16(data, payload + 6, label);
            requireRange(data, records, count * 8, label);
            for (let index = 0; index < count; index++) {
                const vertex = u32(data, records + index * 8, label) / 0x10;
                const weight = f32(data, records + index * 8 + 4, label);
                if (weight === 0) continue;
                if (!Number.isInteger(vertex) || vertex >= vertexCount)
                    throw new Error(`${label}: skin references invalid vertex ${vertex}`);
                influences[vertex]!.push([joint, weight]);
            }
        }
    }

    const sourceUvs: number[] = [];
    const indexRecords: Array<[number, number, number, number]> = [];
    for (const indexNode of byType(pieceNode, 0x47)) {
        const payload = BASE + indexNode.data;
        const count = u8(data, payload + 5, label);
        const uvNode = indexNode.children[1]?.children[0];
        if (uvNode) {
            const uvPayload = BASE + uvNode.data;
            const uvCount = u8(data, uvPayload + 6, label);
            const uv = readVec4Buffer(data, uvPayload, uvCount, label);
            for (let index = 0; index < count; index++) sourceUvs.push(uv[index * 4] ?? 0, uv[index * 4 + 1] ?? 0);
        } else {
            for (let index = 0; index < count; index++) sourceUvs.push(0, 0);
        }
        requireRange(data, payload + 0x10, count * 4, label);
        for (let index = 0; index < count; index++) {
            const record = payload + 0x10 + index * 4;
            indexRecords.push([u8(data, record, label), u8(data, record + 1, label),
                               u8(data, record + 2, label), u8(data, record + 3, label)]);
        }
    }

    const triangles: TriangleCorner[][] = [];
    for (let index = 0; index < indexRecords.length; index++) {
        const record = indexRecords[index]!;
        if (record[1] === 0x80) continue;
        if (index < 2) throw new Error(`${label}: triangle strip begins before two primers`);
        const order = record[3] !== 0 ? [index - 2, index - 1, index] : [index, index - 1, index - 2];
        triangles.push(order.map(uv => ({ vertex: indexRecords[uv]![0], uv })));
    }

    const remap = new Map<string, number>();
    const positions: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const skinIndices: number[] = [];
    const skinWeights: number[] = [];
    for (const triangle of triangles) {
        for (const corner of triangle) {
            const key = `${corner.vertex}:${corner.uv}`;
            let outputIndex = remap.get(key);
            if (outputIndex === undefined) {
                outputIndex = positions.length / 3;
                remap.set(key, outputIndex);
                if (corner.vertex >= vertexCount)
                    throw new Error(`${label}: triangle references vertex ${corner.vertex}/${vertexCount}`);
                const source = corner.vertex * 4;
                positions.push(sourcePositions[source]!, sourcePositions[source + 1]!, sourcePositions[source + 2]!);
                if (sourceNormals)
                    normals.push(sourceNormals[source]!, sourceNormals[source + 1]!,
                                 sourceNormals[source + 2]!);
                uvs.push(sourceUvs[corner.uv * 2] ?? 0, sourceUvs[corner.uv * 2 + 1] ?? 0);
                const weighted: Array<[number, number]> = isSkinned
                    ? [...influences[corner.vertex]!].sort((a, b) => b[1] - a[1]).slice(0, 4)
                    : [[0, 1]];
                for (let slot = 0; slot < 4; slot++) {
                    skinIndices.push(weighted[slot]?.[0] ?? 0);
                    skinWeights.push(weighted[slot]?.[1] ?? 0);
                }
            }
            indices.push(outputIndex);
        }
    }

    const jointBones = isSkinned ? boneList : rigidBone >= 0 ? [rigidBone] : [];
    const inverseBindMatrices = new Float32Array(jointBones.length * 16);
    for (let index = 0; index < jointBones.length; index++) {
        inverseBindMatrices.set(isSkinned
            ? matrixAt(data, bindOffset + index * 0x40, label) : IDENTITY, index * 16);
    }
    return {
        name, material,
        positions: new Float32Array(positions), normals: new Float32Array(normals),
        uvs: new Float32Array(uvs), indices: new Uint32Array(indices),
        skinIndices: new Uint16Array(skinIndices),
        skinWeights: new Float32Array(skinWeights),
        jointBones: new Uint16Array(jointBones), inverseBindMatrices,
    };
}

/** Decode geometry, materials, skeleton, and skin from one I3D_BIN model. */
export function decodeI3dModel(data: Uint8Array, label = "I3D model"): DecodedModel {
    const parsed = parseModel(data, label);
    const combinedMeshes = byType(parsed.root, 0x2d);
    const meshes: DecodedMesh[] = [];
    for (let boneIndex = 0; boneIndex < parsed.bones.length; boneIndex++) {
        const bone = parsed.bones[boneIndex]!;
        for (const instance of byType(bone, 0x59)) {
            const payload = BASE + instance.data;
            const boneListOffset = payload + u32(data, payload, label);
            const combinedIndex = u16(data, payload + 4, label);
            const boneCount = u16(data, payload + 6, label);
            requireRange(data, boneListOffset, boneCount * 2, label);
            const boneList = Array.from({ length: boneCount }, (_, index) => u16(data, boneListOffset + index * 2, label));
            const combined = combinedMeshes[combinedIndex];
            if (!combined) throw new Error(`${label}: combined mesh ${combinedIndex} is missing`);
            const bindNode = combined.children[0];
            const bindOffset = bindNode?.data
                ? BASE + bindNode.data + u32(data, BASE + bindNode.data, label) : 0;
            const candidates = [...byType(combined, 0x4b), ...byType(combined, 0x4c)];
            for (const meshNode of candidates) {
                let rigidBone = boneIndex;
                if (meshNode.type === 0x4c) {
                    const meshPayload = BASE + meshNode.data;
                    if ((u8(data, meshPayload + 5, label) & 8) !== 0) {
                        const localBone = u16(data, meshPayload + 8, label);
                        rigidBone = boneList[localBone] ?? boneIndex;
                    }
                }
                for (const submesh of byType(meshNode, 0x4d)) {
                    const submeshPayload = BASE + submesh.data;
                    const materialIndex = u8(data, submeshPayload + 0x0c, label);
                    const material = parsed.materials[materialIndex] ?? "";
                    for (const piece of byType(submesh, 0x56)) {
                        const name = `b${boneIndex}_cm${combinedIndex}_m${meshNode.off.toString(16)}_s${submesh.off.toString(16)}_p${piece.off.toString(16)}`;
                        const decoded = decodePiece(parsed, piece, name, material,
                                                    rigidBone, boneList, bindOffset, label);
                        if (decoded.indices.length > 0) meshes.push(decoded);
                    }
                }
            }
        }
    }
    const bones = parsed.bones.map((_, index): DecodedBone => ({
        name: parsed.boneNames[index] || `bone_${String(index).padStart(2, "0")}`,
        parent: parsed.boneParents[index]!, worldMatrix: parsed.boneWorld[index]!,
    }));
    return {
        kind: "model", materials: parsed.materials, bones, meshes,
        vertexCount: meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0),
        triangleCount: meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    };
}

/** Decode the proven rotation channel of one I3D_I3M skeletal animation. */
export function decodeI3dAnimation(data: Uint8Array,
                                   label = "I3D animation"): DecodedAnimation {
    if (tagKind(data) !== "animation") throw new Error(`${label}: not an I3D_I3M animation`);
    if (u32(data, 8, label) !== 0x0002_0001) throw new Error(`${label}: unsupported I3M version`);
    if (u32(data, 0x0c, label) !== data.length) throw new Error(`${label}: I3M file size does not match`);
    const components = u16(data, 0x12, label);
    const trackCount = u16(data, 0x14, label);
    if (components !== 4 && components !== 5)
        throw new Error(`${label}: unsupported ${components}-component animation`);
    if (u16(data, 0x16, label) !== 1) throw new Error(`${label}: expected on-disk I3M offsets`);
    const duration = f32(data, 0x18, label);
    const tracksOffset = u32(data, 0x1c, label);
    const timePool = u32(data, 0x24, label);
    const quaternionPool = u32(data, 0x28, label);
    requireRange(data, tracksOffset, trackCount * 12, label);
    const tracks: DecodedAnimationTrack[] = [];
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        const trackOffset = tracksOffset + trackIndex * 12;
        const name = cstr(data, u32(data, trackOffset, label), label);
        const keyCount = u16(data, trackOffset + 6, label);
        const keysOffset = u32(data, trackOffset + 8, label);
        requireRange(data, keysOffset, keyCount * components * 2, label);
        const times = new Float32Array(keyCount);
        const quaternionIndices = new Uint16Array(keyCount);
        let hasRotation = keyCount > 0;
        for (let key = 0; key < keyCount; key++) {
            const row = keysOffset + key * components * 2;
            times[key] = f32(data, timePool + u16(data, row, label) * 4, label);
            quaternionIndices[key] = u16(data, row + 6, label);
            const offset = quaternionPool + quaternionIndices[key]! * 8;
            if (offset < quaternionPool || offset + 8 > timePool) hasRotation = false;
        }
        const rotations = new Float32Array(hasRotation ? keyCount * 4 : 0);
        let previous: number[] | null = null;
        if (hasRotation) for (let key = 0; key < keyCount; key++) {
            const quaternion = [0, 1, 2, 3].map(component =>
                i16(data, quaternionPool + quaternionIndices[key]! * 8
                    + component * 2, label) / 32768);
            const norm = Math.hypot(...quaternion);
            if (norm > 1e-12) for (let component = 0; component < 4; component++)
                quaternion[component] = quaternion[component]! / norm;
            if (previous && quaternion.reduce((sum, value, index) =>
                sum + value * previous![index]!, 0) < 0)
                for (let component = 0; component < 4; component++)
                    quaternion[component] = -quaternion[component]!;
            rotations.set(quaternion, key * 4);
            previous = quaternion;
        }
        tracks.push({ name, times, rotations });
    }
    return { kind: "animation", duration, tracks };
}

function walkCollision(data: Uint8Array, offset: number, label: string,
                       triangles: number[], depth = 0): void {
    if (depth > 64) throw new Error(`${label}: collision BVH is too deep`);
    const count = u16(data, offset, label);
    const pointer = u32(data, offset + 8, label);
    if ((count & 0x8000) !== 0) {
        requireRange(data, pointer, 8, label);
        triangles.push(u16(data, pointer, label), u16(data, pointer + 2, label),
                       u16(data, pointer + 4, label));
        return;
    }
    const childCount = count & 0x7fff;
    requireRange(data, pointer, childCount * 0x0c, label);
    for (let child = 0; child < childCount; child++)
        walkCollision(data, pointer + child * 0x0c, label, triangles, depth + 1);
}

/** Decode an I3D_I3C collision BVH to its indexed triangle mesh. */
export function decodeI3dCollision(data: Uint8Array,
                                   label = "I3D collision"): DecodedCollision {
    if (tagKind(data) !== "collision") throw new Error(`${label}: not an I3D_I3C collision`);
    if (u32(data, 8, label) !== 0x0003_0000) throw new Error(`${label}: unsupported I3C version`);
    if (u32(data, 0x0c, label) !== data.length) throw new Error(`${label}: I3C file size does not match`);
    if (u8(data, 0x10, label) !== 1) throw new Error(`${label}: expected on-disk I3C offsets`);
    const groupCount = u16(data, 0x14, label);
    const materialCount = u16(data, 0x16, label);
    const groupsOffset = u32(data, 0x18, label);
    const namesOffset = u32(data, 0x1c, label);
    const material = materialCount > 0 ? cstr(data, u32(data, namesOffset, label), label) : "";
    const positions: number[] = [];
    const indices: number[] = [];
    for (let group = 0; group < groupCount; group++) {
        const groupOffset = groupsOffset + group * 0x0c;
        const partCount = u16(data, groupOffset + 4, label);
        const partsOffset = u32(data, groupOffset + 8, label);
        for (let part = 0; part < partCount; part++) {
            const partOffset = partsOffset + part * 0x30;
            const treeOffset = u32(data, partOffset + 0x28, label);
            const verticesOffset = u32(data, partOffset + 0x2c, label);
            const local: number[] = [];
            walkCollision(data, treeOffset, label, local);
            const vertexCount = local.length > 0 ? Math.max(...local) + 1 : 0;
            requireRange(data, verticesOffset, vertexCount * 0x10, label);
            const vertexBase = positions.length / 3;
            for (let vertex = 0; vertex < vertexCount; vertex++) {
                const offset = verticesOffset + vertex * 0x10;
                positions.push(f32(data, offset, label), f32(data, offset + 4, label),
                               f32(data, offset + 8, label));
            }
            for (const index of local) indices.push(vertexBase + index);
        }
    }
    return {
        kind: "collision", material, positions: new Float32Array(positions),
        indices: new Uint32Array(indices), triangleCount: indices.length / 3,
    };
}
