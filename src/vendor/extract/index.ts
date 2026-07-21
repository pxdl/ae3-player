/* @ae3/extract -- client-side asset extraction for the AE3 BGM player.
 *
 * Chain: ISO file -> ISO9660 -> DATA.BIN -> VFI -> (.sz deflate, .pck) ->
 * assets -> OPFS cache. Everything runs on the user's machine against their
 * own disc image; this package ships no game data and uploads nothing.
 *
 * Entry point for apps: openDisc(new BlobSource(file)).
 * Format specs: ../docs/formats/DATA_BIN.md, EXTRACTION.md.
 * Oracles: tools/ae3tools/{vfiparse,vfiextract,exdb}.py -- the private differ
 * keeps this package byte-identical to them against the real corpus. */

export { type ByteSource, BytesSource, BlobSource, SubSource } from "./source.ts";
export { Iso9660, ISO_SECTOR, type IsoDirent, systemCnfSerial } from "./iso9660.ts";
export { Vfi, type VfiEntry, VFI_MAGIC, VFI_SECTOR } from "./vfi.ts";
export { inflateSz } from "./sz.ts";
export { unpackPck, memberBytes, typeOf, attrsOf, safeMember, pckFileNames,
         type PckMember } from "./pck.ts";
export { parseExdb, bgmDescRecords, bgmSongTable, natcmp,
         type Exdb, type ExdbField, type BgmDescRecord, type BgmSong } from "./exdb.ts";
export { openDisc, locateBgmAssets, loadBgmDesc, readPckMember, sniff,
         type Ae3Disc, type BgmAssetSet } from "./manifest.ts";
export { locateFmvAssets, parseFmvHeader, parseMpeg2VideoInfo,
         indexMpeg2SeekPoints, inspectFmvPrefix, inspectFmvAsset, demuxFmv,
         parseFmvSubtitles, subtitlesToSrt, subtitlesToVtt,
         type FmvAsset, type FmvHeader, type FmvVideoInfo, type FmvGroup,
         type FmvDemux, type Mpeg2SeekPoint, type Mpeg2SeekIndex,
         type SubtitleCue } from "./fmv.ts";
export { OpfsCache } from "./opfs.ts";
