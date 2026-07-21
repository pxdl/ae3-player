/* App controller: picker <-> player states, transport, dials, visualizers,
 * export, help, keyboard. Port of the reference consumer's behavior (ae3-sdk
 * harness/bgmplay.c keys, defaults, layout). */

import "./style.css";
import { resumeSession, openIso, friendlyError, US_SERIAL,
         type DiscSession } from "./disc.ts";
import { WorkletPlayer, RATE, type EngineConfig, type Snapshot } from "./player.ts";
import { buildTimeline, displayPos, bpmOf, midiDurationSamples, type Timeline } from "./timeline.ts";
import { Viz } from "./viz.ts";
import { Exporter, download, type ExportOpts, type SeExportOpts } from "./export.ts";
import { storeZip } from "./zip.ts";
import { groupStreams, StreamDecoder, StreamPlayer,
         type StreamCatalog, type StreamEntry } from "./streams.ts";
import { StreamViz } from "./sviz.ts";
import { SeInspector, type SeBankEntry, type SeCatalog,
         type SeMeasureFiles, type SeRequestInfo } from "./se.ts";
import { SeSequenceViz, SeSourceLoopViz } from "./seviz.ts";
import type {
    MovieCacheInfo, MovieCatalog, MovieEntry, MovieExportKind,
} from "./movies.ts";

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

export interface ViewerMovieDetails {
    entry: MovieEntry | null;
    cache: MovieCacheInfo | null;
    prepared: boolean;
    hasIso: boolean;
    progress: number;
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
let audioMode: "bgm" | "se" | null = null;
let viewerRevision = 0;
const VIEWER_LEVEL_COUNT = 32;
const viewerLevelHistory = new Float32Array(VIEWER_LEVEL_COUNT);
let viewerLevelHead = 0;
let bgmDurations = new Float64Array();

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

/* streams tab (VIEWER_PLAN §2) */
let tab: "bgm" | "streams" | "se" = "bgm";
let sCatalog: StreamCatalog | null = null;
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

/* embedded sequenced effects */
type SeRow =
    | { kind: "bank"; entry: SeBankEntry }
    | { kind: "cue"; entry: SeBankEntry; bank: number; request: number };
let seCatalog: SeCatalog | null = null;
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


/* Cinema is a viewer-only channel. Its video element lives in viewer.ts while
 * this controller owns source selection, conversion, cache, and transport. */
let viewerChannel: ViewerChannel = "music";
let movieCatalog: MovieCatalog | null = null;
let movieSelectedName: string | null = null;
let moviePreparedName: string | null = null;
let movieVideo: HTMLVideoElement | null = null;
let movieVideoUrl: string | null = null;
let movieVttUrl: string | null = null;
let movieCache: MovieCacheInfo | null = null;
let movieLoading = false;
let movieExporting = false;
let movieProgress = 0;
let movieStatus = "";
let movieError = false;
let movieAbort: AbortController | null = null;
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
    for (let index = 0; index < target.songs.length; index++) {
        const song = target.songs[index]!;
        try {
            const midi = await target.read(`bgm/${song.mid}`);
            if (!midi) throw new Error(`missing bgm/${song.mid}`);
            durations[index] = midiDurationSamples(midi);
        } catch (error) {
            console.warn(`Could not calculate duration for ${song.name}`, error);
        }
    }
    if (session === target && bgmDurations === durations) renderList();
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

function ensurePlayer(): Promise<WorkletPlayer> {
    playerReady ??= WorkletPlayer.create().then((p) => {
        player = p;
        p.onended = () => { finished = true; };
        p.onerror = (m) => status(m, true);
        p.onsnapshot = (s) => {
            if (audioMode === "se") seViz?.ingest(s);
            else viz?.ingest(s);
            ingestViewerLevels(s);
        };
        return p;
    }, (e) => {
        playerReady = null;              /* allow a retry on the next click */
        $("song-name").textContent = "audio setup failed";
        throw new Error(`audio setup failed: `
            + `${e instanceof Error ? e.message : e}`
            + " -- an ad/content blocker may be blocking the synth");
    });
    return playerReady;
}

/* Only call from a user-gesture handler: the context is created and resumed
 * inside that gesture, and the load round-trip cannot complete while it is
 * suspended. */
async function loadSong(idx: number, autoplay: boolean): Promise<void> {
    if (!session || loading) return;
    const song = session.songs[idx];
    if (!song) return;
    let p: WorkletPlayer;
    try {
        p = await ensurePlayer();        /* sync up to the first await */
    } catch (e) {
        status(e instanceof Error ? e.message : String(e), true);
        return;
    }
    p.resume();
    sPlayer.pause();                    /* one thing plays at a time */
    loading = true;
    seSourceLoopViz?.clear();
    finished = false;
    status(`loading ${song.name}...`);
    try {
        const assets = await session.songAssets(song);
        if (authored) cfg.songvol = song.songvol;
        cfg.cueScale = song.volumeScale > 0 ? song.volumeScale : 44.5 / 127;
        const r = await p.load(assets, engineConfig());
        audioMode = "bgm";
        timeline = buildTimeline(r.events, r.ppqn);
        bgmDurations[idx] = timeline.lenSamp;
        playingIdx = idx;
        p.snap = null;
        viz?.clearWave();
        viewerLevelHistory.fill(0);
        viewerLevelHead = 0;
        $("song-name").textContent = song.name;
        $("time-len").textContent = fmtTime(timeline.lenSamp);
        status(r.warning ? `warning: ${r.warning}` : "", !!r.warning);
        if (autoplay) p.play();
        $<HTMLButtonElement>("playbtn").disabled = false;
    } catch (e) {
        status(friendlyError(e), true);
    } finally {
        loading = false;
        renderList();
        renderDials();
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

/* ---- streams tab (VIEWER_PLAN §2) ---------------------------------------- */
let keysBgmText = "";               /* captured from the DOM at boot */
const KEYS_STREAMS = "SPACE play · ↑↓ move · ←→ fold · ENTER load/fold "
    + "· T trim · E wav · X raw · H help · click bar/stage to seek";
const KEYS_SE = "SPACE play \u00B7 \u2191\u2193 move \u00B7 \u2190\u2192 fold \u00B7 ENTER load/fold "
    + "\u00B7 L stream loop/once \u00B7 - = volume \u00B7 T timing \u00B7 G kernel "
    + "\u00B7 R reverb \u00B7 E wav \u00B7 X bank \u00B7 click bar/score to seek \u00B7 H help";

const sDur = (e: StreamEntry): number =>
    e.sectors * (2048 / e.channels / 16 * 28) / e.rate;

function fmtSec(t: number): string {
    const m = Math.floor(Math.max(0, t) / 60);
    const s = Math.max(0, t) - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function switchTab(t: "bgm" | "streams" | "se"): void {
    if (t !== "se") seSourceLoopViz?.clear();
    tab = t;
    $("tab-bgm").classList.toggle("on", t === "bgm");
    $("tab-streams").classList.toggle("on", t === "streams");
    $("tab-se").classList.toggle("on", t === "se");
    $("songlist").hidden = t !== "bgm";
    $("streamview").hidden = t !== "streams";
    $("seview").hidden = t !== "se";
    $("head").hidden = t !== "bgm";
    $("bar").hidden = t !== "bgm";
    $("stage").hidden = t !== "bgm";
    $("foot-stats").hidden = t === "streams";
    $("stream-main").hidden = t !== "streams";
    $("se-main").hidden = t !== "se";
    $("keys").textContent =
        t === "bgm" ? keysBgmText : t === "streams" ? KEYS_STREAMS : KEYS_SE;
    status("");
    viewerRevision++;
    if (t === "streams") void ensureStreams();
    if (t === "se") void ensureSeCatalog();
}

/* First entry to the tab: catalog from OPFS, or the setup panel. */
async function ensureStreams(): Promise<void> {
    if (!session || sCatalog) return;
    const c = await session.streams.cached();
    if (c) {
        sCatalog = c;
        $("s-setup").hidden = true;
        $("s-stage").hidden = false;
        renderStreamList();
        status(`${c.entries.length} streams - SPACE or click one to play`);
        return;
    }
    $("s-setup").hidden = false;
    const iso = session.streams.hasIso();
    $("s-extract").hidden = !iso;
    $("s-iso-pick").hidden = iso;
    if (iso) await extractStreams();
}

async function extractStreams(): Promise<void> {
    if (!session || sExtracting) return;
    const pstat = $("s-setup-status");
    const bar = $<HTMLProgressElement>("s-progress");
    pstat.classList.remove("err");
    bar.hidden = false;
    bar.value = 0;
    $<HTMLButtonElement>("s-extract").disabled = true;
    sExtracting = true;
    try {
        sCatalog = await session.streams.extract((done, total, name) => {
            bar.value = total > 0 ? done / total : 0;
            pstat.textContent = `extracting ${name} (${done}/${total})`;
        });
        $("s-setup").hidden = true;
        $("s-stage").hidden = false;
        renderStreamList();
        status(`${sCatalog.entries.length} streams - SPACE or click one to play`);
    } catch (e) {
        pstat.textContent = friendlyError(e);
        pstat.classList.add("err");
        bar.hidden = true;
    } finally {
        $<HTMLButtonElement>("s-extract").disabled = false;
        sExtracting = false;
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
    if (!session || sLoading) return;
    sLoading = true;
    status(`loading ${e.name}...`);
    try {
        const bytes = await session.streams.read(e.name);
        if (!bytes)
            throw new Error(`missing stream ${e.name} -- re-extract, or `
                            + "re-open the ISO");
        const d = await sDecoder.decode(e.name, bytes);
        sPlayer.load(d, sTrim);
        sPlayingName = e.name;
        sViz?.set(d, sTrim);
        $("s-name").textContent = e.name.replace(/\.x$/, "");
        $("s-len").textContent = fmtSec(sPlayer.dur());
        renderStreamInfo();
        updateSBarPad();
        $<HTMLButtonElement>("s-playbtn").disabled = false;
        $<HTMLButtonElement>("s-exportbtn").disabled = false;
        $<HTMLButtonElement>("s-rawbtn").disabled = false;
        status("");
        if (autoplay) {
            player?.pause();            /* one thing plays at a time */
            sPlayer.play();
        }
    } catch (err) {
        status(friendlyError(err), true);
    } finally {
        sLoading = false;
        renderStreamList();
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
    if (!session) return;
    const d = sPlayer.decoded();
    if (!d) return;
    try {
        const bytes = await session.streams.read(d.name);
        if (!bytes)
            throw new Error(`missing stream ${d.name} -- re-extract, or `
                            + "re-open the ISO");
        download(bytes, d.name, "application/octet-stream");
        status(`EXPORTED ${d.name}`);
    } catch (e) {
        status(`EXPORT FAILED: ${e instanceof Error ? e.message : e}`, true);
    }
}

async function sExport(): Promise<void> {
    if (!session || sBusy) return;
    const d = sPlayer.decoded();
    if (!d) return;
    sBusy = true;
    const stemName = d.name.replace(/\.x$/, "");
    const file = `${stemName}${sTrim ? "_trim" : ""}.wav`;
    const btn = $<HTMLButtonElement>("s-exportbtn");
    btn.disabled = true;
    btn.textContent = "EXPORTING";
    status(`EXPORTING ${file}...`);
    try {
        const bytes = await session.streams.read(d.name);
        if (!bytes)
            throw new Error(`missing stream ${d.name}`);
        const wav = await sDecoder.wav(d.name, bytes, sTrim);
        download(wav, file, "audio/wav");
        status(`EXPORTED ${file}`);
    } catch (e) {
        status(`EXPORT FAILED: ${e instanceof Error ? e.message : e}`, true);
    } finally {
        sBusy = false;
        btn.disabled = !sPlayer.decoded();
        btn.textContent = "EXPORT WAV";
    }
}

/* ---- embedded SE tab --------------------------------------------------- */
function seSetup(show: boolean, needsIso = false): void {
    $("se-setup").hidden = !show;
    $("se-stage").hidden = show;
    $("se-extract").hidden = needsIso;
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

async function ensureSeCatalog(): Promise<boolean> {
    if (!session) return false;
    const meta = await session.se.cached();
    if (!meta) {
        const needsIso = !session.se.hasIso();
        seSetup(true, needsIso);
        if (!needsIso) {
            await extractSeBanks();
            return seCatalog !== null;
        }
        return false;
    }
    seCatalog = meta;
    seSetup(false);
    renderSeList();
    return true;
}
async function extractSeBanks(): Promise<void> {
    if (!session || seExtracting) return;
    const btn = $<HTMLButtonElement>("se-extract");
    const st = $("se-setup-status");
    const progress = $<HTMLProgressElement>("se-progress");
    btn.disabled = true;
    progress.hidden = false;
    st.classList.remove("err");
    seExtracting = true;
    try {
        seCatalog = await session.se.extract((done, total, name) => {
            progress.max = total;
            progress.value = done;
            st.textContent = `extracting ${done}/${total}: ${name}`;
        });
        st.textContent = `${seCatalog.entries.length} SE banks ready`;
        seSetup(false);
        renderSeList();
        status(`${seCatalog.entries.length} SE banks cached`);
    } catch (e) {
        st.textContent = friendlyError(e);
        st.classList.add("err");
    } finally {
        btn.disabled = false;
        seExtracting = false;
        progress.hidden = true;
    }
}

async function seActivate(i: number, play: boolean): Promise<void> {
    if (!session || seLoading) return;
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
        const files = await session.se.bank(row.entry);
        const inspection = await seInspector.inspect(files);
        seShape = inspection.requests;
        seDetails = inspection.details;
        seOpenBank = row.entry.name;
        status("");
    } catch (e) {
        status(friendlyError(e), true);
    } finally {
        seLoading = false;
        renderSeList();
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

async function seSynthAssets(entry: SeBankEntry) {
    if (!session) throw new Error("no disc session");
    const files = await session.se.bank(entry);
    const [irx, libsd] = await Promise.all([
        session.read("irx/sg2iopm1.irx"),
        session.read("irx/libsd.irx"),
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

function startSeMeasurement(
    row: Extract<SeRow, { kind: "cue" }>, assets: SeMeasureFiles,
): void {
    const token = ++seMeasureToken;
    seKnownFrames = null;
    seKnownEstimated = false;
    seMeasuring = true;
    renderSeLength();
    void seInspector.measure(
        cloneSeMeasureFiles(assets), row.bank, row.request,
        seCfg.exact, seCfg.revDepth,
    ).then((measure) => {
        if (token !== seMeasureToken) return;
        seKnownFrames = measure.frames;
        seKnownEstimated = measure.estimated;
    }, (error) => {
        if (token !== seMeasureToken) return;
        console.error("SE duration analysis failed", error);
    }).finally(() => {
        if (token !== seMeasureToken) return;
        seMeasuring = false;
        renderSeLength();
        renderSeInfo();
    });
}

async function refreshSeMeasurement(): Promise<void> {
    if (!session || !sePlaying) return;
    try {
        const { assets } = await seSynthAssets(sePlaying.entry);
        startSeMeasurement(sePlaying, assets);
    } catch (error) {
        console.error("SE duration analysis failed", error);
    }
}

async function loadSeCue(
    row: Extract<SeRow, { kind: "cue" }>, autoplay: boolean,
): Promise<void> {
    if (!session || seLoading) return;
    let p: WorkletPlayer;
    try {
        p = await ensurePlayer();
    } catch (e) {
        status(e instanceof Error ? e.message : String(e), true);
        return;
    }
    p.resume();
    sPlayer.pause();
    seLoading = true;
    finished = false;
    status(`loading ${row.entry.name} ${row.bank}:${row.request}...`);
    p.snap = null;
    seSourceLoopViz?.clear();
    try {
        const info = currentSeInfo(row);
        const { assets } = await seSynthAssets(row.entry);
        startSeMeasurement(row, assets);
        const r = await p.loadSe(
            assets, row.bank, row.request, seEngineConfig(info));
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
        $("se-coord").textContent = `bank ${row.bank} \u00B7 request ${row.request}`;
        renderSeLength();
        $<HTMLButtonElement>("se-playbtn").disabled = false;
        $<HTMLButtonElement>("se-bankbtn").disabled = false;
        updateSeExportBtn();
        status(r.warning ? `warning: ${r.warning}` : "", !!r.warning);
        if (autoplay) p.play();
    } catch (e) {
        status(friendlyError(e), true);
        seKnownEstimated = false;
        seMeasureToken++;
        seMeasuring = false;
    } finally {
        seLoading = false;
        renderSeList();
        renderSeDials();
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
    const stream = info && counts
        ? `${counts.starts} start${counts.starts === 1 ? "" : "s"} · `
          + `${counts.stops} stop${counts.stops === 1 ? "" : "s"} · `
          + `${info.controls} control${info.controls === 1 ? "" : "s"} · `
          + (info.loop
              ? `${info.loop.count === 0 ? "infinite jump" : `jump ×${info.loop.count}`} `
                + `${fmtSeTime(seLoopFrames(info)!.cycle)} cycle`
              : `${fmtSeTime(seEventFrames(info))} event track`)
        : "event metadata unavailable";
    const sourceEnd = info ? seSourceEndFrames(info) : 0;
    const sources = info
        ? (seIsStopOnly(info)
            ? `voice-stop request: stops matching live ${seStopTargets(info)}; `
              + "starts no audio source by itself"
            : info.sustained
                ? `${info.sustainedVoices} non-decaying loop/noise `
                  + `voice${info.sustainedVoices === 1 ? "" : "s"} remain after the event track`
                : info.loopingVoices && sourceEnd > seEventFrames(info)
                    ? `${info.loopingVoices} loop/noise source `
                      + `voice${info.loopingVoices === 1 ? "" : "s"} `
                      + `${info.loopingVoices === 1 ? "remains" : "remain"} after events; `
                      + `envelope endpoint ≈${fmtSeTime(sourceEnd)}`
                    : info.activeVoices
                        ? `${info.activeVoices} note${info.activeVoices === 1 ? "" : "s"} `
                          + `${info.activeVoices === 1 ? "has" : "have"} no explicit note-off; `
                          + "waveform/envelope lifetime ends the source"
                        : "all started notes receive an explicit note-off")
        : "";
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
    loop.textContent = hostLoop
        ? (seCfg.loop ? "LOOP STREAM" : "STREAM ONCE")
        : (info?.loop
            ? `REPEAT \u00D7${info.loop.count}`
            : info?.sustained
                ? "SUSTAINED SOURCE"
                : info?.loopingVoices ? "SOURCE LOOP" : "ONE SHOT");
    loop.classList.toggle("on", !!hostLoop && seCfg.loop);
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
    if (!session || !sePlaying || seBusy || exporter.busy) return;
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
        const { assets } = await seSynthAssets(row.entry);
        const opts: SeExportOpts = {
            bank: row.bank, request: row.request, volume: seCfg.volume,
            revDepth: seCfg.revDepth, exact: seCfg.exact,
            bright: !seCfg.gaussian, seconds: cap, loop: looping,
        };
        exporter.se(`se_${row.entry.name}_${mode}`, assets, opts);
    } catch (e) {
        status(`EXPORT FAILED: ${e instanceof Error ? e.message : e}`, true);
    } finally {
        seBusy = false;
        updateSeExportBtn();
    }
}

async function exportSeBank(): Promise<void> {
    if (!session || !sePlaying) return;
    try {
        const { hd, bd } = await session.se.bank(sePlaying.entry);
        const zip = storeZip([
            [sePlaying.entry.hd, hd],
            [sePlaying.entry.bd, bd],
        ]);
        const file = `${sePlaying.entry.name}_bank.zip`;
        download(zip, file, "application/zip");
        status(`EXPORTED ${file}`);
    } catch (e) {
        status(`EXPORT FAILED: ${e instanceof Error ? e.message : e}`, true);
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
    if (!session || playingIdx < 0 || exporter.busy) return;
    const song = session.songs[playingIdx]!;
    let suffix = "";
    let o: ExportOpts;
    if (mode === "authored") {          /* the curated listening-set render */
        suffix = "_authored";
        o = { songvol: song.songvol, revDepth: 30, exact: true,
              bright: false, loop: 0 };
    } else {                            /* what you hear (minus the looping) */
        o = { songvol: cfg.songvol, revDepth: cfg.revDepth, exact: cfg.exact,
              bright: !cfg.gaussian, loop: 0 };
        if (mode === "loop") { suffix = `_loop${loopN}`; o.loop = loopN; }
    }
    try {
        const assets = await session.songAssets(song);
        exporter.start(song.name, suffix, assets, o);
    } catch (e) {
        status(friendlyError(e), true);
    }
    updateExportBtn();
}

/* MIDI export: the sequence exactly as it sits on the disc (a standard SMF;
 * the CC99 20/30 loop markers ride along as plain controller events). No
 * render involved, so no worker and no busy state. */
async function exportMidi(): Promise<void> {
    if (!session || playingIdx < 0) return;
    const song = session.songs[playingIdx]!;
    try {
        const mid = await session.read(`bgm/${song.mid}`);
        if (!mid)
            throw new Error(`missing asset bgm/${song.mid}`
                            + " -- forget the disc and re-open the ISO");
        download(mid, song.mid, "audio/midi");
        status(`EXPORTED ${song.mid}`);
    } catch (e) {
        status(friendlyError(e), true);
    }
}

/* Kit export: every waveform in the song's bank decoded to WAV (44100 Hz,
 * loop points + root key as smpl chunks), zipped. Decode runs in the export
 * worker through the SDK's bank-introspection API. */
async function exportKit(): Promise<void> {
    if (!session || playingIdx < 0 || exporter.busy) return;
    const song = session.songs[playingIdx]!;
    try {
        const assets = await session.songAssets(song);
        exporter.kit(song.name, assets);
    } catch (e) {
        status(friendlyError(e), true);
    }
    updateExportBtn();
}

/* Bank export: the song's instrument bank exactly as it sits on the disc --
 * .hd (Sony "Jam" header) + .bd (raw PS-ADPCM body). One zip, not two
 * downloads: a click is one gesture, and Chrome silently blocks the second
 * same-gesture download until the user allows "multiple downloads". */
async function exportBank(): Promise<void> {
    if (!session || playingIdx < 0) return;
    const song = session.songs[playingIdx]!;
    try {
        const files: [string, Uint8Array][] = [];
        for (const name of [song.hd, song.bd]) {
            const b = await session.read(`bgm/${name}`);
            if (!b)
                throw new Error(`missing asset bgm/${name}`
                                + " -- forget the disc and re-open the ISO");
            files.push([name, b]);
        }
        const file = `${song.name}_bank.zip`;
        download(storeZip(files), file, "application/zip");
        status(`EXPORTED ${file}`);
    } catch (e) {
        status(friendlyError(e), true);
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
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLElement && target.isContentEditable) {
        if (e.key === "Escape" && target instanceof HTMLElement) target.blur();
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

function selectedMovieEntry(): MovieEntry | null {
    return movieCatalog?.entries.find(entry => entry.name === movieSelectedName) ?? null;
}

function movieScanLabel(entry: MovieEntry): string {
    if (entry.video.fieldOrder === "progressive") return "29.97p";
    const fieldOrder = entry.video.fieldOrder === "tt" ? "TFF" : "BFF";
    return `59.94p · source ${fieldOrder}`;
}

function movieGroupLabel(entry: MovieEntry): string {
    switch (entry.group) {
    case "opening": return "Station IDs & openings";
    case "story": return "Story scenes";
    case "gameplay": return "Gameplay reels";
    }
}

function reportMovieProgress(progress: number, stage: string): void {
    movieProgress = progress;
    movieStatus = stage;
}

function reportMovieError(error: unknown, cancelledStatus: string): void {
    if (movieAbort?.signal.aborted) {
        movieStatus = cancelledStatus;
        movieError = false;
        return;
    }
    movieStatus = friendlyError(error);
    movieError = true;
}

function releaseMovieUrls(): void {
    movieVideo?.pause();
    movieVideo = null;
    if (movieVideoUrl) URL.revokeObjectURL(movieVideoUrl);
    if (movieVttUrl) URL.revokeObjectURL(movieVttUrl);
    movieVideoUrl = null;
    movieVttUrl = null;
    moviePreparedName = null;
}

function movieObjectUrl(bytes: Uint8Array, type: string): string {
    let part: ArrayBuffer;
    if (bytes.buffer instanceof ArrayBuffer) {
        part = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else {
        part = Uint8Array.from(bytes).buffer;
    }
    return URL.createObjectURL(new Blob([part], { type }));
}

async function refreshMovieCache(name: string): Promise<void> {
    const target = session;
    if (!target) return;
    const cache = await target.movies.cacheInfo(name);
    if (session !== target || movieSelectedName !== name) return;
    movieCache = cache;
    viewerRevision++;
}

async function loadMovieCatalog(target: DiscSession): Promise<void> {
    try {
        const catalog = await target.movies.catalog();
        if (session !== target) return;
        movieCatalog = catalog;
        movieSelectedName = catalog?.entries[0]?.name ?? null;
        movieStatus = catalog
            ? `${catalog.entries.length} movies indexed locally`
            : "Reconnect the same disc once to scan its movie archive.";
        movieError = false;
        viewerRevision++;
        if (movieSelectedName) await refreshMovieCache(movieSelectedName);
    } catch (error) {
        if (session !== target) return;
        movieStatus = friendlyError(error);
        movieError = true;
        viewerRevision++;
    }
}

async function chooseMovieDisc(): Promise<void> {
    if (!session || movieLoading || movieExporting) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".iso,application/x-iso9660-image";
    input.hidden = true;
    document.body.append(input);
    input.onchange = async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file || !session) return;
        const target = session;
        movieLoading = true;
        movieProgress = 0;
        movieStatus = "reading disc image";
        movieError = false;
        viewerRevision++;
        try {
            await target.movies.attachIso(file, reportMovieProgress);
            if (session !== target) return;
            movieCatalog = await target.movies.catalog();
            movieSelectedName ??= movieCatalog?.entries[0]?.name ?? null;
            movieStatus = `${movieCatalog?.entries.length ?? 0} movies indexed locally`;
            if (movieSelectedName) await refreshMovieCache(movieSelectedName);
        } catch (error) {
            movieStatus = friendlyError(error);
            movieError = true;
        } finally {
            movieLoading = false;
            viewerRevision++;
        }
    };
    input.click();
}

async function prepareSelectedMovie(): Promise<void> {
    if (!session || !movieSelectedName || movieLoading || movieExporting) return;
    const target = session;
    const name = movieSelectedName;
    movieLoading = true;
    movieProgress = 0;
    movieStatus = "preparing local playback";
    movieError = false;
    movieAbort = new AbortController();
    viewerRevision++;
    try {
        const prepared = await target.movies.prepare(
            name, reportMovieProgress, movieAbort.signal);
        if (session !== target || movieSelectedName !== name) return;
        releaseMovieUrls();
        movieVideoUrl = movieObjectUrl(prepared.mp4, "video/mp4");
        movieVttUrl = prepared.vtt
            ? URL.createObjectURL(new Blob([prepared.vtt], { type: "text/vtt" }))
            : null;
        moviePreparedName = name;
        movieCache = prepared.cache;
        movieProgress = 1;
        movieStatus = "Ready. Press play; playback stays on this device.";
    } catch (error) {
        reportMovieError(error, "Preparation cancelled.");
    } finally {
        movieAbort = null;
        movieLoading = false;
        viewerRevision++;
    }
}

async function exportSelectedMovie(kind: MovieExportKind, captions: boolean): Promise<void> {
    if (!session || !movieSelectedName || movieLoading || movieExporting) return;
    const target = session;
    const name = movieSelectedName;
    movieExporting = true;
    movieProgress = 0;
    movieStatus = `preparing ${kind} export`;
    movieError = false;
    movieAbort = new AbortController();
    viewerRevision++;
    try {
        const output = await target.movies.export(
            name, kind, captions, reportMovieProgress, movieAbort.signal);
        if (session !== target) return;
        download(output.bytes, output.filename, output.mime);
        movieCache = await target.movies.cacheInfo(name);
        movieProgress = 1;
        movieStatus = `${output.filename} ready`;
    } catch (error) {
        reportMovieError(error, "Export cancelled.");
    } finally {
        movieAbort = null;
        movieExporting = false;
        viewerRevision++;
    }
}

export function viewerMovieDetails(): ViewerMovieDetails {
    return {
        entry: selectedMovieEntry(),
        cache: movieCache,
        prepared: moviePreparedName === movieSelectedName && movieVideoUrl !== null,
        hasIso: session?.movies.hasIso() ?? false,
        progress: movieProgress,
        status: movieStatus,
        error: movieError,
    };
}

export function viewerBindMovieVideo(video: HTMLVideoElement): void {
    movieVideo = video;
    if (moviePreparedName !== movieSelectedName || !movieVideoUrl) return;
    video.src = movieVideoUrl;
    if (movieVttUrl) {
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = "English";
        track.srclang = "en";
        track.src = movieVttUrl;
        track.default = true;
        video.append(track);
    }
    video.onerror = () => {
        movieStatus = "The browser could not play the cached MP4.";
        movieError = true;
    };
    video.load();
}

export function viewerPrepareMovie(): void {
    void prepareSelectedMovie();
}

export function viewerExportMovie(kind: MovieExportKind, captions: boolean): void {
    void exportSelectedMovie(kind, captions);
}

export function viewerCancelMovieWork(): void {
    if (!movieAbort) return;
    movieStatus = "Cancelling…";
    movieAbort.abort();
}

export function viewerRemoveMovie(): void {
    if (!session || !movieSelectedName || movieLoading || movieExporting) return;
    const target = session;
    const name = movieSelectedName;
    void (async () => {
        if (moviePreparedName === name) releaseMovieUrls();
        await target.movies.remove(name);
        if (session !== target) return;
        movieCache = await target.movies.cacheInfo(name);
        movieStatus = "Cached copies removed. Original disc files were untouched.";
        movieError = false;
        viewerRevision++;
    })().catch((error) => {
        movieStatus = friendlyError(error);
        movieError = true;
        viewerRevision++;
    });
}

/* ---- asset-viewer bridge ----------------------------------------------- */
export function viewerVersion(): number {
    return viewerRevision;
}

export function viewerLibrary(): ViewerLibrary {
    const channel = viewerChannel;
    const items: ViewerItem[] = [];
    let selectedId: string | null = null;

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
    } else if (session && channel === "cinema" && movieCatalog) {
        for (const entry of movieCatalog.entries) {
            const id = `movie:${entry.name}`;
            const field = movieScanLabel(entry);
            items.push({
                id,
                label: entry.label,
                detail: `${entry.video.width}×${entry.video.height} · ${field}`
                    + `${entry.subtitleCues ? ` · ${entry.subtitleCues} captions` : ""}`,
                duration: entry.duration,
                kind: "media",
                playing: entry.name === moviePreparedName && !!movieVideo && !movieVideo.paused,
                group: movieGroupLabel(entry),
            });
            if (entry.name === movieSelectedName) selectedId = id;
        }
        selectedId ??= items[0]?.id ?? null;
    }

    const statusElement = $("status");
    return {
        revision: viewerRevision,
        connected: session !== null,
        channel,
        discLabel: session ? session.serial ?? session.volumeId : "",
        status: channel === "cinema" ? movieStatus : statusElement.textContent ?? "",
        error: channel === "cinema" ? movieError : statusElement.classList.contains("err"),
        items,
        selectedId,
        counts: {
            music: session?.songs.length ?? null,
            streams: sCatalog?.entries.length ?? null,
            effects: seCatalog?.entries.length ?? null,
            cinema: movieCatalog?.entries.length ?? null,
        },
    };
}

export function viewerSetup(): ViewerSetup | null {
    if (session && viewerChannel === "cinema" && !movieCatalog) {
        return {
            label: "Reconnect the movie archive",
            detail: movieStatus || (session.movies.hasIso()
                ? "Scan the attached disc for its 22 local movies."
                : "Choose the same disc once to index its movie archive."),
            progress: movieLoading ? movieProgress : null,
        };
    }
    let label: string;
    let detail: string;
    let progressElement: HTMLProgressElement;
    if (!session) {
        label = "Tune in with your Ape Escape 3 disc";
        detail = $("picker-status").textContent
            || "Choose the disc image. Extraction stays inside this browser.";
        progressElement = $<HTMLProgressElement>("picker-progress");
    } else if (tab === "streams" && !sCatalog) {
        label = "Scan the stream archive";
        detail = $("s-setup-status").textContent
            || (session.streams.hasIso()
                ? "The local disc is ready to scan."
                : "Reconnect the same disc once to scan streamed audio.");
        progressElement = $<HTMLProgressElement>("s-progress");
    } else if (tab === "se" && !seCatalog) {
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
    if (viewerChannel === "cinema")
        return !!selectedMovieEntry() && !movieLoading && !movieExporting;
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
    if (viewerChannel === "cinema") {
        const entry = selectedMovieEntry();
        title = entry?.label ?? "";
        current = movieVideo?.currentTime ?? 0;
        const videoDuration = movieVideo?.duration;
        duration = videoDuration !== undefined && Number.isFinite(videoDuration)
            ? videoDuration : entry?.duration ?? 0;
        isPlaying = !!movieVideo && !movieVideo.paused;
        isLoading = movieLoading;
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
            ? movieExporting : exporter.busy || sBusy || seBusy,
        status: viewerChannel === "cinema" ? movieStatus : $("status").textContent ?? "",
        error: viewerChannel === "cinema" ? movieError : $("status").classList.contains("err"),
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
    if (viewerChannel === "cinema" && channel !== "cinema") {
        movieVideo?.pause();
        movieVideo = null;
    }
    viewerChannel = channel;
    if (channel === "cinema") {
        player?.pause();
        sPlayer.pause();
        viewerRevision++;
        return;
    }
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
        const name = id.slice(6);
        if (!movieCatalog?.entries.some(entry => entry.name === name)) return;
        movieVideo?.pause();
        movieVideo = null;
        movieSelectedName = name;
        movieCache = null;
        movieStatus = moviePreparedName === name
            ? "Ready. Press play; playback stays on this device."
            : "Prepare this movie for local playback, or choose an export.";
        movieError = false;
        viewerRevision++;
        void refreshMovieCache(name).catch((error) => {
            movieStatus = friendlyError(error);
            movieError = true;
            viewerRevision++;
        });
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
    const library = viewerLibrary();
    if (!library.items.length) return;
    const selected = library.items.findIndex((item) => item.id === library.selectedId);
    const index = (Math.max(selected, 0) + direction + library.items.length)
        % library.items.length;
    viewerActivate(library.items[index]!.id);
}

export function viewerTogglePlayback(): void {
    if (viewerChannel === "cinema") {
        if (moviePreparedName !== movieSelectedName || !movieVideoUrl) {
            void prepareSelectedMovie();
            return;
        }
        if (!movieVideo) return;
        if (movieVideo.paused) {
            player?.pause();
            sPlayer.pause();
            void movieVideo.play().catch((error) => {
                movieStatus = friendlyError(error);
                movieError = true;
            });
        } else {
            movieVideo.pause();
        }
        return;
    }
    if (tab === "streams") sTogglePlay();
    else if (tab === "se") seTogglePlay();
    else togglePlay();
}

export function viewerSeek(ratio: number): void {
    const clamped = Math.max(0, Math.min(ratio, 1));
    if (viewerChannel === "cinema") {
        if (movieVideo && Number.isFinite(movieVideo.duration))
            movieVideo.currentTime = clamped * movieVideo.duration;
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
        const captions = (selectedMovieEntry()?.subtitleCues ?? 0) > 0;
        void exportSelectedMovie("mp4", captions);
    } else if (tab === "streams") void sExport();
    else if (tab === "se") void exportSeCue(false);
    else void exportWav("current");
}

export function viewerChooseDisc(): void {
    if (!session) {
        $<HTMLInputElement>("file").click();
    } else if (viewerChannel === "cinema") {
        void chooseMovieDisc();
    } else if (tab === "streams" && !sCatalog) {
        if (session.streams.hasIso()) void extractStreams();
        else $<HTMLInputElement>("s-iso").click();
    } else if (tab === "se" && !seCatalog) {
        if (session.se.hasIso()) void extractSeBanks();
        else $<HTMLInputElement>("se-iso").click();
    }
}

/* ---- app states --------------------------------------------------------- */
async function enterPlayer(s: DiscSession): Promise<void> {
    session = s;
    releaseMovieUrls();
    movieCatalog = null;
    movieSelectedName = null;
    movieCache = null;
    movieStatus = "Loading movie catalog…";
    movieError = false;
    void loadMovieCatalog(s);
    $("picker").hidden = true;
    $("app").hidden = false;
    $("disc-id").textContent =
        s.cached ? (s.serial ?? s.volumeId) : `${s.serial ?? s.volumeId} (no cache)`;
    bgmDurations = new Float64Array(s.songs.length);
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
    const region = s.serial && s.serial !== US_SERIAL
        ? ` - untested region disc (${s.serial}), things may be off` : "";
    status(`${session.songs.length} songs - SPACE or click one to play${region}`);
    requestAnimationFrame(tick);
}

function wirePicker(): void {
    const drop = $("drop");
    const input = $<HTMLInputElement>("file");
    const pstat = $("picker-status");
    const bar = $<HTMLProgressElement>("picker-progress");

    async function open(file: File): Promise<void> {
        pstat.classList.remove("err");
        pstat.textContent = "reading disc...";
        bar.hidden = false;
        bar.value = 0;
        try {
            const s = await openIso(file, (done, total, name) => {
                bar.value = total > 0 ? done / total : 0;
                pstat.textContent = `extracting ${name} (${done}/${total})`;
            });
            await enterPlayer(s);
        } catch (e) {
            pstat.textContent = friendlyError(e);
            pstat.classList.add("err");
            bar.hidden = true;
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
            put(`setup:FAIL ${e instanceof Error ? e.message : e}`);
        }
    };
    put("press-play-to-test-audio-unlock");
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
    };
    wirePicker();
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
        const pstat = $("s-setup-status");
        pstat.classList.remove("err");
        pstat.textContent = "reading disc...";
        try {
            await session.streams.attachIso(f);
            $("s-iso-pick").hidden = true;
            $("s-extract").hidden = false;
            await extractStreams();
        } catch (err) {
            pstat.textContent = friendlyError(err);
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
        const setupStatus = $("se-setup-status");
        setupStatus.classList.remove("err");
        setupStatus.textContent = "reading disc...";
        try {
            await session.se.attachIso(file);
            $("se-iso-pick").hidden = true;
            $("se-extract").hidden = false;
            await extractSeBanks();
        } catch (e) {
            setupStatus.textContent = friendlyError(e);
            setupStatus.classList.add("err");
        }
    };
    renderSeDials();
    sPlayer.onended = () => { /* glyph flips via the tick loop */ };
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
        player?.pause();
        await session.forget();
        location.reload();
    };
    window.addEventListener("keydown", onKey);

    /* offline after first visit (W6): best-effort, and prod-only -- dev
     * serves no sw.js, and a stale worker would shadow the dev server */
    if (import.meta.env.PROD && "serviceWorker" in navigator)
        void navigator.serviceWorker
            .register(`${import.meta.env.BASE_URL}sw.js`)
            .catch((e) => console.warn("service worker registration failed", e));

    if (new URLSearchParams(location.search).has("selftest"))
        return selftest();

    const resumed = await resumeSession();
    if (resumed) await enterPlayer(resumed);
}

void main();
