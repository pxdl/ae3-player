import { LAST_DISC_KEY } from "./disc.ts";
import { inflateSz, memberBytes, OpfsCache, unpackPck } from "./vendor/extract/index.ts";

const RGBA16 = 1;
const RGB24 = 2;
const RGBA32 = 3;
const IDTEX4 = 4;
const IDTEX8 = 5;

type ViewerArtId =
    | "logo"
    | "director"
    | "music"
    | "effects"
    | "monkey"
    | "phoneBlue"
    | "phonePink";

type AssetSpec = {
    id: ViewerArtId;
    packageName: string;
    memberName: string;
    frame?: { columns: number; rows: number; index: number };
};

const ASSETS: ReadonlyArray<AssetSpec> = [
    { id: "logo", packageName: "viewer/ui_title.pck.sz", memberName: "ui_title_logo" },
    { id: "director", packageName: "viewer/ci_studio.pck.sz", memberName: "sc_kantoku_saru",
      frame: { columns: 1, rows: 2, index: 0 } },
    { id: "music", packageName: "viewer/ci_studio.pck.sz", memberName: "xmb_bgm" },
    { id: "effects", packageName: "viewer/ci_studio.pck.sz", memberName: "xmb_se" },
    { id: "monkey", packageName: "viewer/ci_studio.pck.sz", memberName: "xmb_saru" },
    { id: "phoneBlue", packageName: "viewer/ui_phone.pck.sz", memberName: "ui_b_tel_face" },
    { id: "phonePink", packageName: "viewer/ui_phone.pck.sz", memberName: "ui_g_tel_face" },
];

export interface ViewerArt {
    images: Partial<Record<ViewerArtId, string>>;
}


function requireRange(data: Uint8Array, offset: number, length: number, label: string): void {
    if (offset < 0 || length < 0 || offset + length > data.length)
        throw new Error(`${label} exceeds TIM2 data (${offset}+${length}/${data.length})`);
}

function writeRgba16(out: Uint8ClampedArray, outOffset: number, value: number): void {
    out[outOffset] = (value & 0x1f) << 3;
    out[outOffset + 1] = ((value >> 5) & 0x1f) << 3;
    out[outOffset + 2] = ((value >> 10) & 0x1f) << 3;
    out[outOffset + 3] = value & 0x8000 ? 255 : 0;
}

function decodePalette(data: Uint8Array, offset: number, count: number,
                       clutType: number): Uint8ClampedArray {
    const kind = clutType & 0x3f;
    const bytesPerColor = kind === RGBA32 ? 4 : kind === RGB24 ? 3 : kind === RGBA16 ? 2 : 0;
    if (!bytesPerColor) throw new Error(`unsupported TIM2 CLUT type 0x${clutType.toString(16)}`);
    requireRange(data, offset, count * bytesPerColor, "TIM2 palette");

    const palette = new Uint8ClampedArray(count * 4);
    const csm2 = (clutType & 0x80) !== 0;
    for (let index = 0; index < count; index++) {
        const sourceIndex = !csm2 && count === 256
            ? (index & 0xe7) | ((index & 0x08) << 1) | ((index & 0x10) >> 1)
            : index;
        const source = offset + sourceIndex * bytesPerColor;
        const target = index * 4;
        if (kind === RGBA32) {
            palette[target] = data[source]!;
            palette[target + 1] = data[source + 1]!;
            palette[target + 2] = data[source + 2]!;
            palette[target + 3] = data[source + 3]! >= 0x80
                ? 255
                : Math.floor(data[source + 3]! * 255 / 128);
        } else if (kind === RGB24) {
            palette[target] = data[source]!;
            palette[target + 1] = data[source + 1]!;
            palette[target + 2] = data[source + 2]!;
            palette[target + 3] = 255;
        } else {
            const value = data[source]! | data[source + 1]! << 8;
            writeRgba16(palette, target, value);
        }
    }
    return palette;
}

/** Decode the first picture in a TIM2 file to browser-native RGBA pixels. */
export function decodeTim2(data: Uint8Array): ImageData {
    if (data.length < 0x28 || data[0] !== 0x54 || data[1] !== 0x49
        || data[2] !== 0x4d || data[3] !== 0x32)
        throw new Error("not a TIM2 texture");
    if (data[4] !== 4) throw new Error(`TIM2 version ${data[4]} is unsupported`);
    const pictureCount = data[6]! | data[7]! << 8;
    if (pictureCount < 1) throw new Error("TIM2 contains no pictures");

    const pictureOffset = data[5] === 0 ? 0x10 : 0x80;
    requireRange(data, pictureOffset, 24, "TIM2 picture header");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const clutSize = view.getUint32(pictureOffset + 4, true);
    const imageSize = view.getUint32(pictureOffset + 8, true);
    const headerSize = view.getUint16(pictureOffset + 12, true);
    const colorCount = view.getUint16(pictureOffset + 14, true);
    const clutType = data[pictureOffset + 18]!;
    const imageType = data[pictureOffset + 19]!;
    const width = view.getUint16(pictureOffset + 20, true);
    const height = view.getUint16(pictureOffset + 22, true);
    if (!width || !height) throw new Error(`invalid TIM2 dimensions ${width}x${height}`);

    const pixels = width * height;
    const body = pictureOffset + headerSize;
    const rgba = new Uint8ClampedArray(pixels * 4);
    if (imageType === IDTEX4 || imageType === IDTEX8) {
        if (!clutSize || !colorCount) throw new Error("indexed TIM2 picture has no palette");
        const palette = decodePalette(data, body + imageSize, colorCount, clutType);
        const indexBytes = imageType === IDTEX8 ? pixels : Math.ceil(pixels / 2);
        requireRange(data, body, indexBytes, "TIM2 indices");
        for (let pixel = 0; pixel < pixels; pixel++) {
            const packed = data[body + (imageType === IDTEX8 ? pixel : pixel >> 1)]!;
            const index = imageType === IDTEX8
                ? packed
                : pixel & 1 ? packed >> 4 : packed & 0x0f;
            if (index >= colorCount) throw new Error(`TIM2 palette index ${index} exceeds ${colorCount}`);
            const paletteOffset = index * 4;
            const target = pixel * 4;
            rgba[target] = palette[paletteOffset]!;
            rgba[target + 1] = palette[paletteOffset + 1]!;
            rgba[target + 2] = palette[paletteOffset + 2]!;
            rgba[target + 3] = palette[paletteOffset + 3]!;
        }
    } else if (imageType === RGBA32 || imageType === RGB24 || imageType === RGBA16) {
        const bytesPerPixel = imageType === RGBA32 ? 4 : imageType === RGB24 ? 3 : 2;
        requireRange(data, body, pixels * bytesPerPixel, "TIM2 pixels");
        for (let pixel = 0; pixel < pixels; pixel++) {
            const source = body + pixel * bytesPerPixel;
            const target = pixel * 4;
            if (imageType === RGBA16) {
                writeRgba16(rgba, target, data[source]! | data[source + 1]! << 8);
            } else {
                rgba[target] = data[source]!;
                rgba[target + 1] = data[source + 1]!;
                rgba[target + 2] = data[source + 2]!;
                rgba[target + 3] = imageType === RGBA32
                    ? data[source + 3]! >= 0x80 ? 255 : Math.floor(data[source + 3]! * 255 / 128)
                    : 255;
            }
        }
    } else {
        throw new Error(`unsupported TIM2 image type ${imageType}`);
    }
    return new ImageData(rgba, width, height);
}

async function imageUrl(data: Uint8Array, frame?: AssetSpec["frame"]): Promise<string> {
    const image = decodeTim2(data);
    const columns = frame?.columns ?? 1;
    const rows = frame?.rows ?? 1;
    const frameWidth = Math.floor(image.width / columns);
    const frameHeight = Math.floor(image.height / rows);
    const canvas = document.createElement("canvas");
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable");
    const index = frame?.index ?? 0;
    context.putImageData(
        image,
        -(index % columns) * frameWidth,
        -Math.floor(index / columns) * frameHeight,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png");
    });
    return URL.createObjectURL(blob);
}

/** Load selected UI textures previously cached from the user's own disc. */
export async function loadViewerArt(): Promise<ViewerArt | null> {
    const key = localStorage.getItem(LAST_DISC_KEY);
    if (!key || !OpfsCache.supported()) return null;

    const cache = await OpfsCache.open(key);
    const images: Partial<Record<ViewerArtId, string>> = {};
    const packages = new Map<string, AssetSpec[]>();
    for (const asset of ASSETS) {
        const specs = packages.get(asset.packageName) ?? [];
        specs.push(asset);
        packages.set(asset.packageName, specs);
    }

    for (const [packageName, specs] of packages) {
        const compressed = await cache.read(packageName);
        if (!compressed) continue;
        try {
            const data = await inflateSz(compressed);
            const members = unpackPck(data);
            if (!members) throw new Error(`${packageName} did not inflate to a PCK`);
            for (const spec of specs) {
                const member = members.find((candidate) => candidate.name === spec.memberName);
                if (member) images[spec.id] = await imageUrl(memberBytes(data, member), spec.frame);
            }
        } catch (error) {
            console.warn(`Could not load viewer art from ${packageName}`, error);
        }
    }

    return Object.keys(images).length ? { images } : null;
}
