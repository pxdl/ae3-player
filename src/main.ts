/* App controller: picker <-> player states, transport, dials, keyboard.
 * Port of the reference consumer's behavior (ae3-sdk harness/bgmplay.c keys
 * and defaults); the visualizers (piano roll, slots, waveform, help, export)
 * land in W5. */

import "./style.css";
import { resumeSession, openIso, type DiscSession } from "./disc.ts";
import { WorkletPlayer, RATE, type EngineConfig } from "./player.ts";
import { buildTimeline, displayPos, bpmOf, type Timeline } from "./timeline.ts";

const LOOP_FOREVER = 0x7f;

const $ = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

/* ---- state -------------------------------------------------------------- */
let session: DiscSession | null = null;
let player: WorkletPlayer | null = null;
let timeline: Timeline | null = null;
let sel = 0;                    /* highlighted row */
let playingIdx = -1;            /* loaded song */
let loading = false;
let finished = false;
let authored = true;
const cfg = { songvol: 44, revDepth: 30, exact: true, gaussian: true, loop: true };

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
/* Only call from a user-gesture handler: the load round-trip cannot complete
 * while the context is suspended, and resume() needs the gesture. */
async function loadSong(idx: number, autoplay: boolean): Promise<void> {
    if (!session || !player || loading) return;
    const song = session.songs[idx];
    if (!song) return;
    player.resume();
    loading = true;
    finished = false;
    status(`loading ${song.name}...`);
    try {
        const assets = await session.songAssets(song);
        if (authored) cfg.songvol = song.songvol;
        const r = await player.load(assets, engineConfig());
        timeline = buildTimeline(r.events, r.ppqn);
        playingIdx = idx;
        player.snap = null;
        $("song-name").textContent = song.name;
        $("time-len").textContent = fmtTime(timeline.lenSamp);
        status(r.warning ? `warning: ${r.warning}` : "", !!r.warning);
        if (autoplay) player.play();
        $<HTMLButtonElement>("playbtn").disabled = false;
    } catch (e) {
        status(String(e instanceof Error ? e.message : e), true);
    } finally {
        loading = false;
        renderList();
        renderDials();
    }
}

function togglePlay(): void {
    if (!player) return;
    if (playingIdx < 0) {               /* first gesture: load the selection */
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
    if (!player || !timeline) return;
    const s = player.snap;
    const disp = displaySample();
    $("time-cur").textContent = fmtTime(disp);
    if (s) $("bpm").textContent = `${bpmOf(timeline, s.clock).toFixed(1)} BPM`;
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
    const pb = $("playbtn");
    pb.innerHTML = s?.playing ? "&#10074;&#10074;" : "&#9654;";
    for (const [id, pk] of [["meter-l", s?.peakL ?? 0],
                            ["meter-r", s?.peakR ?? 0]] as const) {
        const el = $(id);
        el.style.width = `${Math.min(pk * 100, 100).toFixed(1)}%`;
        el.classList.toggle("hot", pk >= 0.9999);
    }
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
    try {
        player = await WorkletPlayer.create();
    } catch (e) {
        status(`audio setup failed: ${e instanceof Error ? e.message : e}`, true);
        return;
    }
    player.onended = () => { finished = true; };
    player.onerror = (m) => status(m, true);
    /* no boot-time load: it could not complete before the first user gesture
     * anyway (autoplay policy) -- the first click/key loads and plays */
    $<HTMLButtonElement>("playbtn").disabled = false;
    status(`${session.songs.length} songs - SPACE or click one to play`);
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
            pstat.textContent = String(e instanceof Error ? e.message : e);
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
    $("forget").onclick = async () => {
        if (!session) return;
        player?.pause();
        await session.forget();
        location.reload();
    };
    window.addEventListener("keydown", onKey);

    const resumed = await resumeSession();
    if (resumed) await enterPlayer(resumed);
}

void main();
