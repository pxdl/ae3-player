/* App controller: picker <-> player states, transport, dials, visualizers,
 * export, help, keyboard. Port of the reference consumer's behavior (ae3-sdk
 * harness/bgmplay.c keys, defaults, layout). */

import "./style.css";
import {
    discSupportWarning,
    friendlyError,
    openIso,
    resumeSession,
    type DiscSession,
} from "./disc.ts";
import {
    DiscOpenCoordinator,
    SerializedDiscCleanup,
    type DiscOpenTicket,
} from "./disc-open.ts";
import { WorkletPlayer, RATE, type EngineConfig, type Snapshot } from "./player.ts";
import { buildTimeline, displayPos, bpmOf, midiDurationSamples, type Timeline } from "./timeline.ts";
import { Viz } from "./viz.ts";
import { Exporter, download, type ExportOpts, type SeExportOpts } from "./export.ts";
import { storeZip, storeZipBlob } from "./zip.ts";
import { groupStreams, StreamDecoder, StreamPlayer,
         type StreamCatalog, type StreamEntry } from "./streams.ts";
import { StreamViz } from "./sviz.ts";
import { SeInspector, type SeBankEntry, type SeCatalog,
         type SeMeasureFiles, type SeRequestInfo } from "./se.ts";
import { SeSequenceViz, SeSourceLoopViz } from "./seviz.ts";
import { MovieController, type MovieControllerSnapshot } from "./movie-controller.ts";
import {
    formatMovieBytes,
    movieGroupLabel,
    movieScanLabel,
    movieSourceComplete,
} from "./movie-presentation.ts";
import type { MovieEntry, MovieExportKind } from "./movies.ts";
import {
    filterImageEntries,
    imageEntries,
    imageExportPath,
    imagePng,
    imageTreePath,
    sortImageEntries,
    type ImageCatalog,
    type ImageEntry,
    type ImageRoleFilter,
    type ImageSortDirection,
} from "./images.ts";
import { decodeTim2 } from "./vendor/extract/index.ts";
import type { ModelBrowser } from "./model-browser.ts";
import { StagePreviewBrowser } from "./stage-preview-browser.ts";

export type ViewerChannel = "music" | "streams" | "effects" | "cinema";

export interface ViewerItem {
    id: string;
    label: string;
    detail: string;
    duration: number | null;
    kind: "media" | "group";
    playing: boolean;
    group?: string;
}

export interface ViewerSetup {
    label: string;
    detail: string;
    progress: number | null;
}

export interface ViewerLibrary {
    revision: number;
    connected: boolean;
    channel: ViewerChannel;
    discLabel: string;
    status: string;
    error: boolean;
    items: ViewerItem[];
    selectedId: string | null;
    counts: Record<ViewerChannel, number | null>;
}

export interface ViewerTransport {
    title: string;
    current: number;
    duration: number;
    progress: number;
    playing: boolean;
    loading: boolean;
    canExport: boolean;
    exporting: boolean;
    status: string;
    error: boolean;
}


const LOOP_FOREVER = 0x7f;
const SE_SEEK_LIMIT = 5 * 60 * RATE;

const $ = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

/* ---- state -------------------------------------------------------------- */
let session: DiscSession | null = null;
let player: WorkletPlayer | null = null;
let timeline: Timeline | null = null;
let viz: Viz | null = null;
let sel = 0;                    /* highlighted row */
let playingIdx = -1;            /* loaded song */
let loading = false;
let finished = false;
let authored = true;
let loopN = 2;                  /* export dropdown's loop count */
let prevClip = 0;               /* bus+wet clip total, for the flash */
let clipFlash = 0;              /* performance.now() of the last increase */
let pbGlyph = "";               /* last glyph written to the play button */
const cfg = { songvol: 44, revDepth: 30, exact: true, gaussian: true, loop: true,
              cueOn: false, cueScale: 44.5 / 127,
              duckDemo: false, duckPhone: false };
const exporter = new Exporter();
const discOpens = new DiscOpenCoordinator();
const discCleanup = new SerializedDiscCleanup();
let audioMode: "bgm" | "se" | null = null;
let viewerRevision = 0;
const VIEWER_LEVEL_COUNT = 32;
const viewerLevelHistory = new Float32Array(VIEWER_LEVEL_COUNT);
let viewerLevelHead = 0;
let bgmDurations = new Float64Array();
let bgmDurationWarning: string | null = null;

function ingestViewerLevels(snapshot: Snapshot): void {
    for (let offset = 0; offset + 5 <= snapshot.wcols.length; offset += 5) {
        const level = Math.max(
            Math.abs(snapshot.wcols[offset]!),
            Math.abs(snapshot.wcols[offset + 1]!),
            Math.abs(snapshot.wcols[offset + 2]!),
            Math.abs(snapshot.wcols[offset + 3]!),
        );
        viewerLevelHistory[viewerLevelHead] = Math.sqrt(Math.min(1, level));
        viewerLevelHead = (viewerLevelHead + 1) % VIEWER_LEVEL_COUNT;
    }
}

/* streams tab */
type AppTab = "bgm" | "streams" | "se" | "fmv" | "images"
    | "stage-previews" | "models";
let tab: AppTab = "bgm";
let sCatalog: StreamCatalog | null = null;
let streamCatalogRequest: {
    target: DiscSession;
    promise: Promise<void>;
} | null = null;
/* The sidebar is a fold tree: MUSIC/VOICE sections -> prefix groups ->
 * entries. Selection walks every visible row (headers included), so the
 * keyboard can jump categories; groups start folded. */
type SRow =
    | { kind: "section"; id: string; label: string }
    | { kind: "group"; id: string; label: string }
    | { kind: "entry"; entry: StreamEntry };
let sRows: SRow[] = [];             /* visible rows, selection space */
const sFolded = new Set<string>();  /* ids: "MUSIC", "MUSIC/mgm", ... */
let sFoldInit = false;
let sSel = 0;
let sPlayingName: string | null = null;
let sLoading = false;
let sTrim = true;                   /* TRIM PAD dial, default on */
let sGlyph = "";
let sBusy = false;                  /* export in flight */
let sExtracting = false;
const sDecoder = new StreamDecoder();
const sPlayer = new StreamPlayer();
let sViz: StreamViz | null = null;
let fmvRenderedRevision = -1;
let fmvAttachedRevision = -1;
let fmvGlyph = "";
let fmvVisibleNames: string[] = [];
let fmvRenderedSearch = "";
let fmvRenderedEntryName: string | null = null;
let imageCatalog: ImageCatalog | null = null;
let imageCatalogRequest: {
    target: DiscSession;
    promise: Promise<void>;
} | null = null;
let imageAllRows: ImageEntry[] = [];
let imageEntryById = new Map<string, ImageEntry>();
let imageRows: ImageEntry[] = [];
let imageSelected: ImageEntry | null = null;
type ImageViewMode = "grid" | "list" | "tree";
let imageViewMode: ImageViewMode = "grid";
let imageSortDirection: ImageSortDirection = "asc";
let imageVisibleLimit = 120;
let imageLoadGeneration = 0;
let imageRenderGeneration = 0;
let imageListObserver: IntersectionObserver | null = null;
let imageThumbnailObserver: IntersectionObserver | null = null;
let imageThumbnailQueue: Array<{
    canvas: HTMLCanvasElement;
    entry: ImageEntry;
    generation: number;
}> = [];
let imageThumbnailActive = 0;
let imageExtracting = false;
let imageExporting = false;
const DEFAULT_SIDE_WIDTH = 252;
const MIN_SIDE_WIDTH = 220;
const SIDE_WIDTH_KEY = "ae3.sideWidth";
let sideWidth = DEFAULT_SIDE_WIDTH;
let modelBrowser: ModelBrowser | null = null;
let modelBrowserLoading: Promise<ModelBrowser> | null = null;
let stagePreviewBrowser: StagePreviewBrowser | null = null;

function ensureStagePreviewBrowser(): StagePreviewBrowser {
    stagePreviewBrowser ??= new StagePreviewBrowser({ status, friendlyError });
    if (session) stagePreviewBrowser.setStore(session.stagePreviews);
    return stagePreviewBrowser;
}


function ensureModelBrowser(): Promise<ModelBrowser> {
    if (modelBrowser) return Promise.resolve(modelBrowser);
    modelBrowserLoading ??= import("./model-browser.ts").then(({ ModelBrowser }) => {
        modelBrowser = new ModelBrowser((message, error) =>
            statusWithWarnings(session, "models", message, error));
        if (session) modelBrowser.setStore(session.models);
        return modelBrowser;
    }).catch(error => {
        modelBrowserLoading = null;
        throw error;
    });
    return modelBrowserLoading;
}


/* embedded sequenced effects */
type SeRow =
    | { kind: "bank"; entry: SeBankEntry }
    | { kind: "cue"; entry: SeBankEntry; bank: number; request: number };
let seCatalog: SeCatalog | null = null;
let seCatalogRequest: {
    target: DiscSession;
    promise: Promise<boolean>;
} | null = null;
let seRows: SeRow[] = [];
let seSel = 0;
let seBusy = false;
let seOpenBank: string | null = null;
let seShape: Uint16Array | null = null;
let seDetails: (SeRequestInfo | null)[][] | null = null;
let seLoading = false;
let seExtracting = false;
let sePlaying: Extract<SeRow, { kind: "cue" }> | null = null;
let sePlayingInfo: SeRequestInfo | null = null;
let seGlyph = "";
let seKnownFrames: number | null = null;
let seKnownEstimated = false;
let seMeasureError: string | null = null;
let seMeasuring = false;
let seMeasureToken = 0;
let sePastEvents = false;
let seViz: Viz | null = null;
let seSequenceViz: SeSequenceViz | null = null;
let seSourceLoopViz: SeSourceLoopViz | null = null;
const seInspector = new SeInspector();
const seCfg = {
    volume: 64, exact: true, gaussian: true, revDepth: 30, loop: true,
};


let viewerChannel: ViewerChannel = "music";
export const movieController = new MovieController({
    changed() { viewerRevision++; },
    pauseOtherMedia() {
        player?.pause();
        sPlayer.pause();
    },
    deliver(output) {
        download(output.bytes, output.filename, output.mime);
    },
});
const engineConfig = (): EngineConfig => ({
    songvol: cfg.songvol, revDepth: cfg.revDepth, exact: cfg.exact,
    gaussian: cfg.gaussian, loop: cfg.loop ? LOOP_FOREVER : 0,
    cueOn: cfg.cueOn, cueScale: cfg.cueScale,
    duckDemo: cfg.duckDemo, duckPhone: cfg.duckPhone,
});

/* ---- status line -------------------------------------------------------- */
function status(msg: string, err = false): void {
    const el = $("status");
    el.textContent = msg;
    el.classList.toggle("err", err);
}

/* ---- song list ---------------------------------------------------------- */
function renderList(): void {
    const ul = $("songlist");
    ul.replaceChildren(...session!.songs.map((song, index) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "song-title";
        name.textContent = song.name;
        const duration = document.createElement("span");
        duration.className = "dur";
        const samples = bgmDurations[index];
        duration.textContent = samples !== undefined && Number.isFinite(samples)
            ? fmtTime(samples) : "—";
        li.append(name, duration);
        li.classList.toggle("sel", index === sel);
        li.classList.toggle("playing", index === playingIdx);
        li.onclick = () => { sel = index; void loadSong(index, true); };
        return li;
    }));
    viewerRevision++;
}

async function loadBgmDurations(target: DiscSession): Promise<void> {
    const durations = bgmDurations;
    let failures = 0;
    let firstFailure: unknown;
    for (let index = 0; index < target.songs.length; index++) {
        const song = target.songs[index]!;
        try {
            const midi = await target.read(`bgm/${song.mid}`);
            if (!midi) throw new Error(`missing bgm/${song.mid}`);
            durations[index] = midiDurationSamples(midi);
        } catch (error) {
            if (failures === 0) firstFailure = error;
            failures++;
            console.warn(`Could not calculate duration for ${song.name}`, error);
        }
    }
    if (session !== target || bgmDurations !== durations) return;
    bgmDurationWarning = failures > 0
        ? `${failures} song duration${failures === 1 ? "" : "s"} unavailable: `
            + friendlyError(firstFailure)
        : null;
    renderList();
    if (tab === "bgm") statusWithWarnings(target, "bgm");
}

function scrollSelIntoView(): void {
    $("songlist").children[sel]?.scrollIntoView({ block: "nearest" });
}

/* ---- dials -------------------------------------------------------------- */
function renderDials(): void {
    const vol = $("d-vol");
    vol.textContent = `VOL ${cfg.songvol}${authored ? " AUTH" : ""}`;
    vol.classList.toggle("on", authored);
    const loop = $("d-loop");
    loop.textContent = "LOOP";
    loop.classList.toggle("on", cfg.loop);
    const timing = $("d-timing");
    timing.textContent = cfg.exact ? "EXACT" : "TICK";
    timing.classList.toggle("on", cfg.exact);
    const kernel = $("d-kernel");
    kernel.textContent = cfg.gaussian ? "GAUSS" : "BRIGHT";
    kernel.classList.toggle("on", cfg.gaussian);
    const rev = $("d-rev");
    rev.textContent = cfg.revDepth > 0 ? `REV ${cfg.revDepth}` : "REV OFF";
    rev.classList.toggle("on", cfg.revDepth > 0);
    $("d-duck").classList.toggle("on", cfg.duckDemo);
}

/* ---- transport ---------------------------------------------------------- */
/* The audio stack is created lazily INSIDE the first user gesture: Safari
 * only lets an AudioContext run when its creating gesture (not merely a
 * later resume()) is user-initiated under stricter Auto-Play policies.
 * Chrome/Firefox are indifferent to the timing. */
let playerReady: Promise<WorkletPlayer> | null = null;
let playerGeneration = 0;

function ensurePlayer(): Promise<WorkletPlayer> {
    if (playerReady) return playerReady;
    const generation = playerGeneration;
    let pending: Promise<WorkletPlayer>;
    pending = WorkletPlayer.create().then(async (next) => {
        if (generation !== playerGeneration) {
            try {
                await next.ctx.close();
            } catch (error) {
                console.error("superseded audio context close failed", error);
            }
            throw new DOMException("audio setup superseded", "AbortError");
        }
        player = next;
        next.onended = () => { finished = true; };
        next.onerror = (message) => status(message, true);
        next.onsnapshot = (snapshot) => {
            if (audioMode === "se") seViz?.ingest(snapshot);
            else viz?.ingest(snapshot);
            ingestViewerLevels(snapshot);
        };
        return next;
    }).catch((error) => {
        if (playerReady === pending) playerReady = null;
        if (generation !== playerGeneration) throw error;
        $("song-name").textContent = "audio setup failed";
        throw new Error(
            `audio setup failed: ${friendlyError(error)}`
                + " -- an ad/content blocker may be blocking the synth",
            { cause: error },
        );
    });
    playerReady = pending;
    return pending;
}

/* Only call from a user-gesture handler: the context is created and resumed
 * inside that gesture, and the load round-trip cannot complete while it is
 * suspended. */
async function loadSong(idx: number, autoplay: boolean): Promise<void> {
    const target = session;
    if (!target || loading) return;
    const song = target.songs[idx];
    if (!song) return;
    let p: WorkletPlayer;
    try {
        p = await ensurePlayer();        /* sync up to the first await */
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
        return;
    }
    if (session !== target) return;
    p.resume();
    sPlayer.pause();                    /* one thing plays at a time */
    loading = true;
    seSourceLoopViz?.clear();
    finished = false;
    status(`loading ${song.name}...`);
    try {
        const assets = await target.songAssets(song);
        if (session !== target) return;
        if (authored) cfg.songvol = song.songvol;
        cfg.cueScale = song.volumeScale > 0 ? song.volumeScale : 44.5 / 127;
        const result = await p.load(assets, engineConfig());
        if (session !== target) return;
        audioMode = "bgm";
        timeline = buildTimeline(result.events, result.ppqn);
        bgmDurations[idx] = timeline.lenSamp;
        playingIdx = idx;
        p.snap = null;
        viz?.clearWave();
        viewerLevelHistory.fill(0);
        viewerLevelHead = 0;
        $("song-name").textContent = song.name;
        $("time-len").textContent = fmtTime(timeline.lenSamp);
        statusWithWarnings(
            target,
            "bgm",
            result.warning ? `warning: ${result.warning}` : "",
            !!result.warning,
        );
        if (autoplay) p.play();
        $<HTMLButtonElement>("playbtn").disabled = false;
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    } finally {
        if (session === target) {
            loading = false;
            renderList();
            renderDials();
        }
    }
}

function togglePlay(): void {
    if (!session) return;
    if (!player || playingIdx < 0 || audioMode !== "bgm") {
        void loadSong(sel, true);
    } else if (finished) {              /* bgmplay: SPACE after end restarts */
        finished = false;
        sPlayer.pause();
        player.seek(0);
        player.play();
    } else if (player.snap?.playing) {
        player.pause();
    } else {
        sPlayer.pause();
        player.play();
    }
}

function seekTimeline(sample: number): void {
    if (!player || !timeline || loading) return;
    finished = false;
    player.seek(Math.max(0, Math.min(sample, timeline.lenSamp - 1)));
}

function displaySample(): number {
    if (!player || !timeline) return 0;
    const s = player.snap;
    if (!s) return 0;
    return displayPos(timeline, player.heardPos(), s.clock);
}

/* ---- dial actions (bgmplay's keys) -------------------------------------- */
function setVol(v: number, auth: boolean): void {
    if (cfg.cueOn) {   /* manual volume takes songvol back from the cue layer */
        cfg.cueOn = cfg.duckDemo = cfg.duckPhone = false;
        player?.set("cueOn", false);
    }
    cfg.songvol = Math.max(1, Math.min(127, v));
    authored = auth;
    player?.set("songvol", cfg.songvol);
    renderDials();
}

/* Hold/release the duck (key D) -- bgmplay's cue_toggle on the demo group.
 * (The game's phone group is identical and never overlaps the cutscene one in
 * play, so the player exposes just this; both stay in the SDK API.) Arming
 * takes songvol at the authored scale, the game's own condition; releasing
 * leaves the layer armed so the 2 s ramp finishes -- - = A disarm via setVol. */
function toggleDuck(): void {
    if (!session || playingIdx < 0) return;
    cfg.duckDemo = !cfg.duckDemo;
    if (cfg.duckDemo && !cfg.cueOn) {
        cfg.cueOn = true;
        const song = session.songs[playingIdx]!;
        cfg.songvol = song.songvol;      /* what - = resume from */
        authored = true;
        player?.set("cueOn", true);
    }
    player?.set("duckDemo", cfg.duckDemo);
    renderDials();
}

function toggleLoop(): void {
    cfg.loop = !cfg.loop;
    player?.set("loop", cfg.loop ? LOOP_FOREVER : 0);
    renderDials();
}

function toggleTiming(): void {
    cfg.exact = !cfg.exact;
    player?.set("exact", cfg.exact);
    /* bgmplay re-seeks so the whole stream is consistent with the new clock */
    if (timeline) seekTimeline(displaySample());
    renderDials();
}

function toggleKernel(): void {
    cfg.gaussian = !cfg.gaussian;
    player?.set("gaussian", cfg.gaussian);
    renderDials();
}

function setRev(depth: number): void {
    cfg.revDepth = Math.max(0, Math.min(127, depth));
    player?.set("revDepth", cfg.revDepth);
    renderDials();
}

/* ---- streams tab --------------------------------------------------------- */
let keysBgmText = "";               /* captured from the DOM at boot */
const KEYS_STREAMS = "SPACE play · ↑↓ move · ←→ fold · ENTER load/fold "
    + "· T trim · E wav · X raw · H help · click bar/stage to seek";
const KEYS_SE = "SPACE play \u00B7 \u2191\u2193 move \u00B7 \u2190\u2192 fold \u00B7 ENTER load/fold "
    + "\u00B7 L stream loop/once \u00B7 - = volume \u00B7 T timing \u00B7 G kernel "
    + "\u00B7 R reverb \u00B7 E wav \u00B7 X bank \u00B7 click bar/score to seek \u00B7 H help";
const KEYS_FMV = "SPACE play · ↑↓ movie · ENTER play · ←→ seek 5 s · C captions "
    + "· F fullscreen · E exports · ESC exit/cancel · click bar to seek";
const KEYS_IMAGES = "↑↓ image · ENTER preview · E PNG · X original TM2 · A all PNG";
const KEYS_STAGE_PREVIEWS = "↑↓ stage · ←→ frame · E preview PNG · X IPC · T TM2 · A stages.bin";
const KEYS_MODELS = "↑↓ asset · ENTER preview · SPACE play/pause animation · "
    + "drag background to orbit · enable ROTATE, then drag center freely or an X/Y/Z ring";

const sDur = (e: StreamEntry): number =>
    e.sectors * (2048 / e.channels / 16 * 28) / e.rate;

function fmtSec(t: number): string {
    const m = Math.floor(Math.max(0, t) / 60);
    const s = Math.max(0, t) - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function escapeMarkup(value: string | number): string {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function movieHex(value: number, width = 0): string {
    return `0x${Math.max(0, value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function movieBytesDetail(bytes: number): string {
    return `${movieHex(bytes)} · ${formatMovieBytes(bytes)}`;
}

function renderFmvList(snapshot: MovieControllerSnapshot): void {
    const list = $("fmvlist");
    const query = $<HTMLInputElement>("fmv-search").value.trim().toLocaleLowerCase();
    fmvRenderedSearch = query;
    const entries = snapshot.catalog?.entries ?? [];
    const issues = snapshot.catalog?.issues ?? [];
    const groups = ["opening", "story", "gameplay"] as const;
    const groupedEntries = groups.map(group => entries.filter(entry => {
        if (entry.group !== group) return false;
        if (!query) return true;
        return entry.label.toLocaleLowerCase().includes(query)
            || entry.name.toLocaleLowerCase().includes(query)
            || entry.movie.path.toLocaleLowerCase().includes(query);
    }));
    const visibleIssues = issues.filter(issue => !query
        || issue.label.toLocaleLowerCase().includes(query)
        || issue.name.toLocaleLowerCase().includes(query)
        || issue.reason.toLocaleLowerCase().includes(query));
    const visible = groupedEntries.flat();
    fmvVisibleNames = visible.map(entry => entry.name);
    if (!snapshot.catalog) {
        list.innerHTML = `<li class="fmv-list-message">${snapshot.error
            ? "Movie catalog unavailable"
            : "Loading movie catalog…"}</li>`;
        return;
    }
    if (!visible.length && !visibleIssues.length) {
        list.innerHTML = `<li class="fmv-list-message">No matching movies</li>`;
        return;
    }
    const availableMarkup = groupedEntries.map(groupEntries => {
        if (!groupEntries.length) return "";
        const heading = movieGroupLabel(groupEntries[0]!);
        const rows = groupEntries.map(entry => {
            const selected = entry.name === snapshot.entry?.name;
            return `<li class="fmv-row${selected ? " selected" : ""}">
                <button type="button" data-fmv-name="${escapeMarkup(entry.name)}"
                    title="${escapeMarkup(entry.movie.path)}"
                    aria-current="${selected ? "true" : "false"}"
                    ${snapshot.exporting ? "disabled" : ""}>
                    <span class="fmv-row-main"><strong>${escapeMarkup(entry.label)}</strong>
                        <code>${escapeMarkup(entry.name)}</code></span>
                    <span class="fmv-row-meta"><span>${fmtSec(entry.duration)}</span>
                        <span>${escapeMarkup(movieScanLabel(entry, false))}</span></span>
                </button>
            </li>`;
        }).join("");
        return `<li class="fmv-group"><h3>${escapeMarkup(heading)}</h3></li>${rows}`;
    }).join("");
    const issueMarkup = visibleIssues.length
        ? `<li class="fmv-group"><h3>Unavailable on this disc</h3></li>`
            + visibleIssues.map(issue =>
                `<li class="fmv-list-message"><strong>${escapeMarkup(issue.label)}</strong>
                    <code>${escapeMarkup(issue.name)}</code><br>
                    ${escapeMarkup(issue.reason)}</li>`).join("")
        : "";
    list.innerHTML = availableMarkup + issueMarkup;
    list.querySelector<HTMLElement>('[aria-current="true"]')
        ?.scrollIntoView({ block: "nearest" });
}

function metadataSection(title: string, rows: readonly (readonly [string, string])[]): string {
    return `<section><h3>${escapeMarkup(title)}</h3><dl>${rows.map(([label, value]) =>
        `<div><dt>${escapeMarkup(label)}</dt><dd>${value}</dd></div>`).join("")}</dl></section>`;
}

function movieSidecarRows(label: string, entry: MovieEntry["subtitleBin"]): [string, string][] {
    if (!entry) return [
        [`${label} name`, "None"],
        [`${label} path`, "None"],
        [`${label} size`, "None"],
    ];
    return [
        [`${label} name`, `<code>${escapeMarkup(entry.name)}</code>`],
        [`${label} path`, `<code>${escapeMarkup(entry.path)}</code>`],
        [`${label} size`, movieBytesDetail(entry.size)],
    ];
}

function renderFmvInspector(snapshot: MovieControllerSnapshot): void {
    const inspector = $("fmv-inspector");
    const entry = snapshot.entry;
    if (!entry) {
        inspector.innerHTML = `<div class="fmv-empty">Select a movie to inspect its disc metadata.</div>`;
        return;
    }
    const cacheValue = (value: number | undefined): string =>
        value === undefined ? "—" : movieBytesDetail(value);
    let complete = "—";
    if (snapshot.cache)
        complete = movieSourceComplete(entry, snapshot.cache) ? "Yes" : "No";
    const order = entry.video.fieldOrder;
    const subtitles = entry.subtitleCues
        ? `${entry.subtitleCues} cues · final cue ${fmtSec(entry.subtitleEnd ?? 0)}`
        : "None on disc";
    inspector.innerHTML = [
        metadataSection("Asset", [
            ["Movie name", `<code>${escapeMarkup(entry.movie.name)}</code>`],
            ["Movie path", `<code>${escapeMarkup(entry.movie.path)}</code>`],
            ["VFI sector", `${entry.movie.sector} · ${movieHex(entry.movie.sector)}`],
            ["Byte offset", movieHex(entry.movie.sector * 0x800)],
            [".str size", movieBytesDetail(entry.movie.size)],
            ...movieSidecarRows(".bin", entry.subtitleBin),
            ...movieSidecarRows(".sbt", entry.subtitleSbt),
        ]),
        metadataSection("Container & picture", [
            ["Fields", String(entry.header.fields)],
            ["Groups", String(entry.header.groups)],
            ["Field rate", `${entry.header.fieldRate} Hz`],
            ["Duration", fmtSec(entry.duration)],
            ["Coded picture", `${entry.video.width} × ${entry.video.height}`],
            ["Video frame rate", `${entry.video.frameRate} fps`],
            ["Field order", `<code>${order}</code> · ${escapeMarkup(movieScanLabel(entry, true))}`],
            ["Sample aspect", entry.video.sampleAspect.join(":")],
            ["Display aspect", entry.video.displayAspect.join(":")],
        ]),
        metadataSection("Audio", [
            ["Channels", String(entry.header.channels)],
            ["Sample rate", `${entry.header.sampleRate} Hz`],
            ["Codec", "PS-ADPCM"],
            ["Interleave", movieBytesDetail(entry.header.interleave)],
            ["Audio block", movieBytesDetail(entry.header.audioBlock)],
            ["Preload", movieBytesDetail(entry.header.preload)],
            ["Compressed payload", movieBytesDetail(entry.header.audioBytes)],
        ]),
        metadataSection("Subtitles", [
            ["Disc cues", subtitles],
            ["Attached ISO", snapshot.hasIso ? "Yes" : "No"],
        ]),
        metadataSection("Local cache", [
            ["Source bytes", cacheValue(snapshot.cache?.sourceBytes)],
            ["Export bytes", cacheValue(snapshot.cache?.exportBytes)],
            ["Total bytes", cacheValue(snapshot.cache?.totalBytes)],
            ["Complete source", complete],
        ]),
    ].join("");
}


function renderFmvExport(snapshot: MovieControllerSnapshot): void {
    const entryChanged = fmvRenderedEntryName !== snapshot.entry?.name;
    fmvRenderedEntryName = snapshot.entry?.name ?? null;
    const captions = $<HTMLInputElement>("fmv-export-captions");
    captions.disabled = !snapshot.entry?.subtitleCues;
    if (entryChanged) captions.checked = (snapshot.entry?.subtitleCues ?? 0) > 0;
    const mp4Detail = document.querySelector<HTMLElement>(
        "[data-fmv-export='mp4'] span");
    if (mp4Detail) {
        mp4Detail.textContent = snapshot.entry?.video.fieldOrder === "progressive"
            ? "H.264 / AAC · browser encode"
            : "H.264 / AAC · 59.94p browser encode";
    }
    const remove = $<HTMLButtonElement>("fmv-remove-cache");
    remove.textContent = snapshot.cache?.totalBytes
        ? `REMOVE ${formatMovieBytes(snapshot.cache.totalBytes)} LOCAL CACHE`
        : "REMOVE LOCAL CACHE";
    $("fmv-source-label").textContent =
        snapshot.catalog ? "ATTACH SOURCE ISO" : "ATTACH ISO";
    $("fmv-source-select").hidden =
        snapshot.loading || snapshot.exporting || !snapshot.sourceRequired;
}

function renderFmvStatic(snapshot: MovieControllerSnapshot): void {
    fmvRenderedRevision = snapshot.revision;
    renderFmvList(snapshot);
    renderFmvInspector(snapshot);
    renderFmvExport(snapshot);
    const entry = snapshot.entry;
    $("fmv-title").textContent = entry?.label ?? "—";
    $("fmv-heading").textContent = entry
        ? `${entry.label.toLocaleUpperCase()} / ${entry.name}`
        : "FMV ASSETS";
    const picture = $("fmv-picture");
    const displayAspect = entry?.video.displayAspect ?? [16, 9];
    picture.style.aspectRatio = `${displayAspect[0]} / ${displayAspect[1]}`;
    picture.style.setProperty(
        "--fmv-aspect-value", String(displayAspect[0] / displayAspect[1]));
    $<HTMLCanvasElement>("fmv-canvas").setAttribute(
        "aria-label", entry?.label ?? "Selected movie picture");
    if (snapshot.prepared && snapshot.active
            && fmvAttachedRevision !== snapshot.revision) {
        movieController.attach($<HTMLCanvasElement>("fmv-canvas"));
        fmvAttachedRevision = snapshot.revision;
    } else if (!snapshot.prepared) {
        fmvAttachedRevision = -1;
    }
}

function moveFmv(delta: number, mode: "preview" | "play"): void {
    if (!fmvVisibleNames.length) return;
    const current = movieController.snapshot().entry?.name;
    const selected = fmvVisibleNames.indexOf(current ?? "");
    let origin = selected;
    if (selected < 0) origin = delta > 0 ? -1 : 0;
    const index = (origin + delta + fmvVisibleNames.length) % fmvVisibleNames.length;
    movieController.select(fmvVisibleNames[index]!, mode);
}

function toggleFmvFullscreen(): void {
    const playerElement = $("fmv-player");
    const entering = document.fullscreenElement === null;
    const operation = entering
        ? playerElement.requestFullscreen()
        : document.exitFullscreen();
    void operation.catch(error => {
        console.error("FMV fullscreen request failed", error);
        movieController.reportError(entering
            ? "Full screen was blocked. Allow full-screen access for this site."
            : "Could not leave full screen. Press Escape or use the browser command.");
    });
}

function exitFmvFullscreen(): boolean {
    if (document.fullscreenElement !== $("fmv-player")) return false;
    void document.exitFullscreen().catch(error => {
        console.error("FMV fullscreen exit failed", error);
        movieController.reportError(
            "Could not leave full screen. Press Escape or use the browser command.");
    });
    return true;
}

/* ---- image and sprite gallery ------------------------------------------ */
const IMAGE_TYPE_LABELS: Record<number, string> = {
    1: "RGBA16", 2: "RGB24", 3: "RGBA32", 4: "IDTEX4", 5: "IDTEX8",
};

function updateImageActions(): void {
    const disabled = imageSelected === null || imageExporting;
    $<HTMLButtonElement>("image-export-png").disabled = disabled;
    $<HTMLButtonElement>("image-export-tm2").disabled = disabled;
    $<HTMLButtonElement>("image-export-all").disabled =
        !imageCatalog?.textures.some(texture => texture.pictures.length > 0)
        || imageExporting;
}

const IMAGE_ROLE_LABELS: Record<ImageRoleFilter, string> = {
    all: "All assets",
    sprite: "UI / sprites",
    texture: "3D textures",
    other: "Other",
};
const IMAGE_EVIDENCE_LABELS: Record<string, string> = {
    "ui-reference": "Referenced by a UIS layout",
    "model-reference": "Referenced by an I3D model",
    "ui-global-reference": "Referenced by a UIS layout in another package",
    "model-global-reference": "Referenced by an I3D model in another package",
    "ui-package": "Packaged with UIS layouts",
    "model-package": "Packaged with I3D models",
    direct: "Direct TIM2 file",
    "ui-name-prefix": "Inferred from ui_ name; no format reference found",
    unclassified: "No UIS or I3D reference",
};
const IMAGE_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});
const IMAGE_THUMBNAIL_CACHE_LIMIT = 256;
const IMAGE_SKIPPED_ROW_LIMIT = 500;
const imageThumbnailCache = new Map<string, ImageData>();

function updateImageSortButton(): void {
    const button = $<HTMLButtonElement>("image-sort");
    const ascending = imageSortDirection === "asc";
    button.textContent = ascending ? "A–Z" : "Z–A";
    button.setAttribute("aria-label",
        `Images sorted by name ${ascending ? "A to Z" : "Z to A"}; `
        + `activate for ${ascending ? "Z to A" : "A to Z"}`);
    button.title =
        `Sorted by name ${ascending ? "A to Z" : "Z to A"}; click to reverse`;
}

interface ImageTreeNode {
    name: string;
    count: number;
    children: Map<string, ImageTreeNode>;
    entries: ImageEntry[];
}

function imageTitle(entry: ImageEntry): string {
    return entry.texture.fileName.replace(/\.tm2$/i, "")
        + (entry.texture.pictures.length > 1 ? ` · ${entry.pictureIndex + 1}` : "");
}

function createImageItem(entry: ImageEntry,
                         mode: ImageViewMode): HTMLLIElement {
    const item = document.createElement("li");
    item.className = `image-row image-${mode}-row`;
    item.classList.toggle("selected", entry.id === imageSelected?.id);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.imageId = entry.id;
    button.title = `${entry.texture.sourcePath} · ${entry.width}×${entry.height}`;

    const copy = document.createElement("span");
    copy.className = "image-row-copy";
    const title = document.createElement("strong");
    title.textContent = imageTitle(entry);
    const detail = document.createElement("small");
    if (mode === "grid") {
        detail.textContent =
            `${IMAGE_ROLE_LABELS[entry.texture.role]} · ${entry.width}×${entry.height}`;
    } else if (mode === "tree") {
        detail.textContent = `${entry.width}×${entry.height}`;
    } else {
        detail.textContent = entry.texture.sourcePath;
    }
    copy.append(title, detail);

    if (mode === "grid") {
        const canvas = document.createElement("canvas");
        canvas.className = "image-thumbnail";
        canvas.dataset.imageThumbnail = entry.id;
        canvas.width = 1;
        canvas.height = 1;
        canvas.setAttribute("aria-hidden", "true");
        button.append(canvas, copy);
    } else {
        const meta = document.createElement("span");
        meta.className = "image-row-meta";
        const role = document.createElement("span");
        role.className = `image-role image-role-${entry.texture.role}`;
        role.textContent = IMAGE_ROLE_LABELS[entry.texture.role];
        const size = document.createElement("span");
        size.className = "image-size";
        size.textContent = `${entry.width}×${entry.height}`;
        meta.append(role, size);
        button.append(copy, meta);
    }
    item.append(button);
    return item;
}

function cacheImageThumbnail(id: string, image: ImageData): void {
    if (imageThumbnailCache.has(id)) imageThumbnailCache.delete(id);
    imageThumbnailCache.set(id, image);
    if (imageThumbnailCache.size <= IMAGE_THUMBNAIL_CACHE_LIMIT) return;
    const oldest = imageThumbnailCache.keys().next().value as string | undefined;
    if (oldest !== undefined) imageThumbnailCache.delete(oldest);
}

async function renderImageThumbnail(canvas: HTMLCanvasElement,
                                    entry: ImageEntry,
                                    generation: number): Promise<void> {
    const cached = imageThumbnailCache.get(entry.id);
    if (cached) {
        imageThumbnailCache.delete(entry.id);
        imageThumbnailCache.set(entry.id, cached);
        canvas.width = cached.width;
        canvas.height = cached.height;
        canvas.getContext("2d")?.putImageData(cached, 0, 0);
        canvas.classList.add("ready");
        return;
    }
    const source = await session?.images.read(entry.texture);
    if (!source) throw new Error(`${entry.texture.fileName}: source texture is unavailable`);
    const decoded = decodeTim2(source, entry.pictureIndex);
    if (generation !== imageRenderGeneration || !canvas.isConnected) return;

    const scale = Math.min(112 / decoded.width, 84 / decoded.height, 1);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = decoded.width;
    sourceCanvas.height = decoded.height;
    const sourceContext = sourceCanvas.getContext("2d");
    const context = canvas.getContext("2d");
    if (!sourceContext || !context) throw new Error("2D canvas is unavailable");
    sourceContext.putImageData(new ImageData(
        new Uint8ClampedArray(decoded.rgba),
        decoded.width,
        decoded.height,
    ), 0, 0);
    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingEnabled = false;
    context.drawImage(sourceCanvas, 0, 0, width, height);
    const thumbnail = context.getImageData(0, 0, width, height);
    cacheImageThumbnail(entry.id, thumbnail);
    canvas.classList.add("ready");
}

function pumpImageThumbnailQueue(): void {
    while (imageThumbnailActive < 4 && imageThumbnailQueue.length > 0) {
        const job = imageThumbnailQueue.shift()!;
        if (job.generation !== imageRenderGeneration || !job.canvas.isConnected) continue;
        imageThumbnailActive++;
        void renderImageThumbnail(job.canvas, job.entry, job.generation)
            .catch(error => {
                job.canvas.classList.add("failed");
                job.canvas.title = friendlyError(error);
                console.warn("image thumbnail failed", error);
            })
            .finally(() => {
                imageThumbnailActive--;
                pumpImageThumbnailQueue();
            });
    }
}

function observeImageThumbnails(list: HTMLElement, generation: number): void {
    imageThumbnailObserver?.disconnect();
    imageThumbnailObserver = new IntersectionObserver(records => {
        for (const record of records) {
            if (!record.isIntersecting) continue;
            const canvas = record.target as HTMLCanvasElement;
            imageThumbnailObserver?.unobserve(canvas);
            const entry = imageEntryById.get(canvas.dataset.imageThumbnail ?? "");
            if (entry) imageThumbnailQueue.push({ canvas, entry, generation });
        }
        pumpImageThumbnailQueue();
    }, { root: list, rootMargin: "240px 0px" });
    for (const canvas of list.querySelectorAll<HTMLCanvasElement>("[data-image-thumbnail]"))
        imageThumbnailObserver.observe(canvas);
}

function buildImageTree(entries: ImageEntry[]): ImageTreeNode {
    const root: ImageTreeNode = {
        name: "",
        count: 0,
        children: new Map(),
        entries: [],
    };
    for (const entry of entries) {
        const segments = imageTreePath(entry).split("/").filter(Boolean);
        let node = root;
        node.count++;
        for (const segment of segments.slice(0, -1)) {
            let child = node.children.get(segment);
            if (!child) {
                child = { name: segment, count: 0, children: new Map(), entries: [] };
                node.children.set(segment, child);
            }
            child.count++;
            node = child;
        }
        node.entries.push(entry);
    }
    return root;
}

function populateImageTree(parent: HTMLElement, node: ImageTreeNode): void {
    const order = imageSortDirection === "asc" ? 1 : -1;
    const children = [...node.children.values()]
        .sort((left, right) => order * IMAGE_COLLATOR.compare(left.name, right.name));
    for (const child of children) {
        const item = document.createElement("li");
        item.className = "image-tree-folder";
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        const name = document.createElement("span");
        name.textContent = child.name;
        const count = document.createElement("small");
        count.textContent = child.count.toLocaleString();
        summary.append(name, count);
        const nested = document.createElement("ul");
        nested.className = "image-tree-children";
        details.append(summary, nested);
        details.addEventListener("toggle", () => {
            if (!details.open || details.dataset.loaded) return;
            details.dataset.loaded = "true";
            populateImageTree(nested, child);
        });
        item.append(details);
        parent.append(item);
    }
    for (const entry of sortImageEntries(node.entries, imageSortDirection))
        parent.append(createImageItem(entry, "tree"));
}

function observeImageListEnd(list: HTMLElement, generation: number): void {
    imageListObserver?.disconnect();
    const sentinel = list.querySelector("[data-image-sentinel]");
    if (!sentinel) return;
    imageListObserver = new IntersectionObserver(records => {
        if (generation !== imageRenderGeneration
            || !records.some(record => record.isIntersecting)) return;
        imageVisibleLimit += imageViewMode === "grid" ? 120 : 300;
        renderImageList();
    }, { root: list, rootMargin: "320px 0px" });
    imageListObserver.observe(sentinel);
}

function renderImageList(): void {
    const list = $("imagelist");
    imageRenderGeneration++;
    const generation = imageRenderGeneration;
    imageListObserver?.disconnect();
    imageThumbnailObserver?.disconnect();
    imageThumbnailQueue = [];
    if (!imageCatalog) {
        imageAllRows = [];
        imageRows = [];
        imageEntryById.clear();
        list.replaceChildren();
        $("image-result-count").textContent = "";
        updateImageActions();
        return;
    }

    const query = $<HTMLInputElement>("image-search").value;
    const role = $<HTMLSelectElement>("image-role").value as ImageRoleFilter;
    imageRows = sortImageEntries(
        filterImageEntries(imageAllRows, query, role),
        imageSortDirection,
    );
    list.className = `image-${imageViewMode}`;
    const previousScroll = list.scrollTop;
    list.replaceChildren();

    if (!imageRows.length) {
        const item = document.createElement("li");
        item.className = "fmv-list-message";
        item.textContent = query || role !== "all"
            ? "No images match these filters."
            : "No TIM2 images found.";
        list.append(item);
    } else if (imageViewMode === "tree") {
        populateImageTree(list, buildImageTree(imageRows));
    } else {
        const visible = imageRows.slice(0, imageVisibleLimit);
        list.append(...visible.map(entry => createImageItem(entry, imageViewMode)));
        if (visible.length < imageRows.length) {
            const sentinel = document.createElement("li");
            sentinel.className = "image-list-sentinel";
            sentinel.dataset.imageSentinel = "true";
            sentinel.textContent =
                `${(imageRows.length - visible.length).toLocaleString()} more`;
            list.append(sentinel);
        }
        observeImageListEnd(list, generation);
        if (imageViewMode === "grid") observeImageThumbnails(list, generation);
    }
    list.scrollTop = previousScroll;
    const shown = imageViewMode === "tree"
        ? imageRows.length
        : Math.min(imageRows.length, imageVisibleLimit);
    $("image-result-count").textContent = imageViewMode === "tree"
        ? `${imageRows.length.toLocaleString()} assets · source hierarchy`
        : `${shown.toLocaleString()} of ${imageRows.length.toLocaleString()} assets`;
    updateImageActions();
}

function markImageSelection(id: string): void {
    for (const item of $("imagelist").querySelectorAll(".image-row.selected"))
        item.classList.remove("selected");
    const button = $("imagelist").querySelector<HTMLButtonElement>(
        `[data-image-id="${CSS.escape(id)}"]`,
    );
    button?.closest(".image-row")?.classList.add("selected");
}

function renderImageInspector(entry: ImageEntry): void {
    const inspector = $("image-inspector");
    const dl = document.createElement("dl");
    const fields: Array<[string, string]> = [
        ["Name", entry.texture.fileName],
        ["Picture", `${entry.pictureIndex + 1} of ${entry.texture.pictures.length}`],
        ["Dimensions", `${entry.width} × ${entry.height}`],
        ["Pixel format", IMAGE_TYPE_LABELS[entry.imageType] ?? `type ${entry.imageType}`],
        ["Usage", IMAGE_ROLE_LABELS[entry.texture.role]],
        ["Classification",
         IMAGE_EVIDENCE_LABELS[entry.texture.roleEvidence] ?? entry.texture.roleEvidence],
        ["Source bytes", entry.texture.byteLength.toLocaleString()],
        ["Package", entry.texture.sourcePath],
        ["Member", entry.texture.memberName ?? "direct VFI file"],
        ["Attributes", entry.texture.attrs || "—"],
    ];
    for (const [term, value] of fields) {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = term;
        dd.textContent = value;
        row.append(dt, dd);
        dl.append(row);
    }
    inspector.replaceChildren(dl);
}

async function selectImage(entry: ImageEntry): Promise<void> {
    const target = session;
    if (!target) return;
    imageSelected = entry;
    markImageSelection(entry.id);
    const generation = ++imageLoadGeneration;
    status(`DECODING ${entry.texture.fileName}...`);
    try {
        const data = await target.images.read(entry.texture);
        if (!data) throw new Error("source texture is not cached; reconnect the disc");
        const image = decodeTim2(data, entry.pictureIndex, entry.texture.fileName);
        if (session !== target || generation !== imageLoadGeneration
                || imageSelected?.id !== entry.id)
            return;
        const canvas = $<HTMLCanvasElement>("image-canvas");
        canvas.classList.toggle("small-image",
            image.width <= 256 && image.height <= 256);
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas is unavailable");
        context.putImageData(
            new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
            0,
            0,
        );
        $("image-empty").hidden = true;
        renderImageInspector(entry);
        statusWithWarnings(
            target,
            "images",
            `${entry.texture.fileName} · ${image.width}×${image.height} · `
                + `${IMAGE_TYPE_LABELS[image.imageType] ?? `type ${image.imageType}`}`,
        );
    } catch (error) {
        if (session !== target || generation !== imageLoadGeneration) return;
        status(`IMAGE FAILED: ${friendlyError(error)}`, true);
    }
}

function updateImageRoleOptions(): void {
    if (!imageCatalog) return;
    const counts: Record<ImageRoleFilter, number> = {
        all: 0,
        sprite: 0,
        texture: 0,
        other: 0,
    };
    for (const texture of imageCatalog.textures) {
        const pictures = texture.pictures.length;
        counts.all += pictures;
        counts[texture.role] += pictures;
    }
    for (const option of $<HTMLSelectElement>("image-role").options) {
        const role = option.value as ImageRoleFilter;
        option.textContent =
            `${IMAGE_ROLE_LABELS[role].toUpperCase()} · ${counts[role].toLocaleString()}`;
    }
}

function renderSkippedImageMembers(catalog: ImageCatalog | null): void {
    const details = $<HTMLDetailsElement>("image-skipped");
    const list = $<HTMLOListElement>("image-skipped-list");
    const skipped = catalog?.skipped ?? [];
    if (skipped.length === 0) {
        details.hidden = true;
        details.open = false;
        $("image-skipped-title").textContent = "";
        list.replaceChildren();
        return;
    }

    const count = skipped.length.toLocaleString();
    $("image-skipped-title").textContent =
        `${count} declared image ${skipped.length === 1 ? "entry" : "entries"} skipped`;
    const items = skipped.slice(0, IMAGE_SKIPPED_ROW_LIMIT).map(entry => {
        const item = document.createElement("li");
        const name = document.createElement("code");
        name.textContent = entry.fileName;
        const metadata = document.createElement("span");
        metadata.textContent = `${entry.sourcePath} · member #${entry.memberIndex} · `
            + `${entry.byteLength.toLocaleString()} bytes`;
        item.append(name, metadata);
        return item;
    });
    const remaining = skipped.length - items.length;
    if (remaining > 0) {
        const item = document.createElement("li");
        item.className = "image-skipped-remainder";
        item.textContent = `${remaining.toLocaleString()} more entries not shown`;
        items.push(item);
    }
    list.replaceChildren(...items);
    details.hidden = false;
}

function installImageCatalog(catalog: ImageCatalog): void {
    imageCatalog = catalog;
    imageAllRows = imageEntries(catalog);
    imageEntryById = new Map();
    for (const entry of imageAllRows) imageEntryById.set(entry.id, entry);
    updateImageRoleOptions();
    renderSkippedImageMembers(catalog);
}

function ensureImageCatalog(): Promise<void> {
    const target = session;
    if (!target || imageCatalog) return Promise.resolve();
    if (imageCatalogRequest?.target === target)
        return imageCatalogRequest.promise;
    const promise = loadImageCatalog(target);
    imageCatalogRequest = { target, promise };
    const clear = (): void => {
        if (imageCatalogRequest?.promise === promise)
            imageCatalogRequest = null;
    };
    void promise.then(clear, clear);
    return promise;
}

async function loadImageCatalog(target: DiscSession): Promise<void> {
    const cached = await target.images.cached();
    if (session !== target) return;
    if (cached) {
        installImageCatalog(cached);
        $("image-setup").hidden = true;
        renderImageList();
        if (tab === "images")
            statusWithWarnings(target, "images",
                `${imageAllRows.length} images and sprite sheets`);
        return;
    }
    $("image-setup").hidden = false;
    const hasIso = target.images.hasIso();
    $("image-extract").hidden = true;
    $("image-iso-pick").hidden = hasIso;
    if (hasIso) await extractImages();
}

async function extractImages(): Promise<void> {
    const target = session;
    if (!target || imageExtracting) return;
    const setupStatus = $("image-setup-status");
    const progress = $<HTMLProgressElement>("image-progress");
    const button = $<HTMLButtonElement>("image-extract");
    setupStatus.classList.remove("err");
    progress.hidden = false;
    progress.value = 0;
    button.disabled = true;
    button.hidden = true;
    imageExtracting = true;
    try {
        const catalog = await target.images.extract((done, total, path) => {
            if (session !== target) return;
            progress.value = total > 0 ? done / total : 0;
            setupStatus.textContent = path === "done"
                ? "catalog complete"
                : `scanning ${path} (${done}/${total})`;
        });
        if (session !== target) return;
        installImageCatalog(catalog);
        $("image-setup").hidden = true;
        renderImageList();
        if (tab === "images")
            statusWithWarnings(target, "images",
                `${imageAllRows.length} images and sprite sheets · select one to preview`);
    } catch (error) {
        if (session !== target) return;
        setupStatus.textContent = friendlyError(error);
        setupStatus.classList.add("err");
        progress.hidden = true;
        button.hidden = false;
    } finally {
        if (session === target) {
            button.disabled = false;
            imageExtracting = false;
        }
    }
}

async function exportSelectedImage(kind: "png" | "tm2"): Promise<void> {
    const target = session;
    if (!target || !imageSelected || imageExporting) return;
    const entry = imageSelected;
    imageExporting = true;
    updateImageActions();
    try {
        const source = await target.images.read(entry.texture);
        if (session !== target) return;
        if (!source) throw new Error("source texture is not cached; reconnect the disc");
        const path = imageExportPath(entry, kind);
        const data = kind === "png"
            ? await imagePng(source, entry.pictureIndex) : source;
        if (session !== target) return;
        download(data, path.slice(path.lastIndexOf("/") + 1),
                 kind === "png" ? "image/png" : "application/octet-stream");
        statusWithWarnings(target, "images", `EXPORTED ${path}`);
    } catch (error) {
        if (session === target)
            status(`EXPORT FAILED: ${friendlyError(error)}`, true);
    } finally {
        if (session === target) {
            imageExporting = false;
            updateImageActions();
        }
    }
}

async function exportAllImages(): Promise<void> {
    const target = session;
    if (!target || !imageCatalog || imageExporting) return;
    const entries = imageAllRows;
    imageExporting = true;
    updateImageActions();
    try {
        const files: [string, Uint8Array][] = [];
        let textureId = "";
        let source: Uint8Array | null = null;
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index]!;
            if (entry.texture.id !== textureId) {
                textureId = entry.texture.id;
                source = await target.images.read(entry.texture);
                if (session !== target) return;
            }
            if (!source) throw new Error(`${entry.texture.fileName} is not cached`);
            status(`ENCODING PNG ${index + 1}/${entries.length} · ${entry.texture.fileName}`);
            const png = await imagePng(source, entry.pictureIndex);
            if (session !== target) return;
            files.push([imageExportPath(entry, "png"), png]);
        }
        if (session !== target) return;
        download(storeZipBlob(files), "ape-escape-3-images.zip", "application/zip");
        statusWithWarnings(target, "images",
            `EXPORTED ape-escape-3-images.zip · ${files.length} PNG files`);
    } catch (error) {
        if (session === target)
            status(`EXPORT FAILED: ${friendlyError(error)}`, true);
    } finally {
        if (session === target) {
            imageExporting = false;
            updateImageActions();
        }
    }
}

function imageCatalogIssueWarning(catalog: ImageCatalog | null): string {
    if (!catalog?.issues.length) return "";
    const shown = catalog.issues.slice(0, 2)
        .map(issue => `${issue.format}: ${issue.reason}`);
    const remainder = catalog.issues.length - shown.length;
    return `${catalog.issues.length.toLocaleString()} malformed image `
        + `container${catalog.issues.length === 1 ? "" : "s"} skipped`
        + ` (${shown.join("; ")}${remainder > 0 ? `; +${remainder} more` : ""})`;
}

function imageCatalogSkippedWarning(catalog: ImageCatalog | null): string {
    const count = catalog?.skipped.length ?? 0;
    if (count === 0) return "";
    return `${count.toLocaleString()} declared image `
        + `entr${count === 1 ? "y was" : "ies were"} skipped because `
        + `the payload had no TIM2 signature; open the skipped list for details`;
}

function persistenceWarnings(target: DiscSession, targetTab: AppTab): string {
    const warnings: string[] = [];
    const support = discSupportWarning(target.serial).replace(/^ - /, "");
    if (support) warnings.push(support);
    if (targetTab === "bgm" && bgmDurationWarning)
        warnings.push(bgmDurationWarning);
    if (targetTab === "streams" && target.streams.persistenceWarning)
        warnings.push(target.streams.persistenceWarning);
    if (targetTab === "images" && target.images.persistenceWarning)
        warnings.push(target.images.persistenceWarning);
    if (targetTab === "images") {
        const issueWarning = imageCatalogIssueWarning(imageCatalog);
        if (issueWarning) warnings.push(issueWarning);
        const skippedWarning = imageCatalogSkippedWarning(imageCatalog);
        if (skippedWarning) warnings.push(skippedWarning);
    }
    if (targetTab === "se" && target.se.persistenceWarning)
        warnings.push(target.se.persistenceWarning);
    if (targetTab === "fmv" && target.movies.persistenceWarning)
        warnings.push(target.movies.persistenceWarning);
    if (target.persistenceWarning)
        warnings.push(target.persistenceWarning);
    return warnings.join(" · ");
}

function statusWithWarnings(target: DiscSession | null, targetTab: AppTab,
                            message = "", messageIsError = false): void {
    if (!target || session !== target || tab !== targetTab) return;
    const warning = persistenceWarnings(target, targetTab);
    status([message, warning].filter(Boolean).join(" · "),
        messageIsError || warning.length > 0);
}

function showLazyCatalogError(origin: AppTab, target: DiscSession | null,
                              statusId: string, error: unknown): void {
    if (session !== target) return;
    const message = friendlyError(error);
    const setupStatus = $(statusId);
    setupStatus.textContent = message;
    setupStatus.classList.add("err");
    if (tab === origin) status(message, true);
}

function switchTab(t: AppTab): void {
    if (t !== "se") seSourceLoopViz?.clear();
    tab = t;
    const target = session;
    $("tab-bgm").classList.toggle("on", t === "bgm");
    $("tab-streams").classList.toggle("on", t === "streams");
    $("tab-se").classList.toggle("on", t === "se");
    $("tab-fmv").classList.toggle("on", t === "fmv");
    $("tab-images").classList.toggle("on", t === "images");
    $("tab-stage-previews").classList.toggle("on", t === "stage-previews");
    $("tab-models").classList.toggle("on", t === "models");
    $("songlist").hidden = t !== "bgm";
    $("streamview").hidden = t !== "streams";
    $("seview").hidden = t !== "se";
    $("fmvview").hidden = t !== "fmv";
    $("imageview").hidden = t !== "images";
    $("stage-preview-view").hidden = t !== "stage-previews";
    $("modelview").hidden = t !== "models";
    $("head").hidden = t !== "bgm";
    $("bar").hidden = t !== "bgm";
    $("stage").hidden = t !== "bgm";
    $("foot-stats").hidden = t === "streams" || t === "fmv" || t === "images"
        || t === "stage-previews" || t === "models";
    $("stream-main").hidden = t !== "streams";
    $("se-main").hidden = t !== "se";
    $("fmv-main").hidden = t !== "fmv";
    $("image-main").hidden = t !== "images";
    $("stage-preview-main").hidden = t !== "stage-previews";
    $("model-main").hidden = t !== "models";
    $("keys").textContent = t === "bgm"
        ? keysBgmText
        : t === "streams"
            ? KEYS_STREAMS
            : t === "se"
                ? KEYS_SE
                : t === "fmv"
                    ? KEYS_FMV
                    : t === "images"
                        ? KEYS_IMAGES
                        : t === "stage-previews"
                            ? KEYS_STAGE_PREVIEWS
                            : KEYS_MODELS;
    statusWithWarnings(target, t);
    viewerRevision++;
    movieController.setActive(t === "fmv" || viewerChannel === "cinema");
    if (t === "streams")
        void ensureStreams().catch(error =>
            showLazyCatalogError(t, target, "s-setup-status", error));
    if (t === "se")
        void ensureSeCatalog().catch(error =>
            showLazyCatalogError(t, target, "se-setup-status", error));
    if (t === "fmv") renderFmvStatic(movieController.snapshot());
    if (t === "images")
        void ensureImageCatalog().catch(error =>
            showLazyCatalogError(t, target, "image-setup-status", error));
    if (t === "stage-previews") ensureStagePreviewBrowser().open();
    else stagePreviewBrowser?.close();
    if (t === "models") {
        void ensureModelBrowser().then(browser => {
            if (session === target && tab === t) return browser.open();
        }).catch(error =>
            showLazyCatalogError(t, target, "model-setup-status", error));
    } else {
        modelBrowser?.close();
    }
}

/* First entry to the tab: catalog from OPFS, or the setup panel. */
function ensureStreams(): Promise<void> {
    const target = session;
    if (!target || sCatalog) return Promise.resolve();
    if (streamCatalogRequest?.target === target)
        return streamCatalogRequest.promise;
    const promise = loadStreamCatalog(target);
    streamCatalogRequest = { target, promise };
    const clear = (): void => {
        if (streamCatalogRequest?.promise === promise)
            streamCatalogRequest = null;
    };
    void promise.then(clear, clear);
    return promise;
}

async function loadStreamCatalog(target: DiscSession): Promise<void> {
    const catalog = await target.streams.cached();
    if (session !== target) return;
    if (catalog) {
        sCatalog = catalog;
        $("s-setup").hidden = true;
        $("s-stage").hidden = false;
        renderStreamList();
        if (tab === "streams")
            statusWithWarnings(target, "streams",
                `${catalog.entries.length} streams - SPACE or click one to play`);
        return;
    }
    $("s-setup").hidden = false;
    const hasIso = target.streams.hasIso();
    $("s-extract").hidden = true;
    $("s-iso-pick").hidden = hasIso;
    if (hasIso) await extractStreams();
}

async function extractStreams(): Promise<void> {
    const target = session;
    if (!target || sExtracting) return;
    const pstat = $("s-setup-status");
    const bar = $<HTMLProgressElement>("s-progress");
    const button = $<HTMLButtonElement>("s-extract");
    pstat.classList.remove("err");
    bar.hidden = false;
    bar.value = 0;
    button.disabled = true;
    button.hidden = true;
    sExtracting = true;
    try {
        const catalog = await target.streams.extract((done, total, name) => {
            if (session !== target) return;
            bar.value = total > 0 ? done / total : 0;
            pstat.textContent = `extracting ${name} (${done}/${total})`;
        });
        if (session !== target) return;
        sCatalog = catalog;
        $("s-setup").hidden = true;
        $("s-stage").hidden = false;
        renderStreamList();
        if (tab === "streams")
            statusWithWarnings(target, "streams",
                `${catalog.entries.length} streams - SPACE or click one to play`);
    } catch (error) {
        if (session !== target) return;
        pstat.textContent = friendlyError(error);
        pstat.classList.add("err");
        bar.hidden = true;
        button.hidden = false;
    } finally {
        if (session === target) {
            button.disabled = false;
            sExtracting = false;
        }
    }
}

/* Sidebar fold tree: MUSIC/VOICE sections -> prefix groups -> entries
 * (taxonomy derived in code from the user's own catalog -- channels==2 ->
 * MUSIC, else VOICE). Groups start folded so the categories scan in one
 * screen; a search shows every match expanded, folds ignored. */
function sToggleFold(id: string): void {
    if (sFolded.has(id)) sFolded.delete(id);
    else sFolded.add(id);
    renderStreamList();
}

function renderStreamList(): void {
    const ul = $("streamlist");
    if (!sCatalog) {
        ul.replaceChildren();
        viewerRevision++;
        return;
    }
    const q = $<HTMLInputElement>("stream-search").value.toLowerCase();
    const match = (e: StreamEntry): boolean =>
        !q || e.name.toLowerCase().includes(q);
    const { music, voice } = groupStreams(sCatalog.entries);
    if (!sFoldInit) {                   /* first render: categories folded */
        sFoldInit = true;
        for (const [sec, gs] of [["MUSIC", music], ["VOICE", voice]] as const)
            for (const g of gs) sFolded.add(`${sec}/${g.key}`);
    }
    sRows = [];
    const rows: HTMLLIElement[] = [];
    const push = (row: SRow, li: HTMLLIElement): void => {
        const i = sRows.length;
        sRows.push(row);
        li.classList.toggle("sel", i === sSel);
        rows.push(li);
    };
    for (const [sec, groups] of [["MUSIC", music], ["VOICE", voice]] as const) {
        const total = groups.reduce((n, g) => n + g.entries.filter(match).length, 0);
        if (q && !total) continue;
        const secOpen = q ? true : !sFolded.has(sec);
        const sli = document.createElement("li");
        sli.className = "sec";
        sli.textContent = `${secOpen ? "▾" : "▸"} ${sec} (${total})`;
        const si = sRows.length;
        sli.onclick = () => { sSel = si; sToggleFold(sec); };
        push({ kind: "section", id: sec, label: sec }, sli);
        if (!secOpen) continue;
        for (const g of groups) {
            const hits = g.entries.filter(match);
            if (!hits.length) continue;
            const gid = `${sec}/${g.key}`;
            const gOpen = q ? true : !sFolded.has(gid);
            const gli = document.createElement("li");
            gli.className = "hdr";
            const gn = document.createElement("span");
            gn.textContent = `${gOpen ? "▾" : "▸"} ${g.key} (${hits.length})`;
            const gd = document.createElement("span");
            gd.className = "dur";
            gd.textContent = fmtSec(hits.reduce((t, e) => t + sDur(e), 0));
            gli.append(gn, gd);
            const gi = sRows.length;
            gli.onclick = () => { sSel = gi; sToggleFold(gid); };
            push({ kind: "group", id: gid, label: g.key }, gli);
            if (!gOpen) continue;
            for (const e of hits) {
                const li = document.createElement("li");
                li.className = "entry";
                const nm = document.createElement("span");
                nm.textContent = e.name.replace(/\.x$/, "");
                const dur = document.createElement("span");
                dur.className = "dur";
                dur.textContent = fmtSec(sDur(e));
                li.append(nm, dur);
                li.classList.toggle("playing", e.name === sPlayingName);
                const i = sRows.length;
                li.onclick = () => { sSel = i; void loadStream(i, true); };
                push({ kind: "entry", entry: e }, li);
            }
        }
    }
    if (sSel >= sRows.length) sSel = Math.max(0, sRows.length - 1);
    ul.replaceChildren(...rows);
    viewerRevision++;
}

function scrollStreamSelIntoView(): void {
    if (!sRows[sSel]) return;
    for (const li of $("streamlist").children)
        if (li.classList.contains("sel"))
            return li.scrollIntoView({ block: "nearest" });
}

function renderStreamInfo(): void {
    const el = $("s-info");
    const d = sPlayer.decoded();
    if (!d) { el.replaceChildren(); return; }
    const h = d.header;
    const full = d.samplesPerChannel / h.rate;
    const padS = d.padFrames * 28 / h.rate;
    let text = `${h.channels}ch ${h.rate} Hz · ${d.sectors} sectors · `
        + `${full.toFixed(1)} s · trailing pad ${d.padFrames} frames`
        + ` (${padS.toFixed(1)} s)`;
    if (h.loop)
        text += ` · LOOP from sector ${h.loop_start}`;
    el.replaceChildren(document.createTextNode(text));
    if (h.length !== d.sectors) {
        const warn = document.createElement("div");
        warn.className = "warn";
        warn.textContent = `header claims ${h.length} sectors, file has `
            + `${d.sectors} -- a shipped authoring bug (16 such files); `
            + `decoding what is actually there`;
        el.append(warn);
    }
}

async function loadStreamEntry(e: StreamEntry, autoplay: boolean): Promise<void> {
    const target = session;
    if (!target || sLoading) return;
    sLoading = true;
    status(`loading ${e.name}...`);
    try {
        const bytes = await target.streams.read(e.name);
        if (session !== target) return;
        if (!bytes)
            throw new Error(`missing stream ${e.name} -- re-extract, or `
                            + "re-open the ISO");
        const decoded = await sDecoder.decode(e.name, bytes);
        if (session !== target) return;
        sPlayer.load(decoded, sTrim);
        sPlayingName = e.name;
        sViz?.set(decoded, sTrim);
        $("s-name").textContent = e.name.replace(/\.x$/, "");
        $("s-len").textContent = fmtSec(sPlayer.dur());
        renderStreamInfo();
        updateSBarPad();
        $<HTMLButtonElement>("s-playbtn").disabled = false;
        $<HTMLButtonElement>("s-exportbtn").disabled = false;
        $<HTMLButtonElement>("s-rawbtn").disabled = false;
        statusWithWarnings(target, "streams");
        if (autoplay) {
            player?.pause();            /* one thing plays at a time */
            sPlayer.play();
        }
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    } finally {
        if (session === target) {
            sLoading = false;
            renderStreamList();
        }
    }
}

async function loadStream(i: number, autoplay: boolean): Promise<void> {
    const row = sRows[i];
    if (!row || row.kind !== "entry") return;
    await loadStreamEntry(row.entry, autoplay);
}

function sTogglePlay(): void {
    if (!sPlayer.decoded()) {           /* first gesture: load the selection
                                         * (or the first entry below it) */
        let i = sSel;
        while (i < sRows.length && sRows[i]!.kind !== "entry") i++;
        if (i < sRows.length) { sSel = i; void loadStream(i, true); }
    } else if (sPlayer.playing()) {
        sPlayer.pause();
    } else {
        player?.pause();
        sPlayer.play();
    }
}

/* Seek-bar pad shading: with trim OFF the authored silent tail is part of
 * the timeline, so its span is marked like the BGM bar's loop region. */
function updateSBarPad(): void {
    const el = $("s-bar-pad");
    const d = sPlayer.decoded();
    const padFrac = d && !sTrim && d.samplesPerChannel > 0
        ? d.padFrames * 28 / d.samplesPerChannel : 0;
    el.style.display = padFrac > 0 ? "block" : "none";
    if (padFrac > 0) {
        el.style.left = `${((1 - padFrac) * 100).toFixed(3)}%`;
        el.style.width = `${(padFrac * 100).toFixed(3)}%`;
    }
}

function sToggleTrim(): void {
    sTrim = !sTrim;
    const d = $("s-trim");
    d.classList.toggle("on", sTrim);
    sPlayer.setTrim(sTrim);
    sViz?.set(sPlayer.decoded(), sTrim);
    updateSBarPad();
    $("s-len").textContent = fmtSec(sPlayer.dur());
}

/* Raw .x export -- the EXST container exactly as it sits on the disc, for
 * anyone who wants the file format itself (the MIDI/bank-pair precedent:
 * straight bytes, no worker, no busy state). */
async function sExportRaw(): Promise<void> {
    const target = session;
    if (!target) return;
    const decoded = sPlayer.decoded();
    if (!decoded) return;
    try {
        const bytes = await target.streams.read(decoded.name);
        if (session !== target) return;
        if (!bytes)
            throw new Error(`missing stream ${decoded.name} -- re-extract, or `
                            + "re-open the ISO");
        download(bytes, decoded.name, "application/octet-stream");
        status(`EXPORTED ${decoded.name}`);
    } catch (error) {
        if (session === target)
            status(`EXPORT FAILED: ${friendlyError(error)}`, true);
    }
}

async function sExport(): Promise<void> {
    const target = session;
    if (!target || sBusy) return;
    const decoded = sPlayer.decoded();
    if (!decoded) return;
    const trim = sTrim;
    sBusy = true;
    const stemName = decoded.name.replace(/\.x$/, "");
    const file = `${stemName}${trim ? "_trim" : ""}.wav`;
    const btn = $<HTMLButtonElement>("s-exportbtn");
    btn.disabled = true;
    btn.textContent = "EXPORTING";
    status(`EXPORTING ${file}...`);
    try {
        const bytes = await target.streams.read(decoded.name);
        if (session !== target) return;
        if (!bytes)
            throw new Error(`missing stream ${decoded.name}`);
        const wav = await sDecoder.wav(decoded.name, bytes, trim);
        if (session !== target) return;
        download(wav, file, "audio/wav");
        status(`EXPORTED ${file}`);
    } catch (error) {
        if (session === target)
            status(`EXPORT FAILED: ${friendlyError(error)}`, true);
    } finally {
        if (session === target) {
            sBusy = false;
            btn.disabled = !sPlayer.decoded();
            btn.textContent = "EXPORT WAV";
        }
    }
}

/* ---- embedded SE tab --------------------------------------------------- */
function seSetup(show: boolean, needsIso = false): void {
    $("se-setup").hidden = !show;
    $("se-stage").hidden = show;
    $("se-extract").hidden = true;
    $("se-iso-pick").hidden = !needsIso;
}

function currentSeInfo(
    row: Extract<SeRow, { kind: "cue" }> | null = sePlaying,
): SeRequestInfo | null {
    if (!row) return null;
    if (sePlaying && row.entry.name === sePlaying.entry.name &&
        row.bank === sePlaying.bank && row.request === sePlaying.request)
        return sePlayingInfo;
    if (row.entry.name !== seOpenBank) return null;
    return seDetails?.[row.bank]?.[row.request] ?? null;
}

function seEventFrames(info: SeRequestInfo): number {
    return seCfg.exact ? info.exactFrames : info.consoleFrames;
}

function seSourceEndFrames(info: SeRequestInfo): number {
    return seCfg.exact
        ? info.sourceEndExactFrame
        : info.sourceEndConsoleFrame;
}

function fmtSeTime(frames: number): string {
    const seconds = Math.max(0, frames) / RATE;
    if (seconds < 3600) return fmtTime(frames);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const rest = seconds % 60;
    return `${hours}:${minutes.toString().padStart(2, "0")}:`
        + `${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

function seLoopFrames(info: SeRequestInfo): {
    start: number; end: number; cycle: number;
} | null {
    if (!info.loop) return null;
    return seCfg.exact
        ? {
            start: info.loop.startExactFrame,
            end: info.loop.endExactFrame,
            cycle: info.loop.cycleExactFrames,
        }
        : {
            start: info.loop.startConsoleFrame,
            end: info.loop.endConsoleFrame,
            cycle: info.loop.cycleConsoleFrames,
        };
}

function seDisplayFrame(frame: number, info: SeRequestInfo | null): number {
    if (info?.loop?.count !== 0 || !seCfg.loop) return frame;
    const loop = seLoopFrames(info);
    if (!loop || frame <= loop.end) return frame;
    const cycle = Math.max(100, loop.cycle);
    return loop.start + (frame - loop.start) % cycle;
}

function seNoteCounts(info: SeRequestInfo): { starts: number; stops: number } {
    let starts = 0, stops = 0;
    for (const event of info.events) {
        if (event.kind === "note") starts++;
        else if (event.kind === "off") stops++;
    }
    return { starts, stops };
}

function seStopTargets(info: SeRequestInfo): string {
    const targets = new Set<string>();
    for (const event of info.events)
        if (event.kind === "off")
            targets.add(`program ${event.program}, key ${event.key}`);
    return [...targets].join("; ");
}

function seIsStopOnly(info: SeRequestInfo): boolean {
    const { starts, stops } = seNoteCounts(info);
    return starts === 0 && stops > 0 && info.controls === 0 && !info.loop;
}

function seHasLingeringSource(info: SeRequestInfo): boolean {
    return info.loopingVoices > 0
        && seSourceEndFrames(info) > seEventFrames(info) + RATE / 10;
}

function seDurationLabel(info: SeRequestInfo): string {
    const { stops } = seNoteCounts(info);
    if (seIsStopOnly(info))
        return stops === 1 ? "voice stop" : `${stops} voice stops`;
    const frames = seEventFrames(info);
    const seconds = frames / RATE;
    const time = seconds < 10 ? `${seconds.toFixed(1)}s` : fmtSeTime(frames);
    if (info.loop?.count === 0)
        return `stream ∞ · ${time} cycle`;
    if (info.sustained)
        return `source loop ∞ · ${time} events`;
    if (seHasLingeringSource(info))
        return `source loop · ${time} events`;
    return info.loop
        ? `${time} events · repeat ×${info.loop.count}`
        : `${time} events`;
}

function sameSeRow(a: SeRow, b: SeRow): boolean {
    if (a.kind !== b.kind || a.entry.name !== b.entry.name) return false;
    return a.kind === "bank" ||
        (b.kind === "cue" && a.bank === b.bank && a.request === b.request);
}

function buildSeRows(): void {
    const selected = seRows[seSel];
    const q = $<HTMLInputElement>("se-search").value.trim().toLowerCase();
    const rows: SeRow[] = [];
    for (const entry of seCatalog?.entries ?? []) {
        if (q && !entry.name.toLowerCase().includes(q)) continue;
        rows.push({ kind: "bank", entry });
        if (entry.name !== seOpenBank || !seShape) continue;
        for (let bank = 0; bank < seShape.length; bank++) {
            for (let request = 0; request < seShape[bank]!; request++)
                rows.push({ kind: "cue", entry, bank, request });
        }
    }
    seRows = rows;
    const preserved = selected
        ? seRows.findIndex((row) => sameSeRow(row, selected))
        : -1;
    seSel = preserved >= 0
        ? preserved
        : Math.min(seSel, Math.max(0, seRows.length - 1));
}

function renderSeList(): void {
    buildSeRows();
    const children = seRows.map((row, i) => {
        const li = document.createElement("li");
        li.className = row.kind;
        li.classList.toggle("sel", i === seSel);
        if (row.kind === "bank") {
            const open = row.entry.name === seOpenBank;
            const label = document.createElement("span");
            label.textContent = `${open ? "\u25BE" : "\u25B8"} ${row.entry.name}`;
            const count = document.createElement("span");
            count.className = "count";
            count.textContent = open && seShape
                ? `${seShape.reduce((n, v) => n + v, 0)} requests`
                : `${row.entry.bytes / 1048576 < 0.1
                    ? (row.entry.bytes / 1024).toFixed(0) + " KB"
                    : (row.entry.bytes / 1048576).toFixed(1) + " MB"}`;
            li.append(label, count);
        } else {
            const label = document.createElement("span");
            label.textContent = `${row.bank}:${row.request}`;
            const detail = document.createElement("span");
            detail.className = "count";
            const info = currentSeInfo(row);
            detail.textContent = info ? seDurationLabel(info) : "";
            li.append(label, detail);
            li.classList.toggle("playing", sePlaying?.entry.name === row.entry.name
                && sePlaying.bank === row.bank
                && sePlaying.request === row.request);
        }
        li.onclick = () => { seSel = i; void seActivate(i, row.kind === "cue"); };
        return li;
    });
    $("selist").replaceChildren(...children);
    $("selist").children[seSel]?.scrollIntoView({ block: "nearest" });
    viewerRevision++;
}

function ensureSeCatalog(): Promise<boolean> {
    const target = session;
    if (!target) return Promise.resolve(false);
    if (seCatalogRequest?.target === target)
        return seCatalogRequest.promise;
    const promise = loadSeCatalog(target);
    seCatalogRequest = { target, promise };
    const clear = (): void => {
        if (seCatalogRequest?.promise === promise)
            seCatalogRequest = null;
    };
    void promise.then(clear, clear);
    return promise;
}

async function loadSeCatalog(target: DiscSession): Promise<boolean> {
    const meta = await target.se.cached();
    if (session !== target) return false;
    if (!meta) {
        const needsIso = !target.se.hasIso();
        seSetup(true, needsIso);
        if (!needsIso) {
            await extractSeBanks();
            return session === target && seCatalog !== null;
        }
        return false;
    }
    seCatalog = meta;
    seSetup(false);
    renderSeList();
    return true;
}
async function extractSeBanks(): Promise<void> {
    const target = session;
    if (!target || seExtracting) return;
    const btn = $<HTMLButtonElement>("se-extract");
    const st = $("se-setup-status");
    const progress = $<HTMLProgressElement>("se-progress");
    btn.disabled = true;
    btn.hidden = true;
    progress.hidden = false;
    st.classList.remove("err");
    seExtracting = true;
    try {
        const catalog = await target.se.extract((done, total, name) => {
            if (session !== target) return;
            progress.max = total;
            progress.value = done;
            st.textContent = `extracting ${done}/${total}: ${name}`;
        });
        if (session !== target) return;
        seCatalog = catalog;
        st.textContent = `${catalog.entries.length} SE banks ready`;
        seSetup(false);
        renderSeList();
        if (tab === "se")
            statusWithWarnings(target, "se",
                `${catalog.entries.length} SE banks cached`);
    } catch (error) {
        if (session !== target) return;
        st.textContent = friendlyError(error);
        st.classList.add("err");
        btn.hidden = false;
    } finally {
        if (session === target) {
            btn.disabled = false;
            progress.hidden = true;
            seExtracting = false;
        }
    }
}

async function seActivate(i: number, play: boolean): Promise<void> {
    const target = session;
    if (!target || seLoading) return;
    const row = seRows[i];
    if (!row) return;
    if (row.kind === "cue") {
        if (play) await loadSeCue(row, true);
        return;
    }
    if (seOpenBank === row.entry.name) {
        seOpenBank = null;
        seShape = null;
        seDetails = null;
        renderSeList();
        return;
    }
    seLoading = true;
    status(`reading ${row.entry.name} sequence table...`);
    try {
        const files = await target.se.bank(row.entry);
        if (session !== target) return;
        const inspection = await seInspector.inspect(files);
        if (session !== target) return;
        seShape = inspection.requests;
        seDetails = inspection.details;
        seOpenBank = row.entry.name;
        statusWithWarnings(target, "se");
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    } finally {
        if (session === target) {
            seLoading = false;
            renderSeList();
        }
    }
}

const seEngineConfig = (info = currentSeInfo()): EngineConfig => ({
    songvol: seCfg.volume,
    revDepth: seCfg.revDepth,
    exact: seCfg.exact,
    gaussian: seCfg.gaussian,
    loop: info?.loop?.count === 0 && seCfg.loop ? LOOP_FOREVER : 0,
    cueOn: false,
    cueScale: 1,
    duckDemo: false,
    duckPhone: false,
});

async function seSynthAssets(target: DiscSession, entry: SeBankEntry) {
    const files = await target.se.bank(entry);
    const [irx, libsd] = await Promise.all([
        target.read("irx/sg2iopm1.irx"),
        target.read("irx/libsd.irx"),
    ]);
    return { files, assets: { ...files, irx, libsd } };
}

function cloneSeMeasureFiles(assets: SeMeasureFiles): SeMeasureFiles {
    return {
        hd: assets.hd.slice(),
        bd: assets.bd.slice(),
        irx: assets.irx?.slice() ?? null,
        libsd: assets.libsd?.slice() ?? null,
    };
}

function recordSeMeasurementFailure(error: unknown): void {
    const reason = friendlyError(error);
    seMeasureError = reason;
    console.error("SE duration analysis failed", error);
    if (tab === "se")
        status(`SE duration analysis unavailable: ${reason}`, true);
}

function startSeMeasurement(
    row: Extract<SeRow, { kind: "cue" }>, assets: SeMeasureFiles,
    token = ++seMeasureToken,
): void {
    seKnownFrames = null;
    seKnownEstimated = false;
    seMeasureError = null;
    seMeasuring = true;
    renderSeLength();
    void seInspector.measure(
        cloneSeMeasureFiles(assets), row.bank, row.request,
        seCfg.exact, seCfg.revDepth,
    ).then((measure) => {
        if (token !== seMeasureToken) return;
        seKnownFrames = measure.frames;
        seKnownEstimated = measure.estimated;
        seMeasureError = null;
    }, (error) => {
        if (token !== seMeasureToken) return;
        recordSeMeasurementFailure(error);
    }).finally(() => {
        if (token !== seMeasureToken) return;
        seMeasuring = false;
        renderSeLength();
        renderSeInfo();
    });
}

async function refreshSeMeasurement(): Promise<void> {
    const target = session;
    const row = sePlaying;
    if (!target || !row) return;
    const token = ++seMeasureToken;
    seKnownFrames = null;
    seKnownEstimated = false;
    seMeasureError = null;
    seMeasuring = true;
    renderSeLength();
    try {
        const { assets } = await seSynthAssets(target, row.entry);
        if (token !== seMeasureToken || session !== target || sePlaying !== row)
            return;
        startSeMeasurement(row, assets, token);
    } catch (error) {
        if (token !== seMeasureToken || session !== target || sePlaying !== row)
            return;
        seMeasuring = false;
        recordSeMeasurementFailure(error);
        renderSeLength();
        renderSeInfo();
    }
}

async function loadSeCue(
    row: Extract<SeRow, { kind: "cue" }>, autoplay: boolean,
): Promise<void> {
    const target = session;
    if (!target || seLoading) return;
    let p: WorkletPlayer;
    try {
        p = await ensurePlayer();
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
        return;
    }
    if (session !== target) return;
    p.resume();
    sPlayer.pause();
    seLoading = true;
    finished = false;
    status(`loading ${row.entry.name} ${row.bank}:${row.request}...`);
    p.snap = null;
    seSourceLoopViz?.clear();
    try {
        const info = currentSeInfo(row);
        const { assets } = await seSynthAssets(target, row.entry);
        if (session !== target) return;
        startSeMeasurement(row, assets);
        const result = await p.loadSe(
            assets, row.bank, row.request, seEngineConfig(info));
        if (session !== target) return;
        sePlaying = row;
        sePlayingInfo = info;
        sePastEvents = false;
        audioMode = "se";
        timeline = null;
        p.snap = null;
        seViz?.clearWave();
        seSourceLoopViz?.clear();
        viewerLevelHistory.fill(0);
        viewerLevelHead = 0;
        seSequenceViz?.set(info);
        $("se-name").textContent = row.entry.name;
        $("se-coord").textContent = `bank ${row.bank} · request ${row.request}`;
        renderSeLength();
        $<HTMLButtonElement>("se-playbtn").disabled = false;
        $<HTMLButtonElement>("se-bankbtn").disabled = false;
        updateSeExportBtn();
        if (seMeasureError)
            status(`SE duration analysis unavailable: ${seMeasureError}`, true);
        else
            statusWithWarnings(
                target,
                "se",
                result.warning ? `warning: ${result.warning}` : "",
                !!result.warning,
            );
        if (autoplay) p.play();
    } catch (error) {
        if (session === target) {
            status(friendlyError(error), true);
            seKnownEstimated = false;
            seMeasureToken++;
            seMeasuring = false;
        }
    } finally {
        if (session === target) {
            seLoading = false;
            renderSeList();
            renderSeDials();
        }
    }
}

function seTogglePlay(): void {
    if (!sePlaying) {
        let i = seSel;
        while (i < seRows.length && seRows[i]!.kind !== "cue") i++;
        const row = seRows[i];
        if (row?.kind === "cue") {
            seSel = i;
            void loadSeCue(row, true);
        }
    } else if (!player || audioMode !== "se") {
        void loadSeCue(sePlaying, true);
    } else if (finished) {
        finished = false;
        player.seek(0);
        player.play();
    } else if (player.snap?.playing) {
        player.pause();
    } else {
        sPlayer.pause();
        player.play();
    }
}

function renderSeLength(): void {
    const info = currentSeInfo();
    if (!info) {
        $("se-len").textContent = "—";
    } else if (seIsStopOnly(info)) {
        $("se-len").textContent = "voice-stop command";
    } else if (info.loop?.count === 0 && seCfg.loop) {
        const loop = seLoopFrames(info)!;
        $("se-len").textContent =
            `∞ · ${fmtSeTime(loop.cycle)} stream cycle`;
    } else if (info.sustained) {
        $("se-len").textContent = "∞ · non-decaying source";
    } else if (seHasLingeringSource(info)) {
        $("se-len").textContent =
            `${fmtSeTime(seEventFrames(info))} event track · source loop`;
    } else if (seKnownFrames !== null) {
        $("se-len").textContent =
            `${seKnownEstimated ? "≈" : ""}${fmtSeTime(seKnownFrames)} audio`;
    } else if (seMeasuring) {
        $("se-len").textContent = "measuring audio…";
    } else if (seMeasureError) {
        $("se-len").textContent =
            `${fmtSeTime(seEventFrames(info))} events · audio unavailable`;
    } else {
        $("se-len").textContent = `${fmtSeTime(seEventFrames(info))} events`;
    }
    const sourceSeek = info !== null && seHasLingeringSource(info);
    const seekLimited = seSeekDomain() > SE_SEEK_LIMIT;
    $("se-bar").classList.toggle("seek-limited", seekLimited);
    $("se-bar").title = seekLimited
        ? "This source exceeds the five-minute rebuild/fast-forward seek limit; click the event score to seek its authored commands"
        : sourceSeek
            ? "Click to seek within the authored event track; the source loop continues afterward"
            : "Click to seek within the audible request or displayed stream cycle";
}
function renderSeInfo(): void {
    if (!sePlaying) return;
    const info = currentSeInfo();
    const counts = info ? seNoteCounts(info) : null;
    let stream = "event metadata unavailable";
    if (info && counts) {
        let track = `${fmtSeTime(seEventFrames(info))} event track`;
        if (info.loop) {
            const jump = info.loop.count === 0
                ? "infinite jump"
                : `jump ×${info.loop.count}`;
            track = `${jump} ${fmtSeTime(seLoopFrames(info)!.cycle)} cycle`;
        }
        stream = `${counts.starts} start${counts.starts === 1 ? "" : "s"} · `
            + `${counts.stops} stop${counts.stops === 1 ? "" : "s"} · `
            + `${info.controls} control${info.controls === 1 ? "" : "s"} · ${track}`;
    }
    const sourceEnd = info ? seSourceEndFrames(info) : 0;
    let sources = "";
    if (info) {
        if (seIsStopOnly(info)) {
            sources = `voice-stop request: stops matching live ${seStopTargets(info)}; `
                + "starts no audio source by itself";
        } else if (info.sustained) {
            sources = `${info.sustainedVoices} non-decaying loop/noise `
                + `voice${info.sustainedVoices === 1 ? "" : "s"} remain after the event track`;
        } else if (info.loopingVoices && sourceEnd > seEventFrames(info)) {
            sources = `${info.loopingVoices} loop/noise source `
                + `voice${info.loopingVoices === 1 ? "" : "s"} `
                + `${info.loopingVoices === 1 ? "remains" : "remain"} after events; `
                + `envelope endpoint ≈${fmtSeTime(sourceEnd)}`;
        } else if (info.activeVoices) {
            sources = `${info.activeVoices} note${info.activeVoices === 1 ? "" : "s"} `
                + `${info.activeVoices === 1 ? "has" : "have"} no explicit note-off; `
                + "waveform/envelope lifetime ends the source";
        } else {
            sources = "all started notes receive an explicit note-off";
        }
    }
    const now = sePastEvents && info?.loopingVoices
        ? "\nplayback now: event track ended; loop/noise source envelope is still sounding"
        : "";
    $("se-info").textContent =
        `${sePlaying.entry.hd} + ${sePlaying.entry.bd}\n${stream}\n${sources}${now}\n`
        + `isolated caller volume ${seCfg.volume}/127 · `
        + `${seCfg.exact ? "exact 480 Hz" : "console 60 Hz"} dispatch · `
        + `${seCfg.gaussian ? "SPU2 gaussian" : "bright"} resampling · `
        + `reverb ${seCfg.revDepth}`;
}

function renderSeDials(): void {
    $("se-vol").textContent = `VOL ${seCfg.volume}`;
    const info = currentSeInfo();
    const loop = $<HTMLButtonElement>("se-loop");
    const hostLoop = info?.loop?.count === 0;
    loop.disabled = !hostLoop;
    let loopLabel: string;
    if (hostLoop) {
        loopLabel = seCfg.loop ? "LOOP STREAM" : "STREAM ONCE";
    } else if (info?.loop) {
        loopLabel = `REPEAT \u00D7${info.loop.count}`;
    } else if (info?.sustained) {
        loopLabel = "SUSTAINED SOURCE";
    } else if (info?.loopingVoices) {
        loopLabel = "SOURCE LOOP";
    } else {
        loopLabel = "ONE SHOT";
    }
    loop.textContent = loopLabel;
    loop.classList.toggle("on", hostLoop && seCfg.loop);
    $("se-timing").textContent = seCfg.exact ? "EXACT" : "TICK";
    $("se-timing").classList.toggle("on", seCfg.exact);
    $("se-kernel").textContent = seCfg.gaussian ? "GAUSS" : "BRIGHT";
    $("se-kernel").classList.toggle("on", seCfg.gaussian);
    $("se-rev").textContent = seCfg.revDepth > 0 ? `REV ${seCfg.revDepth}` : "REV OFF";
    $("se-rev").classList.toggle("on", seCfg.revDepth > 0);
    renderSeLength();
    renderSeInfo();
}

function setSeVolume(value: number): void {
    seCfg.volume = Math.max(1, Math.min(127, value));
    if (audioMode === "se") player?.set("songvol", seCfg.volume);
    renderSeDials();
}

function seToggleLoop(): void {
    if (currentSeInfo()?.loop?.count !== 0) return;
    seCfg.loop = !seCfg.loop;
    finished = false;
    sePastEvents = false;
    if (audioMode === "se") {
        player?.set("loop", seCfg.loop ? LOOP_FOREVER : 0);
        rebuildSe(0);
    }
    renderSeDials();
}

function seToggleExact(): void {
    seCfg.exact = !seCfg.exact;
    seKnownFrames = null;
    seKnownEstimated = false;
    seMeasureError = null;
    sePastEvents = false;
    if (audioMode === "se") {
        finished = false;
        player?.set("exact", seCfg.exact ? 1 : 0);
        rebuildSe(0);
        void refreshSeMeasurement();
    }
    renderSeDials();
    renderSeList();
}

function seToggleKernel(): void {
    seCfg.gaussian = !seCfg.gaussian;
    if (audioMode === "se") player?.set("gaussian", seCfg.gaussian ? 1 : 0);
    renderSeDials();
}

function rebuildSe(frame: number): void {
    if (!player || audioMode !== "se") return;
    player.snap = null;
    seSourceLoopViz?.clear();
    player.seek(Math.max(0, Math.round(frame)));
}

function seekSe(frame: number): void {
    if (!player || audioMode !== "se") return;
    finished = false;
    sePastEvents = false;
    rebuildSe(frame);
}

function seSeekDomain(): number {
    const info = currentSeInfo();
    if (!info) return RATE / 4;
    if (info.loop?.count === 0 && seCfg.loop)
        return Math.max(100, seLoopFrames(info)!.end);
    if (seHasLingeringSource(info))
        return Math.max(RATE / 4, seEventFrames(info));
    return seKnownFrames
        ?? Math.max(seEventFrames(info), seSourceEndFrames(info));
}

function seToggleReverb(): void {
    seCfg.revDepth = seCfg.revDepth > 0 ? 0 : 30;
    seKnownFrames = null;
    seKnownEstimated = false;
    seMeasureError = null;
    if (audioMode === "se") {
        player?.set("revDepth", seCfg.revDepth);
        void refreshSeMeasurement();
    }
    renderSeDials();
}

function seNeedsExportCap(info: SeRequestInfo | null): boolean {
    return !!info && (info.sustained
        || seSourceEndFrames(info) > SE_SEEK_LIMIT);
}

function updateSeExportBtn(): void {
    const button = $<HTMLButtonElement>("se-exportbtn");
    button.disabled = !sePlaying || seBusy || exporter.busy;
    button.textContent = seBusy || exporter.busy ? "EXPORTING" : "EXPORT WAV";
    const info = currentSeInfo();
    const needsCap = seNeedsExportCap(info);
    const once = $<HTMLButtonElement>("se-ex-once");
    once.disabled = needsCap;
    once.textContent = needsCap ? "FULL DURATION TOO LONG" : "PLAY ONCE";
    const canCap = info?.loop?.count === 0 || needsCap;
    for (const id of ["se-ex-10", "se-ex-30", "se-ex-60"])
        $<HTMLButtonElement>(id).disabled = !canCap;
}

async function exportSeCue(
    looping = currentSeInfo()?.loop?.count === 0 && seCfg.loop,
    seconds = 10,
): Promise<void> {
    const target = session;
    if (!target || !sePlaying || seBusy || exporter.busy) return;
    const row = sePlaying;
    const info = currentSeInfo();
    looping = looping && info?.loop?.count === 0;
    const needsCap = seNeedsExportCap(info);
    const capped = looping || needsCap;
    const fullFrames = Math.max(
        seKnownFrames ?? 0,
        seEventFrames(info!),
        seSourceEndFrames(info!),
    );
    const cap = capped
        ? seconds
        : Math.max(seconds, Math.ceil(fullFrames / RATE) + 1);
    const mode = looping
        ? `loop${seconds}s`
        : needsCap ? `${seconds}s` : "once";
    seBusy = true;
    $("se-export-menu").hidden = true;
    updateSeExportBtn();
    status(`EXPORTING se_${row.entry.name}_${row.bank}_${row.request}_${mode}.wav...`);
    try {
        const { assets } = await seSynthAssets(target, row.entry);
        if (session !== target) return;
        const opts: SeExportOpts = {
            bank: row.bank, request: row.request, volume: seCfg.volume,
            revDepth: seCfg.revDepth, exact: seCfg.exact,
            bright: !seCfg.gaussian, seconds: cap, loop: looping,
        };
        exporter.se(`se_${row.entry.name}_${mode}`, assets, opts);
    } catch (error) {
        if (session === target)
            status(`EXPORT FAILED: ${friendlyError(error)}`, true);
    } finally {
        if (session === target) {
            seBusy = false;
            updateSeExportBtn();
        }
    }
}

async function exportSeBank(): Promise<void> {
    const target = session;
    const row = sePlaying;
    if (!target || !row) return;
    try {
        const { hd, bd } = await target.se.bank(row.entry);
        if (session !== target) return;
        const zip = storeZip([
            [row.entry.hd, hd],
            [row.entry.bd, bd],
        ]);
        const file = `${row.entry.name}_bank.zip`;
        download(zip, file, "application/zip");
        statusWithWarnings(target, "se", `EXPORTED ${file}`);
    } catch (error) {
        if (session === target)
            status(`EXPORT FAILED: ${friendlyError(error)}`, true);
    }
}

/* ---- render loop -------------------------------------------------------- */
function fmtTime(samples: number): string {
    const t = Math.max(0, samples) / RATE;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function tick(): void {
    requestAnimationFrame(tick);
    if (tab === "fmv") {
        const movie = movieController.snapshot();
        const search = $<HTMLInputElement>("fmv-search").value.trim().toLocaleLowerCase();
        if (movie.revision !== fmvRenderedRevision)
            renderFmvStatic(movie);
        else if (search !== fmvRenderedSearch)
            renderFmvList(movie);

        const glyph = movie.playing ? "&#10074;&#10074;" : "&#9654;";
        if (glyph !== fmvGlyph) {
            fmvGlyph = glyph;
            $("fmv-play").innerHTML = `<span>${glyph}</span>`;
        }
        const play = $<HTMLButtonElement>("fmv-play");
        play.disabled = !movie.entry || movie.exporting;
        play.setAttribute("aria-busy", String(movie.loading));
        play.setAttribute("aria-label",
            `${movie.playing ? "Pause" : "Play"} ${movie.entry?.label ?? "selected movie"}`);

        const fraction = movie.duration > 0
            ? Math.min(Math.max(movie.current / movie.duration, 0), 1)
            : 0;
        $("fmv-bar-fill").style.width = `${(fraction * 100).toFixed(3)}%`;
        $("fmv-bar-head").style.left = `calc(${(fraction * 100).toFixed(3)}% - 1px)`;
        const bar = $("fmv-bar");
        bar.setAttribute("aria-valuenow", String(Math.round(fraction * 1000)));
        bar.setAttribute("aria-valuetext",
            `${fmtSec(movie.current)} of ${fmtSec(movie.duration)}`);
        $("fmv-current").textContent = fmtSec(movie.current);
        $("fmv-duration").textContent = fmtSec(movie.duration);

        const caption = $("fmv-caption");
        const captionText = movie.caption ?? "";
        if (caption.textContent !== captionText) caption.textContent = captionText;
        caption.hidden = !movie.captionsEnabled || movie.caption === null;
        const cc = $<HTMLButtonElement>("fmv-cc");
        cc.disabled = !movie.prepared || !movie.entry?.subtitleCues;
        cc.setAttribute("aria-pressed", String(movie.captionsEnabled));

        const statusElement = $("fmv-status");
        const persistence = session?.movies.persistenceWarning ?? "";
        const message = [
            movie.status || "Nothing leaves this browser.",
            persistence,
        ].filter(Boolean).join(" · ");
        if (statusElement.textContent !== message) statusElement.textContent = message;
        statusElement.classList.toggle("err", movie.error || persistence.length > 0);
        const busy = movie.loading || movie.exporting;
        const jobProgress = $("fmv-job-progress");
        jobProgress.setAttribute("aria-valuenow", String(Math.round(movie.progress * 100)));
        jobProgress.setAttribute("aria-valuetext", message);
        jobProgress.hidden = !busy;
        const cancel = $<HTMLButtonElement>("fmv-cancel");
        cancel.hidden = !movie.cancellable;
        cancel.disabled = !movie.cancellable;

        const navigationDisabled = !movie.catalog?.entries.length || movie.exporting;
        $<HTMLButtonElement>("fmv-prev").disabled = navigationDisabled;
        $<HTMLButtonElement>("fmv-next").disabled = navigationDisabled;
        document.querySelectorAll<HTMLButtonElement>("[data-fmv-name]")
            .forEach(button => { button.disabled = movie.exporting; });
        document.querySelectorAll<HTMLButtonElement>("[data-fmv-export]")
            .forEach(button => { button.disabled = !movie.entry || busy; });
        $<HTMLInputElement>("fmv-iso").disabled = busy;
        $<HTMLButtonElement>("fmv-remove-cache").disabled =
            busy || !movie.cache?.totalBytes;
        return;
    }
    /* streams transport (independent of the BGM branch below) */
    if (tab === "streams" && sPlayer.decoded()) {
        const cur = sPlayer.pos(), dur = sPlayer.dur();
        $("s-cur").textContent = fmtSec(cur);
        const frac = dur > 0 ? Math.min(cur / dur, 1) : 0;
        $("s-bar-fill").style.width = `${(frac * 100).toFixed(3)}%`;
        $("s-bar-head").style.left = `calc(${(frac * 100).toFixed(3)}% - 1px)`;
        const glyph = sPlayer.playing() ? "&#10074;&#10074;" : "&#9654;";
        if (glyph !== sGlyph) {         /* write-on-change: see pbGlyph note */
            sGlyph = glyph;
            $("s-playbtn").innerHTML = `<span>${glyph}</span>`;
        }
        sViz?.draw(frac);
    }
    if (tab === "se" && player && audioMode === "se") {
        const s = player.snap;
        const pos = s?.pos ?? 0;
        if (finished && pos > 0 && pos !== seKnownFrames) {
            seKnownFrames = pos;
            seKnownEstimated = false;
            seMeasureError = null;
            seMeasuring = false;
            renderSeLength();
        }
        $("se-cur").textContent = fmtTime(pos);
        const info = currentSeInfo();
        const eventFrames = info ? seEventFrames(info) : RATE / 4;
        const pastEvents = !!info?.loopingVoices
            && !(info.loop?.count === 0 && seCfg.loop)
            && pos >= eventFrames;
        if (pastEvents !== sePastEvents) {
            sePastEvents = pastEvents;
            renderSeInfo();
        }
        const display = seDisplayFrame(pos, info);
        const duration = seSeekDomain();
        const frac = Math.min(display / duration, 1);
        $("se-bar-fill").style.width = `${(frac * 100).toFixed(3)}%`;
        $("se-bar-head").style.left =
            `calc(${(frac * 100).toFixed(3)}% - 1px)`;
        const glyph = s?.playing ? "&#10074;&#10074;" : "&#9654;";
        if (glyph !== seGlyph) {
            seGlyph = glyph;
            $("se-playbtn").innerHTML = `<span>${glyph}</span>`;
        }
        if (s) {
            const st = s.stats;
            $("stats-line").textContent =
                `VOICES STARTED ${st.voices_started}  `
                + `BUS PEAK ${st.bus_peak}/32767  CLIP ${st.bus_clipped}  `
                + `WET PEAK ${st.wet_peak}  WET CLIP ${st.wet_clipped}`;
            const clip = st.bus_clipped + st.wet_clipped;
            if (clip > prevClip) {
                prevClip = clip;
                clipFlash = performance.now();
            }
        }
        $("clip-flash").hidden =
            !(clipFlash && performance.now() - clipFlash < 700);
        seViz?.draw(s, null, pos, false);
        seSourceLoopViz?.draw(s);
        seSequenceViz?.draw(
            s, info?.loop?.count === 0 && seCfg.loop, seCfg.exact);
        return;
    }
    if (!player || !timeline || audioMode !== "bgm") {
        if (tab === "bgm") viz?.draw(null, null, 0, cfg.loop);
        return;
    }
    const s = player.snap;
    const disp = displaySample();
    $("time-cur").textContent = fmtTime(disp);
    if (s) $("bpm").textContent = `${bpmOf(timeline, s.clock).toFixed(1)} BPM`;
    $("loopx").textContent =
        s && s.stats.loops_taken > 0 ? `\u00D7${s.stats.loops_taken}` : "";
    const frac = timeline.lenSamp > 0
        ? Math.min(disp / timeline.lenSamp, 1) : 0;
    $("bar-fill").style.width = `${(frac * 100).toFixed(3)}%`;
    $("bar-head").style.left = `calc(${(frac * 100).toFixed(3)}% - 1px)`;
    const lp = $("bar-loop");
    if (timeline.loopS0 >= 0 && timeline.loopS1 > timeline.loopS0 && cfg.loop) {
        lp.style.display = "block";
        lp.style.left = `${(timeline.loopS0 / timeline.lenSamp * 100).toFixed(3)}%`;
        lp.style.width = `${((timeline.loopS1 - timeline.loopS0)
                             / timeline.lenSamp * 100).toFixed(3)}%`;
    } else {
        lp.style.display = "none";
    }
    /* Write the glyph only when it changes. Replacing the span every frame
     * makes WebKit swallow clicks whose down/up straddle that replacement. */
    const glyph = s?.playing ? "&#10074;&#10074;" : "&#9654;";
    if (glyph !== pbGlyph) {
        pbGlyph = glyph;
        $("playbtn").innerHTML = `<span>${glyph}</span>`;
    }
    if (s) {
        const st = s.stats;
        $("stats-line").textContent =
            `VOICES STARTED ${st.voices_started}  BUS PEAK ${st.bus_peak}/32767`
            + `  CLIP ${st.bus_clipped}  WET PEAK ${st.wet_peak}`
            + `  WET CLIP ${st.wet_clipped}`;
        const clip = st.bus_clipped + st.wet_clipped;
        if (clip > prevClip) {
            prevClip = clip;
            clipFlash = performance.now();
        }
        if (cfg.cueOn && s.cueSongvol >= 0) {
            const txt = `VOL ${s.cueSongvol} CUE`;
            const el = $("d-vol");
            if (el.textContent !== txt) el.textContent = txt;
        }
    }
    $("clip-flash").hidden = !(clipFlash && performance.now() - clipFlash < 700);
    viz?.draw(s, timeline, disp, cfg.loop);
}

/* ---- export (bgmplay's dropdown: current / authored / loop xN) ---------- */
function updateExportBtn(): void {
    const b = $<HTMLButtonElement>("exportbtn");
    b.disabled = exporter.busy;
    b.textContent = exporter.busy ? "EXPORTING" : "EXPORT WAV";
}

async function exportWav(mode: "current" | "authored" | "loop"): Promise<void> {
    const target = session;
    if (!target || playingIdx < 0 || exporter.busy) return;
    const song = target.songs[playingIdx]!;
    let suffix = "";
    let options: ExportOpts;
    if (mode === "authored") {
        suffix = "_authored";
        options = { songvol: song.songvol, revDepth: 30, exact: true,
                    bright: false, loop: 0 };
    } else {
        options = { songvol: cfg.songvol, revDepth: cfg.revDepth, exact: cfg.exact,
                    bright: !cfg.gaussian, loop: 0 };
        if (mode === "loop") {
            suffix = `_loop${loopN}`;
            options.loop = loopN;
        }
    }
    try {
        const assets = await target.songAssets(song);
        if (session !== target) return;
        exporter.start(song.name, suffix, assets, options);
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    }
    if (session === target) updateExportBtn();
}

/* MIDI export: the sequence exactly as it sits on the disc (a standard SMF;
 * the CC99 20/30 loop markers ride along as plain controller events). No
 * render involved, so no worker and no busy state. */
async function exportMidi(): Promise<void> {
    const target = session;
    if (!target || playingIdx < 0) return;
    const song = target.songs[playingIdx]!;
    try {
        const mid = await target.read(`bgm/${song.mid}`);
        if (session !== target) return;
        if (!mid)
            throw new Error(`missing asset bgm/${song.mid}`
                            + " -- forget the disc and re-open the ISO");
        download(mid, song.mid, "audio/midi");
        status(`EXPORTED ${song.mid}`);
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    }
}

/* Kit export: every waveform in the song's bank decoded to WAV (44100 Hz,
 * loop points + root key as smpl chunks), zipped. Decode runs in the export
 * worker through the SDK's bank-introspection API. */
async function exportKit(): Promise<void> {
    const target = session;
    if (!target || playingIdx < 0 || exporter.busy) return;
    const song = target.songs[playingIdx]!;
    try {
        const assets = await target.songAssets(song);
        if (session !== target) return;
        exporter.kit(song.name, assets);
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    }
    if (session === target) updateExportBtn();
}

/* Bank export: the song's instrument bank exactly as it sits on the disc --
 * .hd (Sony "Jam" header) + .bd (raw PS-ADPCM body). One zip, not two
 * downloads: a click is one gesture, and Chrome silently blocks the second
 * same-gesture download until the user allows "multiple downloads". */
async function exportBank(): Promise<void> {
    const target = session;
    if (!target || playingIdx < 0) return;
    const song = target.songs[playingIdx]!;
    try {
        const files: [string, Uint8Array][] = [];
        for (const name of [song.hd, song.bd]) {
            const bytes = await target.read(`bgm/${name}`);
            if (session !== target) return;
            if (!bytes)
                throw new Error(`missing asset bgm/${name}`
                                + " -- forget the disc and re-open the ISO");
            files.push([name, bytes]);
        }
        const file = `${song.name}_bank.zip`;
        download(storeZip(files), file, "application/zip");
        status(`EXPORTED ${file}`);
    } catch (error) {
        if (session === target) status(friendlyError(error), true);
    }
}

/* ---- help + export menu visibility -------------------------------------- */
function toggleHelp(force?: boolean): void {
    const h = $("help");
    h.hidden = force !== undefined ? !force : !h.hidden;
}

function showExportMenu(show: boolean): void {
    $("export-menu").hidden = !show;
}

function showBankMenu(show: boolean): void {
    $("bank-menu").hidden = !show;
}

function showSeExportMenu(show: boolean): void {
    $("se-export-menu").hidden = !show;
}

/* ---- keyboard (bgmplay's map) ------------------------------------------- */
function onKey(e: KeyboardEvent): void {
    if (document.documentElement.hasAttribute("data-viewer")) return;
    if (!session || $("app").hidden) return;
    if (tab === "fmv" && e.key === "Escape" && exitFmvFullscreen()) {
        e.preventDefault();
        return;
    }
    const target = e.target;
    if (target instanceof HTMLElement
            && (target.matches("input, textarea, select, button, [contenteditable='true']")
                || target.closest("input, textarea, select, button, [contenteditable='true']"))) {
        if (e.key === "Escape") target.blur();
        return;
    }
    if (tab === "stage-previews") {
        if (stagePreviewBrowser?.handleKey(e)) e.preventDefault();
        return;
    }
    if (tab === "models") {
        if (modelBrowser?.handleKey(e)) e.preventDefault();
        return;
    }
    if (tab === "images") {
        let handled = true;
        const current = imageRows.findIndex(entry => entry.id === imageSelected?.id);
        switch (e.key) {
        case "ArrowUp":
        case "ArrowDown": {
            if (!imageRows.length) break;
            const delta = e.key === "ArrowUp" ? -1 : 1;
            const origin = current < 0 ? (delta > 0 ? -1 : 0) : current;
            const index = (origin + delta + imageRows.length) % imageRows.length;
            if (imageViewMode !== "tree" && index >= imageVisibleLimit) {
                const batch = imageViewMode === "grid" ? 120 : 300;
                imageVisibleLimit = Math.ceil((index + 1) / batch) * batch;
                renderImageList();
            }
            const entry = imageRows[index]!;
            void selectImage(entry);
            requestAnimationFrame(() =>
                $("imagelist").querySelector(`[data-image-id="${CSS.escape(entry.id)}"]`)
                    ?.scrollIntoView({ block: "nearest" }));
            break;
        }
        case "Enter":
            if (imageSelected) void selectImage(imageSelected);
            else if (imageRows[0]) void selectImage(imageRows[0]);
            else handled = false;
            break;
        case "e":
        case "E":
            void exportSelectedImage("png");
            break;
        case "x":
        case "X":
            void exportSelectedImage("tm2");
            break;
        case "a":
        case "A":
            void exportAllImages();
            break;
        default:
            handled = false;
        }
        if (handled) e.preventDefault();
        return;
    }
    if (tab === "fmv") {
        let handled = true;
        switch (e.key) {
        case " ":
            movieController.togglePlayback();
            break;
        case "ArrowUp":
            moveFmv(-1, "preview");
            break;
        case "ArrowDown":
            moveFmv(1, "preview");
            break;
        case "Enter": {
            const name = movieController.snapshot().entry?.name;
            if (name) movieController.select(name, "play");
            else handled = false;
            break;
        }
        case "ArrowLeft":
            movieController.seekBy(-5);
            break;
        case "ArrowRight":
            movieController.seekBy(5);
            break;
        case "c":
        case "C": {
            const movie = movieController.snapshot();
            if (movie.prepared && movie.entry?.subtitleCues)
                movieController.toggleCaptions();
            else handled = false;
            break;
        }
        case "f":
        case "F":
            toggleFmvFullscreen();
            break;
        case "e":
        case "E": {
            const button = document.querySelector<HTMLButtonElement>(
                "[data-fmv-export]:not(:disabled)");
            if (button) button.focus({ preventScroll: true });
            else handled = false;
            break;
        }
        case "Escape": {
            const movie = movieController.snapshot();
            if (movie.cancellable || movie.exporting) movieController.cancel();
            else handled = false;
            break;
        }
        default:
            handled = false;
        }
        if (handled) e.preventDefault();
        return;
    }
    if (tab === "se") {
        switch (e.key) {
        case " ": seTogglePlay(); break;
        case "ArrowUp":
            if (seSel > 0) seSel--;
            renderSeList();
            break;
        case "ArrowDown":
            if (seSel < seRows.length - 1) seSel++;
            renderSeList();
            break;
        case "ArrowRight": {
            const row = seRows[seSel];
            if (row?.kind === "bank" && row.entry.name !== seOpenBank)
                void seActivate(seSel, false);
            break;
        }
        case "ArrowLeft": {
            const row = seRows[seSel];
            if (row?.kind === "cue") {
                while (seSel > 0 && seRows[seSel]!.kind !== "bank") seSel--;
                renderSeList();
            } else if (row?.kind === "bank" && row.entry.name === seOpenBank) {
                void seActivate(seSel, false);
            }
            break;
        }
        case "Enter":
            void seActivate(seSel, seRows[seSel]?.kind === "cue");
            break;
        case "-": setSeVolume(seCfg.volume - 1); break;
        case "=": setSeVolume(seCfg.volume + 1); break;
        case "l": case "L": seToggleLoop(); break;
        case "t": case "T": seToggleExact(); break;
        case "g": case "G": seToggleKernel(); break;
        case "r": case "R": seToggleReverb(); break;
        case "e": case "E": void exportSeCue(); break;
        case "x": case "X": void exportSeBank(); break;
        case "h": case "H": toggleHelp(); break;
        case "Escape": if (!$("help").hidden) toggleHelp(false); break;
        default: return;
        }
        e.preventDefault();
        return;
    }
    if (tab === "streams") {
        switch (e.key) {
        case " ":          sTogglePlay(); break;
        case "ArrowUp":    if (sSel > 0) sSel--;
                           renderStreamList(); scrollStreamSelIntoView(); break;
        case "ArrowDown":  if (sSel < sRows.length - 1) sSel++;
                           renderStreamList(); scrollStreamSelIntoView(); break;
        case "ArrowRight": {                /* unfold the header under the cursor */
            const r = sRows[sSel];
            if (r && r.kind !== "entry" && sFolded.has(r.id)) {
                sFolded.delete(r.id);
                renderStreamList();
            }
            break;
        }
        case "ArrowLeft": {                 /* fold, or hop to the parent header */
            const r = sRows[sSel];
            if (!r) break;
            if (r.kind === "entry") {
                for (let i = sSel - 1; i >= 0; i--)
                    if (sRows[i]!.kind !== "entry") { sSel = i; break; }
            } else if (!sFolded.has(r.id)) {
                sFolded.add(r.id);
            } else if (r.kind === "group") {
                for (let i = sSel - 1; i >= 0; i--)
                    if (sRows[i]!.kind === "section") { sSel = i; break; }
            }
            renderStreamList();
            scrollStreamSelIntoView();
            break;
        }
        case "Enter": {                     /* entry loads; header folds */
            const r = sRows[sSel];
            if (!r) break;
            if (r.kind === "entry") void loadStream(sSel, true);
            else sToggleFold(r.id);
            break;
        }
        case "t": case "T": sToggleTrim(); break;
        case "e": case "E": void sExport(); break;
        case "x": case "X": void sExportRaw(); break;
        case "h": case "H": toggleHelp(); break;
        case "Escape":     if (!$("help").hidden) toggleHelp(false); break;
        default: return;
        }
        e.preventDefault();
        return;
    }
    switch (e.key) {
    case " ":          togglePlay(); break;
    case "ArrowUp":    if (sel > 0) sel--; renderList(); scrollSelIntoView(); break;
    case "ArrowDown":  if (sel < session.songs.length - 1) sel++;
                       renderList(); scrollSelIntoView(); break;
    case "Enter":      void loadSong(sel, true); break;
    case "l": case "L": toggleLoop(); break;
    case "t": case "T": toggleTiming(); break;
    case "g": case "G": toggleKernel(); break;
    case "r": case "R": setRev(cfg.revDepth > 0 ? 0 : 30); break;
    case ",":          setRev(cfg.revDepth - 2); break;
    case ".":          setRev(cfg.revDepth + 2); break;
    case "-":          setVol(cfg.songvol - 1, false); break;
    case "=":          setVol(cfg.songvol + 1, false); break;
    case "a": case "A":
        if (playingIdx >= 0)
            setVol(session.songs[playingIdx]!.songvol, true);
        break;
    case "d": case "D": toggleDuck(); break;
    case "z": case "Z": viz?.zoomIn(); break;
    case "x": case "X": viz?.zoomOut(); break;
    case "e": case "E": void exportWav("current"); break;
    case "h": case "H": toggleHelp(); break;
    case "Escape":
        if (!$("help").hidden) toggleHelp(false);
        else showExportMenu(false);
        break;
    default: return;
    }
    e.preventDefault();
}


/* ---- asset-viewer bridge ----------------------------------------------- */
export function viewerVersion(): number {
    return viewerRevision;
}

export function viewerAssetSession(): DiscSession | null {
    return session;
}

export function viewerLibrary(): ViewerLibrary {
    const channel = viewerChannel;
    const items: ViewerItem[] = [];
    let selectedId: string | null = null;
    const movie = movieController.snapshot();

    if (session && channel === "music") {
        for (let index = 0; index < session.songs.length; index++) {
            const song = session.songs[index]!;
            const id = `music:${index}`;
            const samples = index === playingIdx && timeline
                ? timeline.lenSamp : bgmDurations[index];
            items.push({
                id,
                label: song.name,
                detail: `Sequenced music · authored volume ${song.songvol}/127`,
                duration: samples !== undefined && Number.isFinite(samples)
                    ? samples / RATE : null,
                kind: "media",
                playing: index === playingIdx,
            });
            if (index === sel) selectedId = id;
        }
    } else if (session && channel === "streams" && sCatalog) {
        for (const entry of sCatalog.entries) {
            const id = `stream:${entry.name}`;
            items.push({
                id,
                label: entry.name.replace(/\.x$/, ""),
                detail: `${entry.channels === 2 ? "Stereo music" : "Voice"} · `
                    + `${entry.channels}ch · ${entry.rate} Hz · EXST`,
                duration: sDur(entry),
                kind: "media",
                playing: entry.name === sPlayingName,
            });
            if (entry.name === sPlayingName) selectedId = id;
        }
        selectedId ??= items[0]?.id ?? null;
    } else if (session && channel === "effects" && seCatalog) {
        for (const row of seRows) {
            if (row.kind === "bank") {
                const id = `effect-bank:${row.entry.name}`;
                items.push({
                    id,
                    label: row.entry.name,
                    detail: row.entry.name === seOpenBank && seShape
                        ? `${seShape.reduce((total, value) => total + value, 0)} requests`
                        : `${(row.entry.bytes / 1048576).toFixed(1)} MB bank`,
                    duration: null,
                    kind: "group",
                    playing: false,
                });
                if (seRows[seSel] === row) selectedId = id;
            } else {
                const id = `effect-cue:${row.entry.name}:${row.bank}:${row.request}`;
                const info = currentSeInfo(row);
                items.push({
                    id,
                    label: `${row.entry.name} · ${row.bank}:${row.request}`,
                    detail: info ? seDurationLabel(info) : "Sequenced effect request",
                    duration: info ? seEventFrames(info) / RATE : null,
                    kind: "media",
                    playing: sePlaying?.entry.name === row.entry.name
                        && sePlaying.bank === row.bank
                        && sePlaying.request === row.request,
                });
                if (seRows[seSel] === row) selectedId = id;
            }
        }
        selectedId ??= items[0]?.id ?? null;
    } else if (session && channel === "cinema" && movie.catalog) {
        for (const entry of movie.catalog.entries) {
            const id = `movie:${entry.name}`;
            items.push({
                id,
                label: entry.label,
                detail: `${entry.video.width}×${entry.video.height} · ${movieScanLabel(entry, false)}`
                    + `${entry.subtitleCues ? ` · ${entry.subtitleCues} captions` : ""}`,
                duration: entry.duration,
                kind: "media",
                playing: entry.name === movie.entry?.name && movie.playing,
                group: movieGroupLabel(entry),
            });
            if (entry.name === movie.entry?.name) selectedId = id;
        }
        selectedId ??= items[0]?.id ?? null;
    }

    const statusElement = $("status");
    return {
        revision: viewerRevision,
        connected: session !== null,
        channel,
        discLabel: session ? session.serial ?? session.volumeId : "",
        status: channel === "cinema" ? movie.status : statusElement.textContent ?? "",
        error: channel === "cinema" ? movie.error : statusElement.classList.contains("err"),
        items,
        selectedId,
        counts: {
            music: session?.songs.length ?? null,
            streams: sCatalog?.entries.length ?? null,
            effects: seCatalog?.entries.length ?? null,
            cinema: movie.catalog?.entries.length ?? null,
        },
    };
}

export function viewerSetup(): ViewerSetup | null {
    const movie = movieController.snapshot();
    if (session && viewerChannel === "cinema" && !movie.catalog) {
        return {
            label: "Reconnect the movie archive",
            detail: movie.status || (movie.hasIso
                ? "Scan the attached disc for its 22 local movies."
                : "Choose the same disc once to index its movie archive."),
            progress: movie.loading ? movie.progress : null,
        };
    }
    if (session && viewerChannel === "cinema") return null;
    let label: string;
    let detail: string;
    let progressElement: HTMLProgressElement;
    if (!session) {
        label = "Tune in with your Ape Escape 3 disc";
        detail = $("picker-status").textContent
            || "Choose the disc image. Extraction stays inside this browser.";
        progressElement = $<HTMLProgressElement>("picker-progress");
    } else if (viewerChannel === "streams" && !sCatalog) {
        label = "Scan the stream archive";
        detail = $("s-setup-status").textContent
            || (session.streams.hasIso()
                ? "The local disc is ready to scan."
                : "Reconnect the same disc once to scan streamed audio.");
        progressElement = $<HTMLProgressElement>("s-progress");
    } else if (viewerChannel === "effects" && !seCatalog) {
        label = "Scan the effects archive";
        detail = $("se-setup-status").textContent
            || (session.se.hasIso()
                ? "The local disc is ready to scan."
                : "Reconnect the same disc once to scan sound-effect banks.");
        progressElement = $<HTMLProgressElement>("se-progress");
    } else {
        return null;
    }
    const progress = progressElement.hidden
        ? null
        : progressElement.value / Math.max(progressElement.max, 1);
    return { label, detail, progress };
}

function viewerCanExport(): boolean {
    if (!session) return false;
    if (viewerChannel === "cinema") {
        const movie = movieController.snapshot();
        return !!movie.entry && !movie.loading && !movie.exporting;
    }
    if (tab === "bgm")
        return !loading && playingIdx >= 0 && sel === playingIdx
            && session.songs[playingIdx] !== undefined;
    if (tab === "streams") {
        const stream = sPlayer.decoded();
        return !sLoading && stream !== null && stream.name === sPlayingName;
    }
    const selected = seRows[seSel];
    return !seLoading && selected?.kind === "cue" && sePlaying !== null
        && sameSeRow(selected, sePlaying);
}

export function viewerTransport(): ViewerTransport {
    let title = "";
    let current = 0;
    let duration = 0;
    let isPlaying = false;
    let isLoading = false;
    const movie = movieController.snapshot();
    if (viewerChannel === "cinema") {
        title = movie.entry?.label ?? "";
        current = movie.current;
        duration = movie.duration;
        isPlaying = movie.playing;
        isLoading = movie.loading || movie.cancellable && !movie.exporting;
    } else if (tab === "bgm") {
        title = session?.songs[playingIdx >= 0 ? playingIdx : sel]?.name ?? "";
        current = displaySample() / RATE;
        duration = (timeline?.lenSamp ?? 0) / RATE;
        isPlaying = audioMode === "bgm" && !!player?.snap?.playing;
        isLoading = loading;
    } else if (tab === "streams") {
        title = sPlayingName?.replace(/\.x$/, "") ?? "";
        current = sPlayer.pos();
        duration = sPlayer.dur();
        isPlaying = sPlayer.playing();
        isLoading = sLoading || sExtracting;
    } else {
        title = sePlaying
            ? `${sePlaying.entry.name} · ${sePlaying.bank}:${sePlaying.request}`
            : "";
        const frame = audioMode === "se" ? (player?.snap?.pos ?? 0) : 0;
        current = seDisplayFrame(frame, currentSeInfo()) / RATE;
        duration = sePlaying ? seSeekDomain() / RATE : 0;
        isPlaying = audioMode === "se" && !!player?.snap?.playing;
        isLoading = seLoading || seExtracting;
    }
    return {
        title,
        current,
        duration,
        progress: duration > 0 ? Math.min(current / duration, 1) : 0,
        playing: isPlaying,
        loading: isLoading,
        canExport: viewerCanExport(),
        exporting: viewerChannel === "cinema"
            ? movie.exporting : exporter.busy || sBusy || seBusy,
        status: viewerChannel === "cinema"
            ? movie.status : $("status").textContent ?? "",
        error: viewerChannel === "cinema"
            ? movie.error : $("status").classList.contains("err"),
    };
}


export function viewerMeterLevels(target: Float32Array): boolean {
    target.fill(0);
    if (!session) return false;
    if (viewerChannel === "cinema") return false;
    if (tab === "streams") {
        const stream = sPlayer.decoded();
        if (!stream) return false;
        const channels = stream.header.channels;
        const frames = Math.floor(stream.pcm.length / channels);
        const end = Math.max(1, Math.min(frames, Math.floor(sPlayer.pos() * stream.header.rate)));
        const start = Math.max(0, end - Math.floor(stream.header.rate * 0.08));
        for (let bar = 0; bar < target.length; bar++) {
            const from = Math.floor(start + (end - start) * bar / target.length);
            const to = Math.max(from + 1,
                Math.floor(start + (end - start) * (bar + 1) / target.length));
            let peak = 0;
            for (let frame = from; frame < Math.min(to, frames); frame++) {
                for (let channel = 0; channel < channels; channel++)
                    peak = Math.max(peak, Math.abs(stream.pcm[frame * channels + channel]!));
            }
            target[bar] = Math.sqrt(peak / 32768);
        }
        return true;
    }
    for (let bar = 0; bar < target.length; bar++) {
        const offset = Math.floor(bar * VIEWER_LEVEL_COUNT / target.length);
        target[bar] = viewerLevelHistory[(viewerLevelHead + offset) % VIEWER_LEVEL_COUNT]!;
    }
    return tab === "se" ? sePlaying !== null : timeline !== null;
}

export function viewerSwitchChannel(channel: ViewerChannel): void {
    viewerChannel = channel;
    movieController.setActive(channel === "cinema");
    if (channel === "cinema") return;
    if (channel === "music") switchTab("bgm");
    else if (channel === "streams") switchTab("streams");
    else switchTab("se");
}


export function viewerActivate(id: string): void {
    if (!session) return;
    if (id.startsWith("music:")) {
        const index = Number(id.slice(6));
        if (!Number.isInteger(index) || !session.songs[index]) return;
        sel = index;
        renderList();
        void loadSong(index, true);
        return;
    }
    if (id.startsWith("stream:")) {
        const name = id.slice(7);
        const entry = sCatalog?.entries.find((candidate) => candidate.name === name);
        if (entry) void loadStreamEntry(entry, true);
        return;
    }
    if (id.startsWith("movie:")) {
        movieController.select(id.slice(6), "play");
        return;
    }
    const index = seRows.findIndex((row) => id === (row.kind === "bank"
        ? `effect-bank:${row.entry.name}`
        : `effect-cue:${row.entry.name}:${row.bank}:${row.request}`));
    if (index < 0) return;
    seSel = index;
    void seActivate(index, seRows[index]!.kind === "cue");
}

export function viewerMove(direction: number): void {
    if (viewerChannel === "cinema") {
        movieController.move(direction, "preview");
        return;
    }
    const library = viewerLibrary();
    if (!library.items.length) return;
    const selected = library.items.findIndex((item) => item.id === library.selectedId);
    const index = (Math.max(selected, 0) + direction + library.items.length)
        % library.items.length;
    viewerActivate(library.items[index]!.id);
}

export function viewerMoveAndPlayMovie(direction: number): void {
    if (viewerChannel === "cinema") {
        movieController.move(direction, "play");
        return;
    }
    viewerMove(direction);
}

export function viewerTogglePlayback(): void {
    if (viewerChannel === "cinema") {
        movieController.togglePlayback();
        return;
    }
    if (tab === "streams") sTogglePlay();
    else if (tab === "se") seTogglePlay();
    else togglePlay();
}

export function viewerSeek(ratio: number): void {
    const clamped = Math.max(0, Math.min(ratio, 1));
    if (viewerChannel === "cinema") {
        movieController.seek(clamped);
    } else if (tab === "streams") {
        if (sPlayer.decoded()) sPlayer.seek(clamped * sPlayer.dur());
    } else if (tab === "se") {
        seekSe(clamped * seSeekDomain());
    } else if (timeline) {
        seekTimeline(clamped * timeline.lenSamp);
    }
}

export function viewerExport(): void {
    const state = viewerTransport();
    if (!state.canExport || state.exporting) return;
    if (viewerChannel === "cinema") {
        const movie = movieController.snapshot();
        movieController.startExport("mp4", (movie.entry?.subtitleCues ?? 0) > 0);
    } else if (tab === "streams") void sExport();
    else if (tab === "se") void exportSeCue(false);
    else void exportWav("current");
}

async function attachMovieIso(file: File): Promise<void> {
    try {
        await movieController.attachIso(file);
    } catch (error) {
        movieController.reportError(friendlyError(error));
    }
}

export function viewerChooseDisc(): void {
    if (!session) {
        $<HTMLInputElement>("file").click();
    } else if (viewerChannel === "cinema") {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".iso,application/x-iso9660-image";
        input.onchange = () => {
            const file = input.files?.[0];
            input.remove();
            if (file) void attachMovieIso(file);
        };
        input.click();
    } else if (tab === "streams" && !sCatalog) {
        if (session.streams.hasIso()) void extractStreams();
        else $<HTMLInputElement>("s-iso").click();
    } else if (tab === "se" && !seCatalog) {
        if (session.se.hasIso()) void extractSeBanks();
        else $<HTMLInputElement>("se-iso").click();
    }
}

/* ---- app states --------------------------------------------------------- */
async function performDiscReset(): Promise<void> {
    const audio = player;
    session = null;
    player = null;
    playerReady = null;
    playerGeneration++;
    audio?.pause();
    sPlayer.stop();
    sDecoder.dispose();
    seInspector.dispose();
    exporter.dispose();

    timeline = null;
    viz = null;
    seViz = null;
    seSequenceViz = null;
    seSourceLoopViz = null;
    audioMode = null;
    sel = 0;
    playingIdx = -1;
    loading = false;
    finished = false;
    bgmDurations = new Float64Array();
    bgmDurationWarning = null;

    sCatalog = null;
    streamCatalogRequest = null;
    sRows = [];
    sFolded.clear();
    sFoldInit = false;
    sSel = 0;
    sPlayingName = null;
    sLoading = false;
    sBusy = false;
    sExtracting = false;
    sViz = null;

    seCatalog = null;
    seCatalogRequest = null;
    seRows = [];
    seSel = 0;
    seBusy = false;
    seOpenBank = null;
    seShape = null;
    seDetails = null;
    seLoading = false;
    seExtracting = false;
    sePlaying = null;
    sePlayingInfo = null;
    seKnownFrames = null;
    seKnownEstimated = false;
    seMeasureError = null;
    seMeasuring = false;
    seMeasureToken++;

    imageCatalog = null;
    renderSkippedImageMembers(null);
    imageCatalogRequest = null;
    imageAllRows = [];
    imageRows = [];
    imageEntryById.clear();
    imageSelected = null;
    imageExtracting = false;
    imageExporting = false;
    imageLoadGeneration++;
    imageRenderGeneration++;
    imageListObserver?.disconnect();
    imageThumbnailObserver?.disconnect();
    imageThumbnailQueue = [];
    imageThumbnailActive = 0;

    fmvRenderedRevision = -1;
    fmvAttachedRevision = -1;
    fmvVisibleNames = [];
    fmvRenderedEntryName = null;
    modelBrowser?.setStore(null);
    stagePreviewBrowser?.dispose();
    stagePreviewBrowser = null;
    tab = "bgm";
    viewerChannel = "music";
    viewerRevision++;

    $("app").hidden = true;
    $("picker").hidden = false;
    await Promise.all([
        movieController.dispose(),
        audio && audio.ctx.state !== "closed"
            ? audio.ctx.close().catch(error => {
                console.error("audio context close failed during disc reset", error);
            })
            : Promise.resolve(),
    ]);
}

function resetDiscBoundState(): Promise<void> {
    return discCleanup.run(performDiscReset);
}

async function enterPlayer(s: DiscSession, ticket: DiscOpenTicket): Promise<void> {
    const isCurrent = (): boolean => discOpens.isCurrent(ticket);
    if (!isCurrent()) return;
    await movieController.connect(s, isCurrent);
    if (!isCurrent()) return;
    session = s;
    modelBrowser?.setStore(s.models);
    stagePreviewBrowser?.setStore(s.stagePreviews);
    $("picker").hidden = true;
    $("app").hidden = false;
    $("disc-id").textContent =
        s.cached ? (s.serial ?? s.volumeId) : `${s.serial ?? s.volumeId} (no cache)`;
    bgmDurations = new Float64Array(s.songs.length);
    bgmDurationWarning = null;
    bgmDurations.fill(Number.NaN);
    renderList();
    void loadBgmDurations(s);
    renderDials();
    viz = new Viz($<HTMLCanvasElement>("roll"), $<HTMLCanvasElement>("slots"),
                  $<HTMLCanvasElement>("wave"));
    seViz = new Viz($<HTMLCanvasElement>("se-null"),
                    $<HTMLCanvasElement>("se-slots"),
                    $<HTMLCanvasElement>("se-wave"));
    seSequenceViz = new SeSequenceViz($<HTMLCanvasElement>("se-events"));
    seSourceLoopViz = new SeSourceLoopViz(
        $<HTMLCanvasElement>("se-source-loops"));
    /* no audio yet: the whole stack is built inside the first click/key
     * (ensurePlayer) so Safari associates the AudioContext with a gesture */
    $<HTMLButtonElement>("playbtn").disabled = false;
    const region = discSupportWarning(s.serial);
    const persistence = s.persistenceWarning ? ` - ${s.persistenceWarning}` : "";
    status(
        `${session.songs.length} songs - SPACE or click one to play${region}${persistence}`,
        s.persistenceWarning !== null,
    );
    requestAnimationFrame(tick);
}

function wirePicker(): void {
    const drop = $("drop");
    const input = $<HTMLInputElement>("file");
    const pstat = $("picker-status");
    const bar = $<HTMLProgressElement>("picker-progress");

    async function open(file: File): Promise<void> {
        const ticket = discOpens.begin();
        pstat.classList.remove("err");
        pstat.textContent = "reading disc...";
        bar.hidden = false;
        bar.value = 0;
        try {
            await resetDiscBoundState();
            if (!discOpens.isCurrent(ticket)) return;
            const next = await openIso(file, (done, total, name) => {
                if (!discOpens.isCurrent(ticket)) return;
                bar.value = total > 0 ? done / total : 0;
                pstat.textContent = `extracting ${name} (${done}/${total})`;
            }, ticket.signal);
            ticket.signal.throwIfAborted();
            if (!discOpens.isCurrent(ticket)) return;
            await enterPlayer(next, ticket);
        } catch (error) {
            if (!discOpens.isCurrent(ticket) || ticket.signal.aborted) return;
            pstat.textContent = friendlyError(error);
            pstat.classList.add("err");
            bar.hidden = true;
        } finally {
            if (discOpens.isCurrent(ticket)) input.value = "";
            discOpens.complete(ticket);
        }
    }

    input.onchange = () => { if (input.files?.[0]) void open(input.files[0]); };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        const f = e.dataTransfer?.files[0];
        if (f) void open(f);
    };
}

/* ?selftest -- boot the whole audio path with no disc and report each step
 * in the status line AND document.title (readable by accessibility tools).
 * Diagnoses "the play button does nothing": content blocker eating the
 * worklet/wasm vs the browser refusing to start audio (autoplay policy). */
async function selftest(): Promise<void> {
    $("picker").hidden = true;
    $("app").hidden = false;
    const out: string[] = [];
    const put = (s: string): void => {
        out.push(s);
        const line = out.join(" | ");
        status(line, /FAIL|blocked/.test(line));
        document.title = line;
    };
    $("song-name").textContent = "audio self-test";
    const btn = $<HTMLButtonElement>("playbtn");
    btn.disabled = false;
    btn.onclick = async () => {         /* the app's real path: create the
                                         * whole stack inside the gesture */
        put("click:yes");
        try {
            const p = await ensurePlayer();
            put("setup:ok");
            put(`ctx:${p.ctx.state}`);
            setTimeout(() => put(`after-click:${p.ctx.state}`), 800);
        } catch (e) {
            put(`setup:FAIL ${friendlyError(e)}`);
        }
    };
    put("press-play-to-test-audio-unlock");
}

function applySideWidth(requested: number, persist = false): void {
    const max = Math.max(MIN_SIDE_WIDTH, Math.min(720, window.innerWidth - 480));
    sideWidth = Math.round(Math.max(MIN_SIDE_WIDTH, Math.min(max, requested)));
    document.documentElement.style.setProperty("--side-width", `${sideWidth}px`);
    const handle = $("side-resizer");
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.setAttribute("aria-valuenow", String(sideWidth));
    if (persist) localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth));
}

function wireSideResizer(): void {
    const handle = $("side-resizer");
    const saved = Number.parseFloat(localStorage.getItem(SIDE_WIDTH_KEY) ?? "");
    applySideWidth(Number.isFinite(saved) ? saved : DEFAULT_SIDE_WIDTH);
    let pointerId: number | null = null;
    let grabOffset = 0;

    handle.onpointerdown = event => {
        if (event.button !== 0) return;
        pointerId = event.pointerId;
        grabOffset = event.clientX - handle.getBoundingClientRect().left;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing-sidebar");
        event.preventDefault();
    };
    handle.onpointermove = event => {
        if (event.pointerId !== pointerId) return;
        const appLeft = $("app").getBoundingClientRect().left;
        applySideWidth(event.clientX - appLeft - grabOffset);
    };
    const finish = (event: PointerEvent): void => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        document.body.classList.remove("resizing-sidebar");
        applySideWidth(sideWidth, true);
    };
    handle.onpointerup = finish;
    handle.onpointercancel = finish;
    handle.ondblclick = () => applySideWidth(DEFAULT_SIDE_WIDTH, true);
    handle.onkeydown = event => {
        let next = sideWidth;
        if (event.key === "ArrowLeft") next -= event.shiftKey ? 64 : 24;
        else if (event.key === "ArrowRight") next += event.shiftKey ? 64 : 24;
        else if (event.key === "Home") next = MIN_SIDE_WIDTH;
        else if (event.key === "End") next = 720;
        else return;
        event.preventDefault();
        applySideWidth(next, true);
    };
    window.addEventListener("resize", () => {
        if (window.innerWidth > 600) applySideWidth(sideWidth);
    });
}

async function main(): Promise<void> {
    /* diagnostics handle (dev tools) */
    (window as any).__ae3 = {
        get player() { return player; },
        get timeline() { return timeline; },
        get state() {
            return { sel, playingIdx, loading, finished, authored, cfg };
        },
        get sPlayer() { return sPlayer; },
        get sState() {
            return { tab, sSel, sPlayingName, sLoading, sTrim, sBusy,
                     rows: sRows.length, folded: sFolded.size };
        },
        get seState() {
            return { seSel, seOpenBank, seLoading, seBusy, sePlaying,
                     rows: seRows.length, shape: seShape && [...seShape] };
        },
        get imageState() {
            return { catalog: imageCatalog, selected: imageSelected,
                     rows: imageRows.length, visible: imageVisibleLimit,
                     view: imageViewMode,
                     role: $<HTMLSelectElement>("image-role").value,
                     sort: imageSortDirection,
                     thumbnails: imageThumbnailCache.size,
                     extracting: imageExtracting, exporting: imageExporting };
        },
        get stagePreviewState() { return stagePreviewBrowser?.snapshot() ?? null; },
    };
    wirePicker();
    wireSideResizer();
    $("playbtn").onclick = togglePlay;
    $("bar").onclick = (e) => {
        if (!timeline) return;
        const r = $("bar").getBoundingClientRect();
        seekTimeline((e.clientX - r.left) / r.width * timeline.lenSamp);
    };
    /* streams tab */
    keysBgmText = $("keys").textContent ?? "";
    $("tab-bgm").onclick = () => switchTab("bgm");
    $("tab-streams").onclick = () => switchTab("streams");
    $("tab-se").onclick = () => switchTab("se");
    $("tab-fmv").onclick = () => switchTab("fmv");
    $("tab-images").onclick = () => switchTab("images");
    $("tab-stage-previews").onclick = () => switchTab("stage-previews");
    $("tab-models").onclick = () => switchTab("models");
    $("imagelist").addEventListener("click", event => {
        const target = event.target as Element;
        const button = target.closest<HTMLButtonElement>("[data-image-id]");
        const entry = imageEntryById.get(button?.dataset.imageId ?? "");
        if (entry) void selectImage(entry);
    });
    $<HTMLInputElement>("image-search").oninput = () => {
        imageVisibleLimit = imageViewMode === "grid" ? 120 : 300;
        $("imagelist").scrollTop = 0;
        renderImageList();
    };
    $<HTMLSelectElement>("image-role").onchange = () => {
        imageVisibleLimit = imageViewMode === "grid" ? 120 : 300;
        $("imagelist").scrollTop = 0;
        renderImageList();
    };
    $("image-sort").onclick = () => {
        imageSortDirection = imageSortDirection === "asc" ? "desc" : "asc";
        imageVisibleLimit = imageViewMode === "grid" ? 120 : 300;
        $("imagelist").scrollTop = 0;
        updateImageSortButton();
        renderImageList();
    };
    updateImageSortButton();
    $("image-view-switch").addEventListener("click", event => {
        const button = (event.target as Element)
            .closest<HTMLButtonElement>("[data-image-view]");
        if (!button) return;
        imageViewMode = button.dataset.imageView as ImageViewMode;
        imageVisibleLimit = imageViewMode === "grid" ? 120 : 300;
        for (const option of $("image-view-switch")
            .querySelectorAll<HTMLButtonElement>("[data-image-view]"))
            option.setAttribute("aria-pressed",
                                String(option.dataset.imageView === imageViewMode));
        $("imagelist").scrollTop = 0;
        renderImageList();
    });
    $("image-extract").onclick = () => void extractImages();
    $<HTMLInputElement>("image-iso").onchange = async () => {
        const input = $<HTMLInputElement>("image-iso");
        const file = input.files?.[0];
        if (!file || !session) return;
        const target = session;
        const setupStatus = $("image-setup-status");
        setupStatus.classList.remove("err");
        setupStatus.textContent = "reading disc...";
        try {
            await target.images.attachIso(file);
            if (session !== target) return;
            $("image-iso-pick").hidden = true;
            await extractImages();
        } catch (error) {
            if (session !== target) return;
            setupStatus.textContent = friendlyError(error);
            setupStatus.classList.add("err");
        } finally {
            input.value = "";
        }
    };
    $("image-export-png").onclick = () => void exportSelectedImage("png");
    $("image-export-tm2").onclick = () => void exportSelectedImage("tm2");
    $("image-export-all").onclick = () => void exportAllImages();
    $("fmvlist").addEventListener("click", event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-fmv-name]");
        if (button?.dataset.fmvName)
            movieController.select(button.dataset.fmvName, "play");
    });
    $<HTMLInputElement>("fmv-search").oninput = () =>
        renderFmvList(movieController.snapshot());
    $<HTMLInputElement>("fmv-iso").onchange = async () => {
        const input = $<HTMLInputElement>("fmv-iso");
        const file = input.files?.[0];
        if (!file) return;
        try {
            await attachMovieIso(file);
        } finally {
            input.value = "";
        }
    };
    $("fmv-prev").onclick = () => moveFmv(-1, "play");
    $("fmv-play").onclick = () => movieController.togglePlayback();
    $("fmv-next").onclick = () => moveFmv(1, "play");
    $("fmv-bar").onclick = event => {
        const rect = $("fmv-bar").getBoundingClientRect();
        movieController.seek((event.clientX - rect.left) / rect.width);
    };
    $("fmv-cc").onclick = () => movieController.toggleCaptions();
    $("fmv-fullscreen").onclick = toggleFmvFullscreen;
    $("fmv-picture").ondblclick = event => {
        if (!(event.target as Element).closest("button")) toggleFmvFullscreen();
    };
    document.querySelectorAll<HTMLButtonElement>("[data-fmv-export]")
        .forEach(button => {
            button.onclick = () => movieController.startExport(
                button.dataset.fmvExport as MovieExportKind,
                $<HTMLInputElement>("fmv-export-captions").checked,
            );
        });
    $("fmv-cancel").onclick = () => movieController.cancel();
    $("fmv-remove-cache").onclick = () => movieController.removeCached();
    document.addEventListener("fullscreenchange", () => {
        fmvAttachedRevision = -1;
        const movie = movieController.snapshot();
        if (tab === "fmv" && movie.prepared)
            movieController.attach($<HTMLCanvasElement>("fmv-canvas"));
    });
    $("s-playbtn").onclick = sTogglePlay;
    $("s-trim").onclick = sToggleTrim;
    $("s-exportbtn").onclick = () => void sExport();
    $("s-rawbtn").onclick = () => void sExportRaw();
    sViz = new StreamViz($<HTMLCanvasElement>("s-wave"),
                         $<HTMLCanvasElement>("s-spec"));
    const sSeek = (el: HTMLElement) => (e: MouseEvent) => {
        if (!sPlayer.decoded()) return;
        const r = el.getBoundingClientRect();
        sPlayer.seek((e.clientX - r.left) / r.width * sPlayer.dur());
    };
    $("s-bar").onclick = sSeek($("s-bar"));
    $("s-wave").onclick = sSeek($("s-wave"));
    $("s-spec").onclick = sSeek($("s-spec"));
    $("stream-search").oninput = () => renderStreamList();
    $("s-extract").onclick = () => void extractStreams();
    $<HTMLInputElement>("s-iso").onchange = async () => {
        const f = $<HTMLInputElement>("s-iso").files?.[0];
        if (!f || !session) return;
        const target = session;
        const pstat = $("s-setup-status");
        pstat.classList.remove("err");
        pstat.textContent = "reading disc...";
        try {
            await target.streams.attachIso(f);
            if (session !== target) return;
            $("s-iso-pick").hidden = true;
            await extractStreams();
        } catch (error) {
            if (session !== target) return;
            pstat.textContent = friendlyError(error);
            pstat.classList.add("err");
        }
    };
    /* embedded SE tab */
    $("se-playbtn").onclick = seTogglePlay;
    $("se-vol").onclick = () => setSeVolume(64);
    $("se-loop").onclick = seToggleLoop;
    $("se-timing").onclick = seToggleExact;
    $("se-kernel").onclick = seToggleKernel;
    $("se-rev").onclick = seToggleReverb;
    $("se-bar").onclick = (e) => {
        const domain = seSeekDomain();
        if (domain > SE_SEEK_LIMIT) {
            status("Audio seek is capped at five minutes for this long-lived source; click the event score to seek its commands");
            return;
        }
        const rect = $("se-bar").getBoundingClientRect();
        seekSe((e.clientX - rect.left) / rect.width * domain);
    };
    $("se-events").onclick = (e) => {
        const frame = seSequenceViz?.frameAt(e.clientX);
        if (frame !== null && frame !== undefined) seekSe(frame);
    };
    $("se-exportbtn").onclick = (e) => {
        e.stopPropagation();
        showExportMenu(false);
        showBankMenu(false);
        if (!exporter.busy) showSeExportMenu(!!$("se-export-menu").hidden);
    };
    $("se-export-menu").onclick = (e) => e.stopPropagation();
    $("se-ex-once").onclick = () => void exportSeCue(false);
    $("se-ex-10").onclick = () => void exportSeCue(true, 10);
    $("se-ex-30").onclick = () => void exportSeCue(true, 30);
    $("se-ex-60").onclick = () => void exportSeCue(true, 60);
    $("se-bankbtn").onclick = () => void exportSeBank();
    $("se-search").oninput = () => renderSeList();
    $("se-extract").onclick = () => void extractSeBanks();
    $<HTMLInputElement>("se-iso").onchange = async () => {
        const input = $<HTMLInputElement>("se-iso");
        const file = input.files?.[0];
        if (!file || !session) return;
        const target = session;
        const setupStatus = $("se-setup-status");
        setupStatus.classList.remove("err");
        setupStatus.textContent = "reading disc...";
        try {
            await target.se.attachIso(file);
            if (session !== target) return;
            $("se-iso-pick").hidden = true;
            await extractSeBanks();
        } catch (error) {
            if (session !== target) return;
            setupStatus.textContent = friendlyError(error);
            setupStatus.classList.add("err");
        }
    };
    renderSeDials();
    sPlayer.onended = () => { /* glyph flips via the tick loop */ };
    sPlayer.onerror = error => {
        status(`STREAM PLAYBACK FAILED: ${friendlyError(error)}`, true);
    };
    $("d-vol").onclick = () => {
        if (playingIdx >= 0 && session)
            setVol(session.songs[playingIdx]!.songvol, true);
    };
    $("d-loop").onclick = toggleLoop;
    $("d-timing").onclick = toggleTiming;
    $("d-kernel").onclick = toggleKernel;
    $("d-rev").onclick = () => setRev(cfg.revDepth > 0 ? 0 : 30);
    $("d-duck").onclick = toggleDuck;
    /* export dropdown (bgmplay's EXPORT WAV button + 3-row panel) */
    exporter.onstatus = (msg, err) => {
        status(msg, err);
        updateExportBtn();
        updateSeExportBtn();
    };
    $("exportbtn").onclick = (e) => {
        e.stopPropagation();
        showBankMenu(false);
        showSeExportMenu(false);
        if (!exporter.busy) showExportMenu(!!$("export-menu").hidden);
    };
    $("export-menu").onclick = (e) => e.stopPropagation();
    document.addEventListener("click", () => {
        showExportMenu(false);
        showBankMenu(false);
        showSeExportMenu(false);
    });
    $("ex-current").onclick = () => { showExportMenu(false); void exportWav("current"); };
    $("ex-authored").onclick = () => { showExportMenu(false); void exportWav("authored"); };
    $("ex-loop").onclick = () => { showExportMenu(false); void exportWav("loop"); };
    $("ex-dec").onclick = () => {
        if (loopN > 2) loopN--;
        $("ex-loopn").textContent = String(loopN);
    };
    $("ex-inc").onclick = () => {
        if (loopN < 99) loopN++;
        $("ex-loopn").textContent = String(loopN);
    };
    $("midibtn").onclick = () => void exportMidi();
    /* bank dropdown (raw pair / decoded sample kit) */
    $("bankbtn").onclick = (e) => {
        e.stopPropagation();
        showExportMenu(false);
        if (!exporter.busy) showBankMenu(!!$("bank-menu").hidden);
    };
    $("bank-menu").onclick = (e) => e.stopPropagation();
    $("bank-raw").onclick = () => { showBankMenu(false); void exportBank(); };
    $("bank-kit").onclick = () => { showBankMenu(false); void exportKit(); };
    /* help overlay (key H; click anywhere on it closes, like bgmplay) */
    $("helpbtn").onclick = (e) => { e.stopPropagation(); toggleHelp(); };
    $("help").onclick = () => toggleHelp(false);
    $("forget").onclick = async () => {
        if (!session) return;
        const target = session;
        player?.pause();
        try {
            stagePreviewBrowser?.dispose();
            await movieController.dispose();
            await target.forget();
            location.reload();
        } catch (error) {
            console.error("forget disc failed", error);
            const message = friendlyError(error);
            movieController.reportError(message);
            status(message, true);
        }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", () => {
        stagePreviewBrowser?.dispose();
        void movieController.dispose().catch((error) => {
            console.error("movie controller disposal failed", error);
        });
    });

    /* Offline after first visit: best-effort, and production-only. Development
     * serves no sw.js, and a stale worker would shadow the dev server. */
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
        const hadController = navigator.serviceWorker.controller !== null;
        let reloadingForUpdate = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (!hadController || reloadingForUpdate) return;
            reloadingForUpdate = true;
            location.reload();
        });
        void navigator.serviceWorker
            .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" })
            .then((registration) => {
                if (navigator.onLine)
                    void registration.update().catch((error) =>
                        console.warn("service worker update failed", error));
            })
            .catch((error) => console.warn("service worker registration failed", error));
    }

    if (new URLSearchParams(location.search).has("selftest"))
        return selftest();

    const resumeTicket = discOpens.begin();
    try {
        const resumed = await resumeSession();
        if (resumed && discOpens.isCurrent(resumeTicket))
            await enterPlayer(resumed, resumeTicket);
    } finally {
        discOpens.complete(resumeTicket);
    }
}

void main().catch(error => {
    console.error("application startup failed", error);
    const picker = document.getElementById("picker");
    const app = document.getElementById("app");
    if (picker) picker.hidden = false;
    if (app) app.hidden = true;
    const pickerStatus = document.getElementById("picker-status");
    if (!pickerStatus) return;
    pickerStatus.textContent = friendlyError(error);
    pickerStatus.classList.add("err");
});
