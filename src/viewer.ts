import "./viewer.css";
import { loadViewerArt } from "./viewer-assets.ts";
import type { ViewerArt } from "./viewer-assets.ts";
import {
    viewerActivate,
    viewerChooseDisc,
    viewerExport,
    viewerLibrary,
    viewerMove,
    viewerSeek,
    viewerSetup,
    viewerSwitchChannel,
    viewerTogglePlayback,
    viewerTransport,
    viewerMeterLevels,
    viewerVersion,
} from "./main.ts";
import type { ViewerChannel, ViewerItem, ViewerLibrary } from "./main.ts";

let viewerArt: ViewerArt | null = null;
let artDiscAttempt = "";
let viewerRoot: HTMLElement;
let guideQuery = "";
let lastViewerVersion = -1;
let setupSync = 0;
let syncFrame = 0;
let playUiKey = "";
let exportUiKey = "";
let guideScrollTop = 0;
const liveMeterLevels = new Float32Array(32);


function formatTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function icon(name: "play" | "pause" | "search" | "back" | "forward" | "download"): string {
    const paths = {
        play: '<path d="m10 7 8 5-8 5z"/>',
        pause: '<path d="M9 7h2.5v10H9zm5.5 0H17v10h-2.5z"/>',
        search: '<circle cx="11" cy="11" r="5.5"/><path d="m15 15 4 4"/>',
        back: '<path d="m15.5 6-6 6 6 6"/>',
        forward: '<path d="m9 6 6 6-6 6"/>',
        download: '<path d="M12 4v10m-4-4 4 4 4-4M5 19h14"/>',
    };
    return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}


function viewerHeader(): string {
    const connected = viewerLibrary().connected;
    const identity = connected && viewerArt?.images.logo
        ? `<img class="game-logo" src="${viewerArt.images.logo}" alt="Ape Escape 3" />`
        : `<span class="off-air-logo tv-static" aria-label="Monkey TV off air">
            <b>03</b><span>Monkey TV<small>${connected ? "Local feed" : "Off air"}</small></span>
           </span>`;
    return `<header class="viewer-header">
        <a class="viewer-brand" href="?" aria-label="Return to the sound player">${identity}</a>
        <a class="return-link" href="?">${icon("back")} Player</a>
    </header>`;
}


function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function broadcastGuide(library: ViewerLibrary): string {
    const rows = library.items.length
        ? `${library.items.map((item, index) => `<button type="button"
            class="track-row${item.kind === "group" ? " group-row" : ""}"
            data-track="${encodeURIComponent(item.id)}"
            aria-current="${item.id === library.selectedId ? "true" : "false"}">
            <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
            <span class="track-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>
            <span class="track-duration">${item.duration === null ? item.kind === "group" ? "OPEN" : "—" : formatTime(item.duration)}</span>
        </button>`).join("")}
        <div class="guide-no-signal guide-filter-empty tv-static" hidden>
            <span>No matching broadcast</span>
        </div>`
        : '<div class="guide-no-signal tv-static"><span>Guide unavailable</span></div>';
    return `<aside class="up-next">
        <header><span>Up next</span><label class="guide-search">${icon("search")}
            <input type="search" data-action="guide-search" value="${escapeHtml(guideQuery)}"
                placeholder="Find anything" aria-label="Search this channel" />
        </label></header>
        <div class="guide-list">${rows}</div>
    </aside>`;
}

function filterGuideRows(): void {
    const query = guideQuery.trim().toLowerCase();
    let visible = 0;
    viewerRoot.querySelectorAll<HTMLElement>(".guide-list .track-row").forEach((row) => {
        row.hidden = query.length > 0
            && !(row.textContent ?? "").toLowerCase().includes(query);
        if (!row.hidden) visible++;
    });
    const empty = viewerRoot.querySelector<HTMLElement>(".guide-filter-empty");
    if (empty) empty.hidden = visible > 0;
}

function broadcastTransport(selected: ViewerItem | null): string {
    const state = viewerTransport();
    const title = state.title || selected?.label || "Waiting for signal";
    const percent = state.progress * 100;
    const canPlay = selected?.kind === "media";
    return `<section class="broadcast-transport" aria-label="Player transport">
        <div class="transport-buttons">
            <button type="button" class="icon-button" data-action="previous"
                aria-label="Previous asset" ${selected ? "" : "disabled"}>${icon("back")}</button>
            <button type="button" class="play-button" data-action="play"
                aria-label="Play ${escapeHtml(title)}" ${canPlay ? "" : "disabled"}>${icon(state.playing ? "pause" : "play")}</button>
            <button type="button" class="icon-button" data-action="next"
                aria-label="Next asset" ${selected ? "" : "disabled"}>${icon("forward")}</button>
        </div>
        <div class="transport-title"><small data-player-status>Now tuned to</small><strong data-player-title>${escapeHtml(title)}</strong></div>
        <label class="scrubber"><span class="sr-only">Playback position</span>
            <input type="range" min="0" max="1000" value="${Math.round(percent * 10)}"
                data-action="seek" ${state.duration > 0 ? "" : "disabled"} />
            <span class="scrubber-fill" style="--progress:${percent}%"></span>
        </label>
        <span class="time-readout"><b data-current-time>${formatTime(state.current)}</b> /
            <span data-duration>${formatTime(state.duration)}</span></span>
        <button type="button" class="export-action" data-action="export"
            ${state.canExport && !state.exporting ? "" : "disabled"}>${icon("download")} Export</button>
    </section>`;
}

function broadcastCards(library: ViewerLibrary): string {
    const cards: ReadonlyArray<{
        title: string;
        detail: string;
        color: string;
        art: "music" | "monkey" | "effects";
        channel: ViewerChannel;
    }> = [
        { title: "Music studio", detail: library.counts.music === null ? "Awaiting disc" : `${library.counts.music} sequenced cues`, color: "card-blue", art: "music", channel: "music" },
        { title: "Monkey phone", detail: library.counts.streams === null ? "Scan local streams" : `${library.counts.streams} local streams`, color: "card-red", art: "monkey", channel: "streams" },
        { title: "Sound effects", detail: library.counts.effects === null ? "Scan effect banks" : `${library.counts.effects} effect banks`, color: "card-ink", art: "effects", channel: "effects" },
    ];
    return `<div class="channel-grid">${cards.map((card) => {
        const image = library.connected ? viewerArt?.images[card.art] : null;
        const glyph = image
            ? `<span class="channel-glyph game-sprite" style="background-image:url('${image}')"></span>`
            : '<span class="channel-glyph channel-static tv-static" aria-hidden="true"></span>';
        return `<button type="button" class="channel-card ${card.color}"
            data-channel="${card.channel}" aria-current="${card.channel === library.channel}">
            ${glyph}<strong>${card.title}</strong><small>${card.detail}</small>
            <i>Open channel ${icon("forward")}</i>
        </button>`;
    }).join("")}</div>`;
}

function viewerMarkup(): string {
    const library = viewerLibrary();
    const setup = viewerSetup();
    const selected = library.items.find((item) => item.id === library.selectedId)
        ?? library.items[0] ?? null;
    const transportState = viewerTransport();
    const art = library.connected ? viewerArt?.images : null;
    const hasGameArt = !!art?.director;
    const hero = hasGameArt
        ? `<div class="director-sprite" style="background-image:url('${art.director}')"></div>
           ${art.phoneBlue ? `<div class="reaction-sprite reaction-blue" style="background-image:url('${art.phoneBlue}')"></div>` : ""}
           ${art.phonePink ? `<div class="reaction-sprite reaction-pink" style="background-image:url('${art.phonePink}')"></div>` : ""}`
        : `<div class="off-air-picture"><b>${library.connected ? "LOCAL FEED" : "NO SIGNAL"}</b>
            <span>${library.connected ? "Artwork will arrive after this disc is mounted again" : "Monkey TV is off air"}</span></div>`;
    const waveformMarkup = library.connected && selected?.kind === "media"
        ? `<div class="feature-wave live-bars" id="broadcast-levels"
                aria-label="Live decoded audio levels">
            ${Array.from({ length: liveMeterLevels.length }, () => "<i></i>").join("")}
            <span class="wave-wait">Levels waiting for playback</span>
           </div>`
        : '<div class="feature-wave static-wave tv-static" aria-hidden="true"></div>';
    const setupMarkup = setup
        ? `<span class="eyebrow">Station setup</span><h2>${escapeHtml(setup.label)}</h2>
            <p data-setup-detail>${escapeHtml(setup.detail)}</p>
            <div class="tuning-progress${setup.progress === null ? "" : " active"}"
                style="--tuning:${(setup.progress ?? 0) * 100}%"><i></i></div>
            <div class="feature-actions"><button type="button" class="broadcast-play tune-button"
                data-action="tune">${icon("forward")} ${library.connected ? "Scan this channel" : "Choose disc image"}</button></div>`
        : `<span class="eyebrow">${library.channel === "music" ? "Live from the music studio" : library.channel === "streams" ? "Monkey phone archive" : "Sound effects desk"}</span>
            <h2>${selected ? escapeHtml(selected.label) : "No broadcast found"}</h2>
            <p>${selected ? escapeHtml(selected.detail) : "This channel has no entries."}</p>
            <div class="feature-actions"><button type="button" class="broadcast-play"
                data-action="${selected?.kind === "group" ? "activate-selected" : "play"}"
                ${selected ? "" : "disabled"}>${icon(transportState.playing ? "pause" : "play")}
                ${selected?.kind === "group" ? "Open bank" : transportState.playing ? "Pause transmission" : "Play transmission"}</button>
                <button type="button" class="round-action" data-action="export"
                    aria-label="Export current asset" ${transportState.canExport && !transportState.exporting ? "" : "disabled"}>${icon("download")}</button></div>`;
    const channelNumber =
        library.channel === "music" ? "01" : library.channel === "streams" ? "02" : "03";
    const channels: ReadonlyArray<{ label: string; channel: ViewerChannel }> = [
        { label: "Music", channel: "music" },
        { label: "Streams", channel: "streams" },
        { label: "Effects", channel: "effects" },
    ];
    const nav = channels.map(({ label, channel }) => `<button type="button"
        data-channel="${channel}" aria-current="${channel === library.channel ? "page" : "false"}">
        ${label}<small>${library.counts[channel] ?? "scan"}</small>
    </button>`).join("");
    return `<main id="viewer" class="viewer-main monkey-tv${library.connected ? " on-air" : " off-air"}">
        <section class="broadcast-shell">
            <header class="broadcast-mast">
                <div><span class="live-pill"><i></i> ${library.connected ? "Specter TV · Local" : "Specter TV · Off air"}</span>
                    <h1>The whole studio,<br><em>on one strange channel.</em></h1></div>
                <div class="broadcast-bug"><span>${library.connected ? escapeHtml(library.discLabel) : "Awaiting local disc"}</span><b>${channelNumber}</b></div>
            </header>
            <nav class="broadcast-nav" aria-label="Asset channels">${nav}</nav>
            <section class="broadcast-feature${setup ? " needs-tuning" : ""}">
                <div class="feature-art${hasGameArt ? " has-game-art" : " tv-static"}">
                    <span class="feature-kicker" data-live-state data-channel-number="${channelNumber}" data-off-air="${setup !== null}">${transportState.playing ? "Live" : setup ? "Off air" : "Ready"} · Ch. ${channelNumber}</span>
                    ${hero}${waveformMarkup}
                    <span class="feature-caption">${hasGameArt ? "Original game UI · decoded locally" : library.connected ? "Local disc mounted · visual feed unavailable" : "Insert disc to tune the station"}</span>
                </div>
                <div class="feature-copy">${setupMarkup}</div>
                ${broadcastGuide(library)}
            </section>
            <section class="channels"><header><div><span class="eyebrow">Browse the backlot</span><h2>Choose a department</h2></div>
                <span>Music, streams and effects share one local station</span></header>${broadcastCards(library)}</section>
            ${broadcastTransport(selected)}
        </section>
    </main>`;
}


function render(): void {
    const currentGuide = viewerRoot?.querySelector<HTMLElement>(".guide-list");
    if (currentGuide) guideScrollTop = currentGuide.scrollTop;
    document.documentElement.dataset.viewer = "";
    document.body.className = "viewer";
    viewerRoot.innerHTML = `<a class="skip-link" href="#viewer">Skip to viewer</a>
        <div class="viewer-page">${viewerHeader()}${viewerMarkup()}</div>`;
    playUiKey = "";
    exportUiKey = "";
    const nextGuide = viewerRoot.querySelector<HTMLElement>(".guide-list");
    if (nextGuide) {
        filterGuideRows();
        nextGuide.scrollTop = guideScrollTop;
        const current = nextGuide.querySelector<HTMLElement>('[aria-current="true"]:not([hidden])');
        current?.scrollIntoView({ block: "nearest" });
        guideScrollTop = nextGuide.scrollTop;
    }
    lastViewerVersion = viewerVersion();
    updateFunctionalUi(performance.now());
}



function updateFunctionalUi(now: number): void {
    const state = viewerTransport();
    const nextPlayUiKey = `${state.playing}:${state.loading}:${state.title}`;
    if (nextPlayUiKey !== playUiKey) {
        viewerRoot.querySelectorAll<HTMLButtonElement>("[data-action='play']").forEach((button) => {
            const featureButton = button.classList.contains("broadcast-play");
            button.innerHTML = `${icon(state.playing ? "pause" : "play")}${featureButton
                ? ` ${state.playing ? "Pause transmission" : "Play transmission"}` : ""}`;
            button.setAttribute("aria-label", `${state.playing ? "Pause" : "Play"} ${state.title}`);
            button.setAttribute("aria-busy", String(state.loading));
        });
        playUiKey = nextPlayUiKey;
    }
    viewerRoot.querySelectorAll<HTMLElement>("[data-player-title]")
        .forEach((element) => { element.textContent = state.title || "Waiting for signal"; });
    const nextExportUiKey = `${state.exporting}:${state.canExport}:${state.title}`;
    if (nextExportUiKey !== exportUiKey) {
        viewerRoot.querySelectorAll<HTMLButtonElement>("[data-action='export']").forEach((button) => {
            const roundButton = button.classList.contains("round-action");
            button.innerHTML = roundButton
                ? icon("download")
                : `${icon("download")} ${state.exporting ? "Exporting…" : "Export"}`;
            button.disabled = state.exporting || !state.canExport;
            button.setAttribute("aria-busy", String(state.exporting));
            button.setAttribute("aria-label", state.exporting
                ? `Exporting ${state.title}` : `Export ${state.title}`);
        });
        exportUiKey = nextExportUiKey;
    }
    viewerRoot.querySelectorAll<HTMLElement>("[data-player-status]").forEach((element) => {
        const message = state.status.trim() || "Now tuned to";
        if (element.textContent !== message) element.textContent = message;
        element.classList.toggle("error", state.error);
    });
    viewerRoot.querySelectorAll<HTMLElement>("[data-live-state]").forEach((kicker) => {
        const stateLabel = kicker.dataset.offAir === "true"
            ? "Off air" : state.loading ? "Tuning" : state.playing ? "Live" : "Ready";
        kicker.textContent = `${stateLabel} · Ch. ${kicker.dataset.channelNumber}`;
    });
    viewerRoot.querySelectorAll<HTMLInputElement>("[data-action='seek']").forEach((input) => {
        input.value = String(Math.round(state.progress * 1000));
        input.disabled = state.duration <= 0;
    });
    viewerRoot.querySelectorAll<HTMLElement>(".scrubber-fill")
        .forEach((fill) => { fill.style.setProperty("--progress", `${state.progress * 100}%`); });
    viewerRoot.querySelectorAll<HTMLElement>("[data-current-time]")
        .forEach((time) => { time.textContent = formatTime(state.current); });
    viewerRoot.querySelectorAll<HTMLElement>("[data-duration]")
        .forEach((duration) => { duration.textContent = formatTime(state.duration); });

    const levels = viewerRoot.querySelector<HTMLElement>("#broadcast-levels");
    if (levels) {
        const hasSignal = viewerMeterLevels(liveMeterLevels);
        levels.classList.toggle("has-signal", hasSignal);
        levels.querySelectorAll<HTMLElement>("i").forEach((bar, index) => {
            bar.style.setProperty("--level", String(liveMeterLevels[index] ?? 0));
        });
    }

    if (now >= setupSync) {
        setupSync = now + 200;
        const setup = viewerSetup();
        const detail = viewerRoot.querySelector<HTMLElement>("[data-setup-detail]");
        if (setup && detail) {
            detail.textContent = setup.detail;
            const progress = detail.parentElement?.querySelector<HTMLElement>(".tuning-progress");
            progress?.classList.toggle("active", setup.progress !== null);
            progress?.style.setProperty("--tuning", `${(setup.progress ?? 0) * 100}%`);
        }
    }
}




function wireInteractions(): void {
    viewerRoot.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        const channelButton = target.closest<HTMLButtonElement>("[data-channel]");
        if (channelButton?.dataset.channel) {
            guideScrollTop = 0;
            viewerSwitchChannel(channelButton.dataset.channel as ViewerChannel);
            render();
            return;
        }
        const trackButton = target.closest<HTMLButtonElement>("[data-track]");
        if (trackButton) {
            viewerActivate(decodeURIComponent(trackButton.dataset.track ?? ""));
            return;
        }
        const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "play") viewerTogglePlayback();
        if (action === "previous") viewerMove(-1);
        if (action === "next") viewerMove(1);
        if (action === "export") viewerExport();
        if (action === "tune") viewerChooseDisc();
        if (action === "activate-selected") {
            const library = viewerLibrary();
            if (library.selectedId) viewerActivate(library.selectedId);
        }
    });
    viewerRoot.addEventListener("input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input.dataset.action === "seek")
            viewerSeek(Number(input.value) / 1000);
        if (input.dataset.action === "guide-search") {
            guideQuery = input.value;
            guideScrollTop = 0;
            filterGuideRows();
            viewerRoot.querySelector<HTMLElement>(".guide-list")?.scrollTo({ top: 0 });
        }
    });
    viewerRoot.addEventListener("scroll", (event) => {
        const guide = event.target;
        if (guide instanceof HTMLElement && guide.classList.contains("guide-list"))
            guideScrollTop = guide.scrollTop;
    }, true);
}

function syncViewer(now: number): void {
    if (viewerVersion() !== lastViewerVersion) {
        render();
        refreshViewerArt();
    }
    updateFunctionalUi(now);
    syncFrame = requestAnimationFrame(syncViewer);
}

function mountViewer(): void {
    const engine = document.createElement("div");
    engine.id = "player-engine";
    engine.setAttribute("aria-hidden", "true");
    for (const node of Array.from(document.body.childNodes)) engine.append(node);
    engine.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [tabindex]")
        .forEach((element) => { element.tabIndex = -1; });
    viewerRoot = document.createElement("div");
    viewerRoot.id = "viewer-root";
    document.body.replaceChildren(engine, viewerRoot);
}

function refreshViewerArt(): void {
    const library = viewerLibrary();
    if (!library.connected || viewerArt || artDiscAttempt === library.discLabel) return;
    artDiscAttempt = library.discLabel;
    void loadViewerArt().then((art) => {
        if (!art) return;
        viewerArt = art;
        render();
    }).catch((error) => console.warn("Could not load local game art", error));
}

function installStaticTexture(): void {
    const frameWidth = 144;
    const frameHeight = 80;
    const frameCount = 4;
    const canvas = document.createElement("canvas");
    canvas.width = frameWidth * 2;
    canvas.height = frameHeight * 2;
    const context = canvas.getContext("2d");
    if (!context) return;
    const random = crypto.getRandomValues(new Uint8Array(frameWidth * frameHeight * frameCount));
    const image = context.createImageData(canvas.width, canvas.height);
    for (let frame = 0; frame < frameCount; frame++) {
        const originX = frame % 2 * frameWidth;
        const originY = Math.floor(frame / 2) * frameHeight;
        for (let y = 0; y < frameHeight; y++) {
            for (let x = 0; x < frameWidth; x++) {
                const grain = random[frame * frameWidth * frameHeight + y * frameWidth + x]!;
                const value = grain < 18 ? 5 : grain > 238 ? 250 : Math.round(38 + grain * 0.7);
                const target = ((originY + y) * canvas.width + originX + x) * 4;
                image.data[target] = value;
                image.data[target + 1] = value;
                image.data[target + 2] = value;
                image.data[target + 3] = 255;
            }
        }
    }
    context.putImageData(image, 0, 0);
    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        document.documentElement.style.setProperty("--tv-static-image", `url("${url}")`);
    }, "image/png");
}

export function startViewer(): void {
    document.title = "Ape Escape 3 · Monkey TV";
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", "#171554");
    mountViewer();
    installStaticTexture();
    render();
    wireInteractions();
    refreshViewerArt();
    syncFrame = requestAnimationFrame(syncViewer);
    window.addEventListener("pagehide", () => {
        cancelAnimationFrame(syncFrame);
        syncFrame = 0;
    });
    window.addEventListener("pageshow", () => {
        if (!syncFrame) syncFrame = requestAnimationFrame(syncViewer);
    });
}
