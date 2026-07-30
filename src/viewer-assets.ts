import type { DiscSession } from "./disc.ts";
import { decodeTim2, inflateSz, memberBytes, unpackPck } from "./vendor/extract/index.ts";


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



async function imageUrl(data: Uint8Array, frame?: AssetSpec["frame"]): Promise<string> {
    const decoded = decodeTim2(data);
    const image = new ImageData(
        new Uint8ClampedArray(decoded.rgba),
        decoded.width,
        decoded.height,
    );
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
export async function loadViewerArt(session: DiscSession): Promise<ViewerArt | null> {
    const images: Partial<Record<ViewerArtId, string>> = {};
    const packages = new Map<string, AssetSpec[]>();
    for (const asset of ASSETS) {
        const specs = packages.get(asset.packageName) ?? [];
        specs.push(asset);
        packages.set(asset.packageName, specs);
    }

    for (const [packageName, specs] of packages) {
        const compressed = await session.read(packageName);
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
