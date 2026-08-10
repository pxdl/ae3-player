import { ascii } from "./bytes.ts";
import { locateFmvAssets, inspectFmvAsset } from "./fmv.ts";
import { locateImageContainers, scanImageTextures, type ImageTexture } from "./images.ts";
import { Iso9660, systemCnfSerial } from "./iso9660.ts";
import { inflateSz } from "./sz.ts";
import { memberBytes, pckFileNames, typeOf, unpackPck } from "./pck.ts";
import { type ByteSource } from "./source.ts";
import { Vfi, VFI_SECTOR, type VfiEntry } from "./vfi.ts";

export const DISC_SUPPORT_REPORT_SCHEMA = 1 as const;

export type DiscSupportStatus = "passed" | "partial" | "failed" | "not-found";
export type DiscSupportFamily = "images" | "effects" | "fmv";

export interface DiscSupportProgress {
    family: DiscSupportFamily;
    done: number;
    total: number;
    path: string;
}

export interface DiscSupportOptions {
    progress?: (progress: DiscSupportProgress) => void;
}

export interface DiscSupportIdentity {
    serial: string | null;
    volumeId: string;
}

export interface DiscSupportIssue {
    path: string;
    reason: string;
}

export interface SkippedDeclaredImage {
    path: string;
    memberIndex: number;
    fileName: string;
    byteLength: number;
    reason: "missing-tim2-magic";
}

export interface ImageSupportReport {
    status: DiscSupportStatus;
    checks: readonly ["PCK/SZ parsing", "TIM2 inspection"];
    containers: number;
    textures: number;
    pictures: number;
    skippedDeclared: SkippedDeclaredImage[];
    issues: DiscSupportIssue[];
}

export interface EffectSupportReport {
    status: DiscSupportStatus;
    checks: readonly ["HD/BD pairing", "complete file reads", "SShd header"];
    directory: string | null;
    pairedBanks: number;
    inspectedBanks: number;
    bytesRead: number;
    issues: DiscSupportIssue[];
}

export interface InspectedFmv {
    name: string;
    width: number;
    height: number;
    frameRate: number;
    fieldOrder: "progressive" | "tt" | "bb";
}

export interface FmvSupportReport {
    status: DiscSupportStatus;
    checks: readonly ["movie discovery", "subtitle sidecar pairing", "bounded STR/MPEG inspection"];
    discovered: number;
    inspected: number;
    movies: InspectedFmv[];
    issues: DiscSupportIssue[];
}

export interface DiscSupportReport {
    schemaVersion: typeof DISC_SUPPORT_REPORT_SCHEMA;
    tool: "@ae3/extract/ae3-report";
    disc: {
        serial: string | null;
        volumeId: string;
        dataBinBytes: number;
        vfiEntries: number;
        tableSha256: string;
    };
    images: ImageSupportReport;
    effects: EffectSupportReport;
    fmv: FmvSupportReport;
}

const IMAGE_CHECKS = ["PCK/SZ parsing", "TIM2 inspection"] as const;
const EFFECT_CHECKS = ["HD/BD pairing", "complete file reads", "SShd header"] as const;
const FMV_CHECKS = [
    "movie discovery",
    "subtitle sidecar pairing",
    "bounded STR/MPEG inspection",
] as const;
const MAX_ISSUE_LENGTH = 512;

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is DiscSupportStatus {
    return value === "passed" || value === "partial"
        || value === "failed" || value === "not-found";
}

function isBoundedText(value: unknown, maximum = MAX_ISSUE_LENGTH): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function hasChecks(value: unknown, expected: readonly string[]): boolean {
    return Array.isArray(value) && value.length === expected.length
        && value.every((item, index) => item === expected[index]);
}

function isIssue(value: unknown): value is DiscSupportIssue {
    const issue = objectValue(value);
    return issue !== null
        && isBoundedText(issue.path, 4096)
        && isBoundedText(issue.reason);
}

function isSkippedImage(value: unknown): value is SkippedDeclaredImage {
    const skipped = objectValue(value);
    return skipped !== null
        && isBoundedText(skipped.path, 4096)
        && isCount(skipped.memberIndex)
        && isBoundedText(skipped.fileName, 1024)
        && isCount(skipped.byteLength)
        && skipped.reason === "missing-tim2-magic";
}

function isInspectedFmv(value: unknown): value is InspectedFmv {
    const movie = objectValue(value);
    return movie !== null
        && isBoundedText(movie.name, 1024)
        && isCount(movie.width) && movie.width > 0
        && isCount(movie.height) && movie.height > 0
        && typeof movie.frameRate === "number"
        && Number.isFinite(movie.frameRate) && movie.frameRate > 0
        && (movie.fieldOrder === "progressive"
            || movie.fieldOrder === "tt" || movie.fieldOrder === "bb");
}

export function isDiscSupportReport(value: unknown): value is DiscSupportReport {
    const report = objectValue(value);
    if (report === null
            || report.schemaVersion !== DISC_SUPPORT_REPORT_SCHEMA
            || report.tool !== "@ae3/extract/ae3-report")
        return false;
    const disc = objectValue(report.disc);
    const images = objectValue(report.images);
    const effects = objectValue(report.effects);
    const fmv = objectValue(report.fmv);
    if (disc === null || images === null || effects === null || fmv === null)
        return false;
    if (!((disc.serial === null) || isBoundedText(disc.serial, 128))
            || !isBoundedText(disc.volumeId, 128)
            || !isCount(disc.dataBinBytes)
            || !isCount(disc.vfiEntries)
            || typeof disc.tableSha256 !== "string"
            || !/^[0-9a-f]{64}$/.test(disc.tableSha256))
        return false;
    if (!isStatus(images.status)
            || !hasChecks(images.checks, IMAGE_CHECKS)
            || !isCount(images.containers)
            || !isCount(images.textures)
            || !isCount(images.pictures)
            || !Array.isArray(images.skippedDeclared)
            || !images.skippedDeclared.every(isSkippedImage)
            || !Array.isArray(images.issues)
            || !images.issues.every(isIssue))
        return false;
    if (!isStatus(effects.status)
            || !hasChecks(effects.checks, EFFECT_CHECKS)
            || !(effects.directory === null
                || isBoundedText(effects.directory, 4096))
            || !isCount(effects.pairedBanks)
            || !isCount(effects.inspectedBanks)
            || effects.inspectedBanks > effects.pairedBanks
            || !isCount(effects.bytesRead)
            || !Array.isArray(effects.issues)
            || !effects.issues.every(isIssue))
        return false;
    if (!isStatus(fmv.status)
            || !hasChecks(fmv.checks, FMV_CHECKS)
            || !isCount(fmv.discovered)
            || !isCount(fmv.inspected)
            || !Array.isArray(fmv.movies)
            || !fmv.movies.every(isInspectedFmv)
            || fmv.movies.length !== fmv.inspected
            || fmv.inspected > fmv.discovered
            || !Array.isArray(fmv.issues)
            || !fmv.issues.every(isIssue))
        return false;
    return true;
}

function errorReason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const bounded = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
        .slice(0, MAX_ISSUE_LENGTH);
    return bounded || "unknown error";
}

function hasTim2Magic(data: Uint8Array): boolean {
    return data.length >= 4 && data[0] === 0x54 && data[1] === 0x49
        && data[2] === 0x4d && data[3] === 0x32;
}

async function skippedDeclaredImages(entry: VfiEntry,
                                     stored: Uint8Array): Promise<SkippedDeclaredImage[]> {
    if (/\.tm2$/i.test(entry.path)) return [];
    try {
        const pck = /\.sz$/i.test(entry.path) ? await inflateSz(stored) : stored;
        const members = unpackPck(pck);
        if (!members) return [];
        const names = pckFileNames(members);
        return members.flatMap(member => {
            if (typeOf(member.attrs).toLowerCase() !== "tm2"
                    || hasTim2Magic(memberBytes(pck, member)))
                return [];
            return [{
                path: entry.path,
                memberIndex: member.index,
                fileName: names[member.index]!,
                byteLength: member.size,
                reason: "missing-tim2-magic" as const,
            }];
        });
    } catch {
        // The canonical image scan below reports container format failures.
        return [];
    }
}

function familyStatus(successes: number, issues: number): DiscSupportStatus {
    if (successes === 0) return issues === 0 ? "not-found" : "failed";
    return issues === 0 ? "passed" : "partial";
}

async function inspectImages(vfi: Vfi,
                             options: DiscSupportOptions): Promise<ImageSupportReport> {
    const containers = locateImageContainers(vfi);
    if (containers.length === 0) {
        return {
            status: "not-found",
            checks: IMAGE_CHECKS,
            containers: 0,
            textures: 0,
            pictures: 0,
            skippedDeclared: [],
            issues: [],
        };
    }

    const skippedDeclared: SkippedDeclaredImage[] = [];
    const reportingVfi = {
        entries: vfi.entries,
        read: async (entry: VfiEntry): Promise<Uint8Array> => {
            const stored = await vfi.read(entry);
            skippedDeclared.push(...await skippedDeclaredImages(entry, stored));
            return stored;
        },
    } as Vfi;

    try {
        const scan = await scanImageTextures(reportingVfi, {
            progress: (done, total, path) =>
                options.progress?.({ family: "images", done, total, path }),
        }) as ImageTexture[] | {
            textures: ImageTexture[];
            issues: DiscSupportIssue[];
        };
        const textures = Array.isArray(scan) ? scan : scan.textures;
        const pictures = textures.reduce((total, texture) =>
            total + texture.pictures.length, 0);
        const issues = [
            ...(Array.isArray(scan) ? [] : scan.issues),
            ...skippedDeclared.map(item => ({
                path: `${item.path}#${item.memberIndex}:${item.fileName}`,
                reason: "declared as TIM2 but has no TIM2 signature",
            })),
        ];
        return {
            status: familyStatus(textures.length, issues.length),
            checks: IMAGE_CHECKS,
            containers: containers.length,
            textures: textures.length,
            pictures,
            skippedDeclared,
            issues,
        };
    } catch (error) {
        return {
            status: "failed",
            checks: IMAGE_CHECKS,
            containers: containers.length,
            textures: 0,
            pictures: 0,
            skippedDeclared,
            issues: [{ path: "images", reason: errorReason(error) }],
        };
    }
}

function selectEffectDirectory(vfi: Vfi): [string, VfiEntry[]] | null {
    const entries = vfi.entries.filter(entry =>
        /(^|\/)sound\/se\/[^/]+\.(hd|bd)$/i.test(entry.path));
    const byDirectory = new Map<string, VfiEntry[]>();
    for (const entry of entries) {
        const directory = entry.path.slice(0, entry.path.lastIndexOf("/"));
        const group = byDirectory.get(directory);
        if (group) group.push(entry);
        else byDirectory.set(directory, [entry]);
    }
    return [...byDirectory.entries()].sort((a, b) =>
        b[1].length - a[1].length || a[0].localeCompare(b[0]))[0] ?? null;
}

function hasSshdMagic(header: Uint8Array): boolean {
    return header.length >= 0x10 && header[0x0c] === 0x53
        && header[0x0d] === 0x53 && header[0x0e] === 0x68
        && header[0x0f] === 0x64;
}

async function inspectEffects(vfi: Vfi,
                              options: DiscSupportOptions): Promise<EffectSupportReport> {
    const selected = selectEffectDirectory(vfi);
    if (!selected) {
        return {
            status: "not-found",
            checks: EFFECT_CHECKS,
            directory: null,
            pairedBanks: 0,
            inspectedBanks: 0,
            bytesRead: 0,
            issues: [],
        };
    }

    const [directory, entries] = selected;
    const byName = new Map(entries.map(entry => [entry.name.toLowerCase(), entry]));
    const pairs: Array<{ name: string; header: VfiEntry; body: VfiEntry }> = [];
    const issues: DiscSupportIssue[] = [];
    for (const header of entries.filter(entry => /\.hd$/i.test(entry.name))) {
        const stem = header.name.slice(0, -3);
        const body = byName.get(`${stem}.bd`.toLowerCase());
        if (body) pairs.push({ name: stem, header, body });
        else issues.push({ path: header.path, reason: "matching .bd file is missing" });
    }
    const pairedBodies = new Set(pairs.map(pair => pair.body.path));
    for (const body of entries.filter(entry => /\.bd$/i.test(entry.name)))
        if (!pairedBodies.has(body.path))
            issues.push({ path: body.path, reason: "matching .hd file is missing" });
    pairs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    let inspectedBanks = 0;
    let bytesRead = 0;
    for (let index = 0; index < pairs.length; index++) {
        const pair = pairs[index]!;
        options.progress?.({
            family: "effects",
            done: index,
            total: pairs.length,
            path: pair.name,
        });
        try {
            const header = await vfi.read(pair.header);
            const body = await vfi.read(pair.body);
            bytesRead += header.length + body.length;
            if (!hasSshdMagic(header))
                throw new Error("missing SShd magic at header offset 0x0c");
            if (body.length === 0) throw new Error("empty .bd file");
            inspectedBanks++;
        } catch (error) {
            issues.push({ path: pair.header.path, reason: errorReason(error) });
        }
    }
    options.progress?.({
        family: "effects",
        done: pairs.length,
        total: pairs.length,
        path: "done",
    });
    return {
        status: familyStatus(inspectedBanks, issues.length),
        checks: EFFECT_CHECKS,
        directory,
        pairedBanks: pairs.length,
        inspectedBanks,
        bytesRead,
        issues,
    };
}

async function inspectFmv(vfi: Vfi,
                          options: DiscSupportOptions): Promise<FmvSupportReport> {
    let assets;
    try {
        assets = locateFmvAssets(vfi);
    } catch (error) {
        if (/no movie\/\*\.str assets found/.test(errorReason(error))) {
            return {
                status: "not-found",
                checks: FMV_CHECKS,
                discovered: 0,
                inspected: 0,
                movies: [],
                issues: [],
            };
        }
        return {
            status: "failed",
            checks: FMV_CHECKS,
            discovered: 0,
            inspected: 0,
            movies: [],
            issues: [{ path: "fmv", reason: errorReason(error) }],
        };
    }

    const movies: InspectedFmv[] = [];
    const issues: DiscSupportIssue[] = [];
    for (let index = 0; index < assets.length; index++) {
        const asset = assets[index]!;
        options.progress?.({
            family: "fmv",
            done: index,
            total: assets.length,
            path: asset.movie.path,
        });
        if ("formatError" in asset) {
            issues.push({ path: asset.movie.path, reason: errorReason(asset.formatError) });
            continue;
        }
        try {
            const { videoInfo } = await inspectFmvAsset(vfi, asset.movie);
            movies.push({
                name: asset.name,
                width: videoInfo.width,
                height: videoInfo.height,
                frameRate: videoInfo.frameRate,
                fieldOrder: videoInfo.fieldOrder,
            });
        } catch (error) {
            issues.push({ path: asset.movie.path, reason: errorReason(error) });
        }
    }
    options.progress?.({
        family: "fmv",
        done: assets.length,
        total: assets.length,
        path: "done",
    });
    return {
        status: familyStatus(movies.length, issues.length),
        checks: FMV_CHECKS,
        discovered: assets.length,
        inspected: movies.length,
        movies,
        issues,
    };
}

export async function inspectVfiSupport(
    vfi: Vfi,
    identity: DiscSupportIdentity,
    options: DiscSupportOptions = {},
): Promise<DiscSupportReport> {
    const table = await vfi.src.read(
        0,
        Math.min(vfi.dataOff * VFI_SECTOR, vfi.src.size),
    );
    const digest = await crypto.subtle.digest(
        "SHA-256",
        table.slice().buffer as ArrayBuffer,
    );
    const tableSha256 = [...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, "0")).join("");
    const images = await inspectImages(vfi, options);
    const effects = await inspectEffects(vfi, options);
    const fmv = await inspectFmv(vfi, options);
    return {
        schemaVersion: DISC_SUPPORT_REPORT_SCHEMA,
        tool: "@ae3/extract/ae3-report",
        disc: {
            serial: identity.serial,
            volumeId: identity.volumeId,
            dataBinBytes: vfi.src.size,
            vfiEntries: vfi.entries.length,
            tableSha256,
        },
        images,
        effects,
        fmv,
    };
}

export async function inspectDiscSupport(
    source: ByteSource,
    options: DiscSupportOptions = {},
): Promise<DiscSupportReport> {
    const iso = await Iso9660.open(source);
    const systemCnf = await iso.findRoot("SYSTEM.CNF");
    const serial = systemCnf
        ? systemCnfSerial(ascii(await iso.window(systemCnf).read(0, systemCnf.size)))
        : null;
    const dataEntry = await iso.findRoot("DATA.BIN");
    if (!dataEntry || dataEntry.isDir)
        throw new Error("DATA.BIN not found on this disc (not Ape Escape 3?)");
    const vfi = await Vfi.open(iso.window(dataEntry));
    return inspectVfiSupport(vfi, { serial, volumeId: iso.volumeId }, options);
}

function statusLabel(status: DiscSupportStatus): string {
    switch (status) {
        case "passed": return "Passed";
        case "partial": return "Partial";
        case "failed": return "Failed";
        case "not-found": return "Not found";
    }
}

function markdownCell(status: DiscSupportStatus, detail: string): string {
    return status === "not-found" ? statusLabel(status) : `${statusLabel(status)}: ${detail}`;
}

export function formatDiscSupportMarkdown(report: DiscSupportReport,
                                          build = report.disc.serial ?? report.disc.volumeId): string {
    const safeBuild = build.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .trim().replace(/\|/g, "\\|") || "Unknown build";
    const imageDetail = `${report.images.textures.toLocaleString("en-US")} textures / `
        + `${report.images.pictures.toLocaleString("en-US")} pictures`
        + (report.images.skippedDeclared.length > 0
            ? `; ${report.images.skippedDeclared.length.toLocaleString("en-US")} declared entries without TIM2 signatures`
            : "");
    const effectDetail = `${report.effects.inspectedBanks.toLocaleString("en-US")}/`
        + `${report.effects.pairedBanks.toLocaleString("en-US")} paired banks inspected`;
    const fmvDetail = `${report.fmv.inspected.toLocaleString("en-US")}/`
        + `${report.fmv.discovered.toLocaleString("en-US")} inspected`;
    return [
        "| Build | Images | Effects | FMV |",
        "| --- | --- | --- | --- |",
        `| ${safeBuild} | ${markdownCell(report.images.status, imageDetail)} | `
            + `${markdownCell(report.effects.status, effectDetail)} | `
            + `${markdownCell(report.fmv.status, fmvDetail)} |`,
        "",
    ].join("\n");
}
