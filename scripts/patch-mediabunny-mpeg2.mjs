import { readFile, writeFile } from "node:fs/promises";

const patches = [
    {
        path: "node_modules/mediabunny/dist/modules/src/codec.js",
        replacements: [
            ["    'prores',\n];", "    'prores',\n    'mpeg2',\n];"],
            ["const VALID_VIDEO_CODEC_STRING_PREFIXES = ['avc1', 'avc3', 'hev1', 'hvc1', 'vp8', 'vp09', 'av01', ...PRORES_FOURCCS];",
             "const VALID_VIDEO_CODEC_STRING_PREFIXES = ['avc1', 'avc3', 'hev1', 'hvc1', 'vp8', 'vp09', 'av01', 'mpeg2video', ...PRORES_FOURCCS];"],
        ],
    },
    {
        path: "node_modules/mediabunny/dist/modules/src/codec.d.ts",
        replacements: [[
            "readonly [\"avc\", \"hevc\", \"vp9\", \"av1\", \"vp8\", \"prores\"]",
            "readonly [\"avc\", \"hevc\", \"vp9\", \"av1\", \"vp8\", \"prores\", \"mpeg2\"]",
        ]],
    },
    {
        path: "node_modules/mediabunny/dist/modules/src/matroska/ebml.js",
        replacements: [[
            "    'prores': 'V_PRORES',",
            "    'prores': 'V_PRORES',\n    'mpeg2': 'V_MPEG2',",
        ]],
    },
];

for (const patch of patches) {
    let source = await readFile(new URL(`../${patch.path}`, import.meta.url), "utf8");
    for (const [before, after] of patch.replacements) {
        if (source.includes(after))
            continue;
        if (!source.includes(before))
            throw new Error(`Mediabunny ${patch.path} no longer matches the MPEG-2 extension`);
        source = source.replace(before, after);
    }
    await writeFile(new URL(`../${patch.path}`, import.meta.url), source);
}
