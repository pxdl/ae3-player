/* @ae3/extract -- client-side Ape Escape 3 asset extraction.
 *
 * Chain: ISO file -> ISO9660 -> DATA.BIN -> VFI -> (.sz deflate, .pck,
 * packfile) -> assets / FMV demux -> OPFS cache. Everything runs on the user's
 * machine against their own disc image; this package ships no game data and uploads
 * nothing.
 *
 * Entry point for apps: openDisc(new BlobSource(file)).
 * Format specs: ../docs/formats/{DATA_BIN,EXTRACTION,FMV}.md.
 * Oracles: tools/ae3tools/{vfiparse,vfiextract,exdb,strextract,sbt2srt}.py;
 * private differs keep the browser implementation byte-identical on the real
 * corpus. */

export { type ByteSource, BytesSource, BlobSource, SubSource } from "./source.ts";
export { Iso9660, ISO_SECTOR, type IsoDirent, systemCnfSerial } from "./iso9660.ts";
export { Vfi, type VfiEntry, VFI_MAGIC, VFI_SECTOR } from "./vfi.ts";
export { inflateSz } from "./sz.ts";
export { unpackPck, memberBytes, typeOf, attrsOf, safeMember, pckFileNames,
         type PckMember } from "./pck.ts";
export { inspectTim2, decodeTim2,
         type Tim2PictureInfo, type Tim2Image } from "./tim2.ts";
export { inspectIpc, ipcToIpum, IPC_HEADER_SIZE, type IpcInfo } from "./ipc.ts";
export {
    parsePackfile, packfileMemberBytes,
    PACKFILE_HEADER_SIZE, PACKFILE_MEMBER_HEADER_SIZE,
    type Packfile, type PackfileSlot, type PackfileMember,
} from "./packfile.ts";
export { locateImageContainers, scanImageTextures, readImageTexture,
         type ImageTexture, type ImageScanIssue, type ImageScanResult,
         type ImageScanSkippedMember,
         type ImageScanOptions, type ImageRole, type ImageRoleEvidence } from "./images.ts";
export { ImageFormatError, type ImageFormat } from "./image-format.ts";
export {
    locateModelContainers, scanModelAssets, readModelAsset, readModelPackage,
    inspectI3dModel, decodeI3dModel, decodeI3dAnimation, decodeI3dCollision,
    type ModelAssetKind, type ModelAsset, type ModelScanOptions,
    type ModelInspection, type DecodedBone, type DecodedMaterialState,
    type DecodedMesh, type DecodedModel,
    type DecodedAnimationTrack, type DecodedAnimation, type DecodedCollision,
} from "./models.ts";
export {
    i3dAlphaRegister, i3dTestRegister, i3dFactorScale, evaluateFogState,
    evaluateFogFactor, evaluateDirectionalLights, evaluateMode2DirectionalLights,
    evaluatePointLights, evaluateMode2PointLights, evaluateSpotLights,
    evaluateMode2SpotLights, evaluateRadialLights, evaluateHemisphereLights,
    evaluateFinalColor, type FogSource, type EvaluatedFogState,
    type DirectionalLightVector, type PointLightVector, type SpotLightVector,
    type RadialLightVector, type HemisphereLightVector, type Vec4,
} from "./i3drender.ts";
export { parseExdb, bgmDescRecords, bgmSongTable, natcmp,
         type Exdb, type ExdbField, type BgmDescRecord, type BgmSong } from "./exdb.ts";
export { openDisc, locateBgmAssets, loadBgmDesc, readPckMember, sniff,
         type Ae3Disc, type BgmAssetSet } from "./manifest.ts";
export { locateFmvAssets, parseFmvHeader, parseMpeg2VideoInfo,
         indexMpeg2SeekPoints, inspectFmvPrefix, inspectFmvAsset, inspectFmv, demuxFmv,
         parseFmvSubtitles, subtitlesToSrt, subtitlesToVtt,
         fmvLanguage, FMV_PAL_AUDIO_LANGUAGES,
         type FmvAsset, type FmvSubtitleAsset, type FmvHeader, type FmvVideoInfo, type FmvGroup,
         type FmvDemux, type Mpeg2SeekPoint, type Mpeg2SeekIndex,
         type SubtitleCue } from "./fmv.ts";
export {
    DISC_SUPPORT_REPORT_SCHEMA, isDiscSupportReport,
    inspectDiscSupport, inspectVfiSupport, formatDiscSupportMarkdown,
    type DiscSupportStatus, type DiscSupportFamily, type DiscSupportProgress,
    type DiscSupportOptions, type DiscSupportIdentity, type DiscSupportIssue,
    type SkippedDeclaredImage, type ImageSupportReport,
    type EffectSupportReport, type InspectedFmv, type FmvSupportReport,
    type DiscSupportReport,
} from "./report.ts";
export { OpfsCache } from "./opfs.ts";
