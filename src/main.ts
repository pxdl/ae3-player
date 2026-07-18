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
const cfg = { songvol: 44, revDepth: 30, exact: true, gaussian: true, loop: true };
const exporter = new Exporter();

const engineConfig = (): EngineConfig => ({
    songvol: cfg.songvol, revDepth: cfg.revDepth, exact: cfg.exact,
    gaussian: cfg.gaussian, loop: cfg.loop ? LOOP_FOREVER : 0,
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
    loading = true;
    finished = false;
    status(`loading ${song.name}...`);
    try {
        const assets = await session.songAssets(song);
        if (authored) cfg.songvol = song.songvol;
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
        player.seek(0);
        player.play();
    } else if (player.snap?.playing) {
        player.pause();
    } else {
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
    cfg.songvol = Math.max(1, Math.min(127, v));
    authored = auth;
    player?.set("songvol", cfg.songvol);
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

/* ---- render loop -------------------------------------------------------- */
function fmtTime(samples: number): string {
    const t = Math.max(0, samples) / RATE;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function tick(): void {
    requestAnimationFrame(tick);
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

/* ---- help + export menu visibility -------------------------------------- */
function toggleHelp(force?: boolean): void {
    const h = $("help");
    h.hidden = force !== undefined ? !force : !h.hidden;
}

function showExportMenu(show: boolean): void {
    $("export-menu").hidden = !show;
}

/* ---- keyboard (bgmplay's map) ------------------------------------------- */
function onKey(e: KeyboardEvent): void {
    if (!session || $("app").hidden) return;
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
    };
    wirePicker();
    $("playbtn").onclick = togglePlay;
    $("bar").onclick = (e) => {
        if (!timeline) return;
        const r = $("bar").getBoundingClientRect();
        seekTimeline((e.clientX - r.left) / r.width * timeline.lenSamp);
    };
    $("d-vol").onclick = () => {
        if (playingIdx >= 0 && session)
            setVol(session.songs[playingIdx]!.songvol, true);
    };
    $("d-loop").onclick = toggleLoop;
    $("d-timing").onclick = toggleTiming;
    $("d-kernel").onclick = toggleKernel;
    $("d-rev").onclick = () => setRev(cfg.revDepth > 0 ? 0 : 30);
    /* export dropdown (bgmplay's EXPORT WAV button + 3-row panel) */
    exporter.onstatus = (msg, err) => { status(msg, err); updateExportBtn(); };
    $("exportbtn").onclick = (e) => {
        e.stopPropagation();
        if (!exporter.busy) showExportMenu(!!$("export-menu").hidden);
    };
    $("export-menu").onclick = (e) => e.stopPropagation();
    document.addEventListener("click", () => showExportMenu(false));
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
