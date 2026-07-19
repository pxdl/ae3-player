/* App controller: picker <-> player states, transport, dials, visualizers,
 * export, help, keyboard. Port of the reference consumer's behavior (ae3-sdk
 * harness/bgmplay.c keys, defaults, layout). */

import "./style.css";
import { resumeSession, openIso, friendlyError, US_SERIAL,
         type DiscSession } from "./disc.ts";
import { WorkletPlayer, RATE, type EngineConfig } from "./player.ts";
import { buildTimeline, displayPos, bpmOf, type Timeline } from "./timeline.ts";
import { Viz } from "./viz.ts";
import { Exporter, download, type ExportOpts } from "./export.ts";
import { storeZip } from "./zip.ts";
import { groupStreams, StreamDecoder, StreamPlayer,
         type StreamCatalog, type StreamEntry } from "./streams.ts";
import { StreamViz } from "./sviz.ts";

const LOOP_FOREVER = 0x7f;

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

/* streams tab (VIEWER_PLAN §2) */
let tab: "bgm" | "streams" = "bgm";
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
const sDecoder = new StreamDecoder();
const sPlayer = new StreamPlayer();
let sViz: StreamViz | null = null;

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
    ul.replaceChildren(...session!.songs.map((s, i) => {
        const li = document.createElement("li");
        li.textContent = s.name;
        li.classList.toggle("sel", i === sel);
        li.classList.toggle("playing", i === playingIdx);
        li.onclick = () => { sel = i; void loadSong(i, true); };
        return li;
    }));
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
        p.onsnapshot = (s) => viz?.ingest(s);
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
    finished = false;
    status(`loading ${song.name}...`);
    try {
        const assets = await session.songAssets(song);
        if (authored) cfg.songvol = song.songvol;
        cfg.cueScale = song.volumeScale > 0 ? song.volumeScale : 44.5 / 127;
        const r = await p.load(assets, engineConfig());
        timeline = buildTimeline(r.events, r.ppqn);
        playingIdx = idx;
        p.snap = null;
        viz?.clearWave();
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
    if (!player || playingIdx < 0) {    /* first gesture: load the selection */
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

const sDur = (e: StreamEntry): number =>
    e.sectors * (2048 / e.channels / 16 * 28) / e.rate;

function fmtSec(t: number): string {
    const m = Math.floor(Math.max(0, t) / 60);
    const s = Math.max(0, t) - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function switchTab(t: "bgm" | "streams"): void {
    tab = t;
    $("tab-bgm").classList.toggle("on", t === "bgm");
    $("tab-streams").classList.toggle("on", t === "streams");
    $("songlist").hidden = t !== "bgm";
    $("streamview").hidden = t !== "streams";
    $("head").hidden = t !== "bgm";
    $("bar").hidden = t !== "bgm";
    $("stage").hidden = t !== "bgm";
    $("foot-stats").hidden = t !== "bgm";
    $("stream-main").hidden = t !== "streams";
    $("keys").textContent = t === "bgm" ? keysBgmText : KEYS_STREAMS;
    status("");
    if (t === "streams") void ensureStreams();
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
}

async function extractStreams(): Promise<void> {
    if (!session) return;
    const pstat = $("s-setup-status");
    const bar = $<HTMLProgressElement>("s-progress");
    pstat.classList.remove("err");
    bar.hidden = false;
    bar.value = 0;
    $<HTMLButtonElement>("s-extract").disabled = true;
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
    if (!sCatalog) { ul.replaceChildren(); return; }
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

async function loadStream(i: number, autoplay: boolean): Promise<void> {
    if (!session || sLoading) return;
    const row = sRows[i];
    if (!row || row.kind !== "entry") return;
    const e = row.entry;
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
    if (!player || !timeline) { viz?.draw(null, null, 0, cfg.loop); return; }
    const s = player.snap;
    const disp = displaySample();
    $("time-cur").textContent = fmtTime(disp);
    if (s) $("bpm").textContent = `${bpmOf(timeline, s.clock).toFixed(1)} BPM`;
    $("loopx").textContent =
        s && s.stats.loops_taken > 0 ? `×${s.stats.loops_taken}` : "";
    const frac = timeline.lenSamp > 0 ?
        Math.min(disp / timeline.lenSamp, 1) : 0;
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
    /* write the glyph only when it CHANGES: an innerHTML assignment replaces
     * the text node even when the string is identical, and WebKit swallows a
     * click whose mousedown/mouseup straddles that replacement -- at 60 Hz
     * the play button ate clicks at random in Safari (space was immune: no
     * hit-testing) */
    const glyph = s?.playing ? "&#10074;&#10074;" : "&#9654;";
    if (glyph !== pbGlyph) {
        pbGlyph = glyph;
        /* span: the glyph is pointer-events:none so clicks anywhere in the
         * circle target the BUTTON -- Safari hit-tests/selects button text
         * where Blink does not, which ate clicks landing on the glyph */
        $("playbtn").innerHTML = `<span>${glyph}</span>`;
    }
    /* footer stats + clip flash (bgmplay's footer line) */
    if (s) {
        const st = s.stats;
        $("stats-line").textContent =
            `VOICES STARTED ${st.voices_started}  BUS PEAK ${st.bus_peak}/32767` +
            `  CLIP ${st.bus_clipped}  WET PEAK ${st.wet_peak}` +
            `  WET CLIP ${st.wet_clipped}`;
        const clip = st.bus_clipped + st.wet_clipped;
        if (clip > prevClip) { prevClip = clip; clipFlash = performance.now(); }
        /* cue layer armed: the VOL dial tracks the live duck staircase
         * (write only on change -- see the playbtn glyph note above) */
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

/* ---- keyboard (bgmplay's map) ------------------------------------------- */
function onKey(e: KeyboardEvent): void {
    if (!session || $("app").hidden) return;
    if (e.target === $("stream-search")) {      /* typing a filter */
        if (e.key === "Escape") $<HTMLInputElement>("stream-search").blur();
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

/* ---- app states --------------------------------------------------------- */
async function enterPlayer(s: DiscSession): Promise<void> {
    session = s;
    $("picker").hidden = true;
    $("app").hidden = false;
    $("disc-id").textContent =
        s.cached ? (s.serial ?? s.volumeId) : `${s.serial ?? s.volumeId} (no cache)`;
    renderList();
    renderDials();
    viz = new Viz($<HTMLCanvasElement>("roll"), $<HTMLCanvasElement>("slots"),
                  $<HTMLCanvasElement>("wave"));
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
    exporter.onstatus = (msg, err) => { status(msg, err); updateExportBtn(); };
    $("exportbtn").onclick = (e) => {
        e.stopPropagation();
        showBankMenu(false);
        if (!exporter.busy) showExportMenu(!!$("export-menu").hidden);
    };
    $("export-menu").onclick = (e) => e.stopPropagation();
    document.addEventListener("click", () => {
        showExportMenu(false);
        showBankMenu(false);
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
