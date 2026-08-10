export type ImageFormat = "TIM2" | "PCK" | "SZ";

/** A proven violation of one image container format. */
export class ImageFormatError extends Error {
    readonly format: ImageFormat;
    readonly source: string;
    readonly offset: number;
    readonly detail: string;

    constructor(source: string, offset: number, detail: string, format: ImageFormat) {
        super(`${source} at 0x${offset.toString(16)}: ${detail}`);
        this.name = "ImageFormatError";
        this.format = format;
        this.source = source;
        this.offset = offset;
        this.detail = detail;
    }
}
