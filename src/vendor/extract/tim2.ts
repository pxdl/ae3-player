import { ImageFormatError } from "./image-format.ts";

const RGBA16 = 1;
const RGB24 = 2;
const RGBA32 = 3;
const IDTEX4 = 4;
const IDTEX8 = 5;

export interface Tim2PictureInfo {
    index: number;
    width: number;
    height: number;
    imageType: number;
    clutType: number;
    colorCount: number;
    mipmapCount: number;
}

export interface Tim2Image extends Tim2PictureInfo {
    rgba: Uint8ClampedArray;
}

interface ParsedPicture extends Tim2PictureInfo {
    body: number;
    imageSize: number;
    clutSize: number;
}

function fail(path: string, offset: number, detail: string): never {
    throw new ImageFormatError(path, offset, detail, "TIM2");
}

function requireRange(data: Uint8Array, offset: number, length: number,
                     path: string, label: string): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || offset + length > data.length)
        fail(path, Math.max(0, offset),
             `${label} exceeds TIM2 data (${offset}+${length}/${data.length})`);
}

function parsedPictures(data: Uint8Array, path: string): ParsedPicture[] {
    if (data.length < 0x10 || data[0] !== 0x54 || data[1] !== 0x49
        || data[2] !== 0x4d || data[3] !== 0x32)
        fail(path, 0, "not a TIM2 texture");
    if (data[4] !== 4)
        fail(path, 4, `TIM2 version ${data[4]} is unsupported`);
    const format = data[5]!;
    if (format !== 0 && format !== 1)
        fail(path, 5, `TIM2 format ${format} is unsupported`);
    const pictureCount = data[6]! | data[7]! << 8;
    if (pictureCount < 1) fail(path, 6, "TIM2 contains no pictures");

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pictures: ParsedPicture[] = [];
    let offset = format === 0 ? 0x10 : 0x80;
    for (let index = 0; index < pictureCount; index++) {
        requireRange(data, offset, 0x30, path, `picture ${index} header`);
        const totalSize = view.getUint32(offset, true);
        const clutSize = view.getUint32(offset + 4, true);
        const imageSize = view.getUint32(offset + 8, true);
        const headerSize = view.getUint16(offset + 12, true);
        const colorCount = view.getUint16(offset + 14, true);
        const mipmapCount = data[offset + 17]!;
        const clutType = data[offset + 18]!;
        const imageType = data[offset + 19]!;
        const width = view.getUint16(offset + 20, true);
        const height = view.getUint16(offset + 22, true);
        if (totalSize < headerSize || headerSize < 0x30)
            fail(path, offset, `picture ${index} has invalid sizes`);
        requireRange(data, offset, totalSize, path, `picture ${index}`);
        if (!width || !height)
            fail(path, offset + 20,
                 `picture ${index} has invalid dimensions ${width}x${height}`);
        const body = offset + headerSize;
        requireRange(data, body, imageSize + clutSize, path,
                     `picture ${index} payload`);
        pictures.push({ index, width, height, imageType, clutType,
                        colorCount, mipmapCount, body, imageSize, clutSize });
        offset += totalSize;
    }
    return pictures;
}

/** Validate a TIM2 and return every picture's display metadata. */
export function inspectTim2(data: Uint8Array, path = "TIM2"): Tim2PictureInfo[] {
    return parsedPictures(data, path).map(({ body: _body, imageSize: _imageSize,
                                            clutSize: _clutSize, ...info }) => info);
}

function alpha(value: number): number {
    return value >= 0x80 ? 255 : Math.floor(value * 255 / 128);
}

function writeRgba16(out: Uint8ClampedArray, outOffset: number, value: number): void {
    out[outOffset] = (value & 0x1f) << 3;
    out[outOffset + 1] = ((value >> 5) & 0x1f) << 3;
    out[outOffset + 2] = ((value >> 10) & 0x1f) << 3;
    out[outOffset + 3] = value & 0x8000 ? 255 : 0;
}

function decodePalette(data: Uint8Array, picture: ParsedPicture,
                       path: string): Uint8ClampedArray {
    const kind = picture.clutType & 0x3f;
    const bytesPerColor = kind === RGBA32 ? 4
        : kind === RGB24 ? 3 : kind === RGBA16 ? 2 : 0;
    if (!bytesPerColor)
        fail(path, 0, `unsupported TIM2 CLUT type 0x${picture.clutType.toString(16)}`);
    if (picture.colorCount * bytesPerColor > picture.clutSize)
        fail(path, picture.body + picture.imageSize,
             "TIM2 palette exceeds declared CLUT size");
    const offset = picture.body + picture.imageSize;
    requireRange(data, offset, picture.colorCount * bytesPerColor, path, "TIM2 palette");
    const palette = new Uint8ClampedArray(picture.colorCount * 4);
    const csm2 = (picture.clutType & 0x80) !== 0;
    for (let index = 0; index < picture.colorCount; index++) {
        const sourceIndex = !csm2 && picture.colorCount === 256
            ? (index & 0xe7) | ((index & 0x08) << 1) | ((index & 0x10) >> 1)
            : index;
        const source = offset + sourceIndex * bytesPerColor;
        const target = index * 4;
        if (kind === RGBA32) {
            palette[target] = data[source]!;
            palette[target + 1] = data[source + 1]!;
            palette[target + 2] = data[source + 2]!;
            palette[target + 3] = alpha(data[source + 3]!);
        } else if (kind === RGB24) {
            palette[target] = data[source]!;
            palette[target + 1] = data[source + 1]!;
            palette[target + 2] = data[source + 2]!;
            palette[target + 3] = 255;
        } else {
            writeRgba16(palette, target, data[source]! | data[source + 1]! << 8);
        }
    }
    return palette;
}

/** Decode one TIM2 picture to top-down RGBA pixels. */
export function decodeTim2(data: Uint8Array, pictureIndex = 0,
                           path = "TIM2"): Tim2Image {
    const picture = parsedPictures(data, path)[pictureIndex];
    if (!picture) fail(path, 0, `TIM2 picture ${pictureIndex} does not exist`);
    const pixels = picture.width * picture.height;
    const rgba = new Uint8ClampedArray(pixels * 4);
    if (picture.imageType === IDTEX4 || picture.imageType === IDTEX8) {
        if (!picture.clutSize || !picture.colorCount)
            fail(path, picture.body, "indexed TIM2 picture has no palette");
        const palette = decodePalette(data, picture, path);
        const indexBytes = picture.imageType === IDTEX8 ? pixels : Math.ceil(pixels / 2);
        if (indexBytes > picture.imageSize)
            fail(path, picture.body, "TIM2 indices exceed declared image size");
        requireRange(data, picture.body, indexBytes, path, "TIM2 indices");
        for (let pixel = 0; pixel < pixels; pixel++) {
            const packed = data[picture.body
                + (picture.imageType === IDTEX8 ? pixel : pixel >> 1)]!;
            const index = picture.imageType === IDTEX8
                ? packed : pixel & 1 ? packed >> 4 : packed & 0x0f;
            if (index >= picture.colorCount)
                fail(path, picture.body,
                     `TIM2 palette index ${index} exceeds ${picture.colorCount}`);
            rgba.set(palette.subarray(index * 4, index * 4 + 4), pixel * 4);
        }
    } else if (picture.imageType === RGBA32 || picture.imageType === RGB24
               || picture.imageType === RGBA16) {
        const bytesPerPixel = picture.imageType === RGBA32 ? 4
            : picture.imageType === RGB24 ? 3 : 2;
        if (pixels * bytesPerPixel > picture.imageSize)
            fail(path, picture.body, "TIM2 pixels exceed declared image size");
        requireRange(data, picture.body, pixels * bytesPerPixel, path, "TIM2 pixels");
        for (let pixel = 0; pixel < pixels; pixel++) {
            const source = picture.body + pixel * bytesPerPixel;
            const target = pixel * 4;
            if (picture.imageType === RGBA16) {
                writeRgba16(rgba, target, data[source]! | data[source + 1]! << 8);
            } else {
                rgba[target] = data[source]!;
                rgba[target + 1] = data[source + 1]!;
                rgba[target + 2] = data[source + 2]!;
                rgba[target + 3] = picture.imageType === RGBA32
                    ? alpha(data[source + 3]!) : 255;
            }
        }
    } else {
        fail(path, picture.body, `unsupported TIM2 image type ${picture.imageType}`);
    }
    const { body: _body, imageSize: _imageSize, clutSize: _clutSize, ...info } = picture;
    return { ...info, rgba };
}
