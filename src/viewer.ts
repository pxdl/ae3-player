import "./viewer.css";
import { loadViewerArt } from "./viewer-assets.ts";
import type { ViewerArt } from "./viewer-assets.ts";
import {
    viewerActivate,
    viewerAssetSession,
    viewerBindMovieCanvas,
    viewerCancelMovieWork,
    viewerChooseDisc,
    viewerExport,
    viewerExportMovie,
    viewerLibrary,
    viewerMeterLevels,
    viewerMovieDetails,
    viewerMove,
    viewerMoveAndPlayMovie,
    viewerReportMovieError,
    viewerRemoveMovie,
    viewerSeek,
    viewerSetup,
    viewerSwitchChannel,
    viewerToggleMovieCaptions,
    viewerTogglePlayback,
    viewerTransport,
    viewerVersion,
} from "./main.ts";
import type { ViewerChannel, ViewerItem, ViewerLibrary } from "./main.ts";
import type { MovieExportKind } from "./movies.ts";

let viewerArt: ViewerArt | null = null;
let artDiscAttempt: ReturnType<typeof viewerAssetSession> = null;
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

const ICON_PATHS = {
    play: '<path d="m10 7 8 5-8 5z"/>',
    pause: '<path d="M9 7h2.5v10H9zm5.5 0H17v10h-2.5z"/>',
    search: '<circle cx="11" cy="11" r="5.5"/><path d="m15 15 4 4"/>',
    back: '<path d="m15.5 6-6 6 6 6"/>',
    forward: '<path d="m9 6 6 6-6 6"/>',
    download: '<path d="M12 4v10m-4-4 4 4 4-4M5 19h14"/>',
    fullscreen: '<path d="M8 4H4v4m12-4h4v4M8 20H4v-4m12 4h4v-4"/>',
} as const;
type IconName = keyof typeof ICON_PATHS;

function icon(name: IconName): string {
    return `<svg aria-hidden="true" viewBox="0 0 24 24">${ICON_PATHS[name]}</svg>`;
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
    let previousGroup = "";
    const rows = library.items.length
        ? `${library.items.map((item, index) => {
            const heading = item.group && item.group !== previousGroup
                ? `<div class="guide-group" data-guide-group>${escapeHtml(item.group)}</div>`
                : "";
            previousGroup = item.group ?? previousGroup;
            return `${heading}<button type="button"
                class="track-row${item.kind === "group" ? " group-row" : ""}"
                data-track="${encodeURIComponent(item.id)}"
                aria-current="${item.id === library.selectedId ? "true" : "false"}">
                <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
                <span class="track-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>
                <span class="track-duration">${item.duration === null ? item.kind === "group" ? "OPEN" : "—" : formatTime(item.duration)}</span>
            </button>`;
        }).join("")}
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
    viewerRoot.querySelectorAll<HTMLElement>("[data-guide-group]").forEach((heading) => {
        let next = heading.nextElementSibling;
        let groupVisible = false;
        while (next && !next.hasAttribute("data-guide-group")) {
            if (next.classList.contains("track-row")
                && !(next as HTMLElement).hidden) groupVisible = true;
            next = next.nextElementSibling;
        }
        heading.hidden = query.length > 0 && !groupVisible;
    });
    const empty = viewerRoot.querySelector<HTMLElement>(".guide-filter-empty");
    if (empty) empty.hidden = visible > 0;
}

function broadcastTransport(selected: ViewerItem | null, cinema = false): string {
    const state = viewerTransport();
    const title = state.title || selected?.label || "Waiting for signal";
    const percent = state.progress * 100;
    const canPlay = selected?.kind === "media";
    const scrubber = `<label class="scrubber"><span class="sr-only">Playback position</span>
        <input type="range" min="0" max="1000" value="${Math.round(percent * 10)}"
            data-action="seek" ${state.duration > 0 ? "" : "disabled"} />
        <span class="scrubber-fill" style="--progress:${percent}%"></span>
    </label>`;
    return `<section class="broadcast-transport${cinema ? " cinema-transport" : ""}"
        aria-label="${cinema ? "Cinema player" : "Player"} transport">
        ${cinema ? scrubber : ""}
        <div class="transport-buttons">
            <button type="button" class="icon-button" data-action="previous"
                aria-label="Previous asset" ${selected ? "" : "disabled"}>${icon("back")}</button>
            <button type="button" class="play-button" data-action="play"
                aria-label="Play ${escapeHtml(title)}" ${canPlay ? "" : "disabled"}>${icon(state.playing ? "pause" : "play")}</button>
            <button type="button" class="icon-button" data-action="next"
                aria-label="Next asset" ${selected ? "" : "disabled"}>${icon("forward")}</button>
        </div>
        <div class="transport-title">${cinema ? "" : "<small data-player-status>Now tuned to</small>"}<strong data-player-title>${escapeHtml(title)}</strong></div>
        ${cinema ? "" : scrubber}
        <span class="time-readout"><b data-current-time>${formatTime(state.current)}</b> /
            <span data-duration>${formatTime(state.duration)}</span></span>
        <button type="button" class="export-action" data-action="export"
            aria-label="${cinema ? `Export ${escapeHtml(title)} as Fast MP4` : `Export ${escapeHtml(title)}`}"
            title="${cinema ? "Export current movie as Fast MP4" : "Export current asset"}"
            ${state.canExport && !state.exporting ? "" : "disabled"}>${icon("download")} ${cinema ? "Fast MP4" : "Export"}</button>
    </section>`;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 1 : 2)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

function cinemaFeature(library: ViewerLibrary): string {
    const details = viewerMovieDetails();
    const entry = details.entry;
    if (!entry) return "";
    const state = viewerTransport();
    const busy = state.loading || state.exporting;
    let fieldOrder: string;
    if (entry.video.fieldOrder === "progressive") {
        fieldOrder = "Progressive · 29.97 fps";
    } else {
        const firstField = entry.video.fieldOrder === "tt" ? "Top" : "Bottom";
        fieldOrder = `${firstField} field first · bobbed to 59.94 fps`;
    }
    let liveState: string;
    if (state.playing) liveState = "Live";
    else if (busy) liveState = "Tuning";
    else liveState = "Ready";
    let groupLabel = "Station presentation";
    if (entry.group === "story") groupLabel = "Story scene";
    else if (entry.group === "gameplay") groupLabel = "Gameplay reel";
    const cached = details.cache?.totalBytes ?? 0;
    const sourceComplete = (details.cache?.sourceBytes ?? 0)
        >= entry.sourceBytes + entry.subtitleBytes;
    const captions = entry.subtitleCues > 0;
    const selected = library.items.find(item => item.id === library.selectedId) ?? null;
    const displayAspect = entry.video.displayAspect[0] / entry.video.displayAspect[1];
    const cinemaTransport = broadcastTransport(selected, true);
    let captionDetails = "None on disc";
    if (captions) {
        captionDetails = `${entry.subtitleCues} cues · UTF-8`;
        if (entry.subtitleEnd !== null)
            captionDetails += ` · ${formatTime(entry.subtitleEnd)}`;
    }
    return `<section class="broadcast-feature cinema-feature">
        <div class="cinema-stage">
            <span class="feature-kicker" data-live-state data-channel-number="04"
                data-off-air="false">${liveState} · Ch. 04</span>
            <div class="cinema-player" style="--movie-aspect:${entry.video.displayAspect[0]}/${entry.video.displayAspect[1]};--movie-aspect-value:${displayAspect}">
                <div class="cinema-screen">
                    <div class="cinema-picture">
                        <canvas id="cinema-canvas" aria-label="${escapeHtml(entry.label)}"></canvas>
                        <div class="cinema-caption" data-movie-caption
                            ${details.captionsEnabled && details.caption !== null ? "" : "hidden"}>${escapeHtml(details.caption ?? "")}</div>
                        <div class="cinema-screen-actions">
                            ${details.prepared && captions ? `<button type="button"
                                data-action="movie-caption-toggle"
                                aria-pressed="${details.captionsEnabled}">CC</button>` : ""}
                            <button type="button" data-action="movie-fullscreen"
                                aria-label="Full screen">${icon("fullscreen")}</button>
                        </div>
                        ${cinemaTransport}
                    </div>
                </div>

            </div>
            <div class="cinema-now">
                <span class="eyebrow">${escapeHtml(groupLabel)}</span>
                <h2>${escapeHtml(entry.label)}</h2>
                <p>${escapeHtml(entry.name)} · ${formatTime(entry.duration)} · ${formatBytes(entry.sourceBytes)}</p>
            </div>
        </div>
        <div class="cinema-inspector">
            <div class="cinema-details">
                <span class="eyebrow">Source inspection</span>
                <dl>
                    <div><dt>Picture</dt><dd>${entry.video.width}×${entry.video.height}</dd></div>
                    <div><dt>Scan</dt><dd>${fieldOrder}</dd></div>
                    <div><dt>Shape</dt><dd>SAR ${entry.video.sampleAspect.join(":")} · DAR ${entry.video.displayAspect.join(":")}</dd></div>
                    <div><dt>Audio</dt><dd>${entry.header.channels}ch · ${entry.header.sampleRate / 1000} kHz · PS-ADPCM</dd></div>
                    <div><dt>Captions</dt><dd>${captionDetails}</dd></div>
                    <div><dt>Original</dt><dd>${formatBytes(entry.sourceBytes + entry.subtitleBytes)} · untouched</dd></div>
                </dl>
            </div>
            <div class="conversion-studio">
                <div class="conversion-head"><span class="eyebrow">Local export lab</span>
                    <label class="caption-toggle"><input type="checkbox" data-action="movie-captions"
                        ${captions ? "checked" : "disabled"} /> Embed available English captions</label></div>
                <div class="movie-export-grid">
                    <button type="button" data-movie-export="original" ${busy ? "disabled" : ""}>
                        <b>Original ZIP</b><small>.str / .bin / .sbt · byte-exact</small></button>
                    <button type="button" data-movie-export="masters" ${busy ? "disabled" : ""}>
                        <b>Masters ZIP</b><small>MPEG-2 / PCM WAV / SRT</small></button>
                    <button type="button" data-movie-export="mkv" ${busy ? "disabled" : ""}>
                        <b>Lossless MKV</b><small>Original MPEG-2 / lossless PCM · no video transcode</small></button>
                    <button type="button" data-movie-export="mp4" ${busy ? "disabled" : ""}>
                        <b>Fast MP4</b><small>H.264 / AAC · direct browser encode${entry.video.fieldOrder === "progressive" ? "" : " · 59.94p"}</small></button>
                </div>
                <progress data-movie-progress max="1" value="${details.progress}"
                    ${busy ? "" : "hidden"}></progress>
                <p class="movie-status${details.error ? " error" : ""}" data-movie-status
                    aria-live="polite">${escapeHtml(details.status || "Nothing leaves this browser.")}</p>
                <div class="cache-actions">
                    ${details.cancellable ? `<button type="button" data-action="movie-cancel">Cancel current job</button>` : ""}
                    ${details.hasIso || sourceComplete ? "" : `<button type="button" data-action="tune">Reconnect source disc</button>`}
                    <button type="button" data-action="movie-remove" ${cached && !busy ? "" : "disabled"}>
                        Remove ${cached ? formatBytes(cached) : "cached copies"}</button>
                </div>
                <p class="cache-readout">Cache · source ${formatBytes(details.cache?.sourceBytes ?? 0)}
                    · exports ${formatBytes(details.cache?.exportBytes ?? 0)}</p>
                <p class="converter-license">The LGPL MPEG-2 decoder powers previews and Fast MP4 frame extraction.
                    MediaBunny muxes Fast MP4 and remuxes the original MPEG-2 into Lossless MKV. Disc data remains local.
                    <a href="${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt"
                    target="_blank" rel="license">Licenses</a> ·
                    <a href="${import.meta.env.BASE_URL}libav/libav-6.9.8.1-ae3-mpeg2-sources.tar.gz"
                    rel="license">decoder source</a>.</p>
            </div>
        </div>
        ${broadcastGuide(library)}
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
        { title: "Cinema vault", detail: library.counts.cinema === null ? "Scan local movies" : `${library.counts.cinema} local movies`, color: "card-cinema", art: "monkey", channel: "cinema" },
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

function viewerChannelNumber(channel: ViewerChannel): string {
    switch (channel) {
    case "music": return "01";
    case "streams": return "02";
    case "effects": return "03";
    case "cinema": return "04";
    }
}

function channelEyebrow(channel: ViewerChannel): string {
    switch (channel) {
    case "music": return "Live from the music studio";
    case "streams": return "Monkey phone archive";
    case "effects": return "Sound effects desk";
    case "cinema": return "Local cinema vault";
    }
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
    let tuneLabel = "Choose disc image";
    if (library.connected)
        tuneLabel = library.channel === "cinema" ? "Reconnect source disc" : "Scan this channel";
    const setupMarkup = setup
        ? `<span class="eyebrow">Station setup</span><h2>${escapeHtml(setup.label)}</h2>
            <p data-setup-detail>${escapeHtml(setup.detail)}</p>
            <div class="tuning-progress${setup.progress === null ? "" : " active"}"
                style="--tuning:${(setup.progress ?? 0) * 100}%"><i></i></div>
            <div class="feature-actions"><button type="button" class="broadcast-play tune-button"
                data-action="tune">${icon("forward")} ${tuneLabel}</button></div>`
        : `<span class="eyebrow">${channelEyebrow(library.channel)}</span>
            <h2>${selected ? escapeHtml(selected.label) : "No broadcast found"}</h2>
            <p>${selected ? escapeHtml(selected.detail) : "This channel has no entries."}</p>
            <div class="feature-actions"><button type="button" class="broadcast-play"
                data-action="${selected?.kind === "group" ? "activate-selected" : "play"}"
                ${selected ? "" : "disabled"}>${icon(transportState.playing ? "pause" : "play")}
                ${selected?.kind === "group" ? "Open bank" : transportState.playing ? "Pause transmission" : "Play transmission"}</button>
                <button type="button" class="round-action" data-action="export"
                    aria-label="Export current asset" ${transportState.canExport && !transportState.exporting ? "" : "disabled"}>${icon("download")}</button></div>`;
    const channelNumber = viewerChannelNumber(library.channel);
    const channels: ReadonlyArray<{ label: string; channel: ViewerChannel }> = [
        { label: "Music", channel: "music" },
        { label: "Streams", channel: "streams" },
        { label: "Effects", channel: "effects" },
        { label: "Cinema", channel: "cinema" },
    ];
    const nav = channels.map(({ label, channel }) => `<button type="button"
        data-channel="${channel}" aria-current="${channel === library.channel ? "page" : "false"}">
        ${label}<small>${library.counts[channel] ?? "scan"}</small>
    </button>`).join("");
    const standardFeature = `<section class="broadcast-feature${setup ? " needs-tuning" : ""}">
        <div class="feature-art${hasGameArt ? " has-game-art" : " tv-static"}">
            <span class="feature-kicker" data-live-state data-channel-number="${channelNumber}"
                data-off-air="${setup !== null}">${transportState.playing ? "Live"
                    : setup ? "Off air" : "Ready"} · Ch. ${channelNumber}</span>
            ${hero}${waveformMarkup}
            <span class="feature-caption">${hasGameArt ? "Original game UI · decoded locally"
                : library.connected ? "Local disc mounted · visual feed unavailable"
                : "Insert disc to tune the station"}</span>
        </div>
        <div class="feature-copy">${setupMarkup}</div>
        ${broadcastGuide(library)}
    </section>`;
    const feature = library.channel === "cinema" && !setup
        ? cinemaFeature(library) : standardFeature;
    const transport = library.channel === "cinema" ? "" : broadcastTransport(selected);
    return `<main id="viewer" class="viewer-main monkey-tv${library.connected ? " on-air" : " off-air"}${library.channel === "cinema" ? " cinema-on" : ""}">
        <section class="broadcast-shell">
            <header class="broadcast-mast">
                <div><span class="live-pill"><i></i> ${library.connected ? "Specter TV · Local" : "Specter TV · Off air"}</span>
                    <h1>The whole studio,<br><em>on one strange channel.</em></h1></div>
                <div class="broadcast-bug"><span>${library.connected ? escapeHtml(library.discLabel) : "Awaiting local disc"}</span><b>${channelNumber}</b></div>
            </header>
            <nav class="broadcast-nav" aria-label="Asset channels">${nav}</nav>
            ${feature}
            <section class="channels"><header><div><span class="eyebrow">Browse the backlot</span><h2>Choose a department</h2></div>
                <span>Music, streams, effects and cinema share one local station</span></header>${broadcastCards(library)}</section>
            ${transport}
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
    const movieCanvas = viewerRoot.querySelector<HTMLCanvasElement>("#cinema-canvas");
    if (movieCanvas) viewerBindMovieCanvas(movieCanvas);
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
    const channel = viewerLibrary().channel;
    const nextPlayUiKey = `${state.playing}:${state.loading}:${state.title}`;
    if (nextPlayUiKey !== playUiKey) {
        viewerRoot.querySelectorAll<HTMLButtonElement>("[data-action='play']").forEach((button) => {
            const featureButton = button.classList.contains("broadcast-play");
            button.innerHTML = `${icon(state.playing ? "pause" : "play")}${featureButton
                ? ` ${state.playing ? "Pause transmission" : "Play transmission"}` : ""}`;
            button.setAttribute("aria-label",
                `${state.playing ? "Pause" : "Play"} ${state.title}`);
            button.setAttribute("aria-busy", String(state.loading));
        });
        playUiKey = nextPlayUiKey;
    }
    viewerRoot.querySelectorAll<HTMLElement>("[data-player-title]")
        .forEach((element) => { element.textContent = state.title || "Waiting for signal"; });
    const nextExportUiKey = `${channel}:${state.exporting}:${state.canExport}:${state.title}`;
    if (nextExportUiKey !== exportUiKey) {
        const cinemaExport = channel === "cinema";
        viewerRoot.querySelectorAll<HTMLButtonElement>("[data-action='export']").forEach((button) => {
            const roundButton = button.classList.contains("round-action");
            const label = cinemaExport
                ? state.exporting ? "Exporting Fast MP4…" : "Fast MP4"
                : state.exporting ? "Exporting…" : "Export";
            button.innerHTML = roundButton ? icon("download") : `${icon("download")} ${label}`;
            button.disabled = state.exporting || !state.canExport;
            button.setAttribute("aria-busy", String(state.exporting));
            const accessibleLabel = cinemaExport
                ? state.exporting
                    ? `Exporting ${state.title} as Fast MP4`
                    : `Export ${state.title} as Fast MP4`
                : state.exporting ? `Exporting ${state.title}` : `Export ${state.title}`;
            button.setAttribute("aria-label", accessibleLabel);
            button.title = cinemaExport
                ? "Export current movie as Fast MP4"
                : "Export current asset";
        });
        exportUiKey = nextExportUiKey;
    }
    viewerRoot.querySelectorAll<HTMLElement>("[data-player-status]").forEach((element) => {
        const message = state.status.trim() || "Now tuned to";
        if (element.textContent !== message) element.textContent = message;
        element.classList.toggle("error", state.error);
    });
    viewerRoot.querySelectorAll<HTMLElement>("[data-live-state]").forEach((kicker) => {
        let stateLabel = "Ready";
        if (kicker.dataset.offAir === "true")
            stateLabel = "Off air";
        else if (state.loading)
            stateLabel = "Tuning";
        else if (state.playing)
            stateLabel = "Live";
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
    const movie = viewerMovieDetails();
    viewerRoot.querySelectorAll<HTMLElement>("[data-movie-status]").forEach((element) => {
        if (element.textContent !== movie.status) element.textContent = movie.status;
        element.classList.toggle("error", movie.error);
    });
    viewerRoot.querySelectorAll<HTMLProgressElement>("[data-movie-progress]")
        .forEach((progress) => { progress.value = movie.progress; });
    const caption = viewerRoot.querySelector<HTMLElement>("[data-movie-caption]");
    if (caption) {
        const text = movie.caption ?? "";
        if (caption.textContent !== text) caption.textContent = text;
        const hidden = !movie.captionsEnabled || movie.caption === null;
        if (caption.hidden !== hidden) caption.hidden = hidden;
    }
    const captionButton = viewerRoot.querySelector<HTMLButtonElement>(
        "[data-action='movie-caption-toggle']");
    if (captionButton) {
        const pressed = movie.captionsEnabled ? "true" : "false";
        if (captionButton.getAttribute("aria-pressed") !== pressed)
            captionButton.setAttribute("aria-pressed", pressed);
    }
    viewerRoot.querySelector<HTMLElement>(".cinema-picture")?.classList.toggle(
        "controls-pinned",
        !movie.prepared || !state.playing || state.loading,
    );

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




function interactiveKeyTarget(target: EventTarget | null): target is HTMLElement {
    return target instanceof HTMLElement && (
        target.matches("input, select, textarea, [contenteditable='true']")
        || target.closest(".movie-export-grid") !== null
    );
}

function toggleMovieCaptions(): boolean {
    const details = viewerMovieDetails();
    if (!details.prepared || details.entry?.subtitleCues === 0) return false;
    viewerToggleMovieCaptions();
    return true;
}

function toggleMovieFullscreen(): boolean {
    const player = viewerRoot.querySelector<HTMLElement>(".cinema-player");
    if (!player) return false;
    const movieName = viewerMovieDetails().entry?.name;
    const entering = document.fullscreenElement === null;
    const operation = entering ? player.requestFullscreen() : document.exitFullscreen();
    void operation.catch((error) => {
        console.error("movie fullscreen request failed", error);
        if (viewerMovieDetails().entry?.name !== movieName)
            return;
        viewerReportMovieError(entering
            ? "Full screen was blocked. Allow full-screen access for this site or use the browser's full-screen command."
            : "Could not leave full screen. Press Escape or use the browser's full-screen command.");
    });
    return true;
}

function exitMovieFullscreen(): boolean {
    const fullscreen = document.fullscreenElement;
    if (!(fullscreen instanceof HTMLElement) || !fullscreen.matches(".cinema-player"))
        return false;
    void document.exitFullscreen().catch((error) => {
        console.error("movie fullscreen exit failed", error);
        viewerReportMovieError(
            "Could not leave full screen. Press Escape or use the browser's full-screen command.",
        );
    });
    return true;
}

function focusMovieExports(): boolean {
    const button = viewerRoot.querySelector<HTMLButtonElement>(
        ".movie-export-grid button:not(:disabled)",
    );
    if (!button) return false;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return true;
}

function onViewerKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && exitMovieFullscreen()) {
        event.preventDefault();
        return;
    }
    const library = viewerLibrary();
    if (interactiveKeyTarget(event.target)) {
        if (event.key === "Escape" && event.target instanceof HTMLElement) {
            event.target.blur();
            const transport = viewerTransport();
            if (library.channel === "cinema" && (transport.loading || transport.exporting)) {
                viewerCancelMovieWork();
                event.preventDefault();
            }
        }
        return;
    }
    let handled = true;
    switch (event.key) {
    case " ":
        viewerTogglePlayback();
        break;
    case "ArrowLeft":
    case "ArrowUp":
        viewerMove(-1);
        break;
    case "ArrowRight":
    case "ArrowDown":
        viewerMove(1);
        break;
    case "Enter":
        if (library.channel === "cinema") viewerTogglePlayback();
        else if (library.selectedId) viewerActivate(library.selectedId);
        else handled = false;
        break;
    case "c":
    case "C":
        handled = library.channel === "cinema" && toggleMovieCaptions();
        break;
    case "e":
    case "E":
        handled = library.channel === "cinema" && focusMovieExports();
        break;
    case "Escape": {
        const transport = viewerTransport();
        if (library.channel === "cinema" && (transport.loading || transport.exporting))
            viewerCancelMovieWork();
        else handled = false;
        break;
    }
    default:
        handled = false;
    }
    if (handled) event.preventDefault();
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
        const movieExport = target.closest<HTMLButtonElement>("[data-movie-export]");
        if (movieExport?.dataset.movieExport) {
            const captions = viewerRoot
                .querySelector<HTMLInputElement>("[data-action='movie-captions']")?.checked ?? false;
            viewerExportMovie(movieExport.dataset.movieExport as MovieExportKind, captions);
            return;
        }
        const actionElement = target.closest<HTMLElement>("[data-action]");
        const action = actionElement?.dataset.action;
        const cinemaSkip = Boolean(actionElement?.closest(".cinema-transport"));
        if (action === "play") viewerTogglePlayback();
        if (action === "previous")
            cinemaSkip ? viewerMoveAndPlayMovie(-1) : viewerMove(-1);
        if (action === "next")
            cinemaSkip ? viewerMoveAndPlayMovie(1) : viewerMove(1);
        if (action === "export") viewerExport();
        if (action === "tune") viewerChooseDisc();
        if (action === "movie-cancel") viewerCancelMovieWork();
        if (action === "movie-remove") viewerRemoveMovie();
        if (action === "movie-caption-toggle") toggleMovieCaptions();
        if (action === "movie-fullscreen") toggleMovieFullscreen();
        if (action === "activate-selected") {
            const library = viewerLibrary();
            if (library.selectedId) viewerActivate(library.selectedId);
        }
    });
    viewerRoot.addEventListener("dblclick", (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".cinema-screen")
                && !target.closest("button"))
            toggleMovieFullscreen();
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
    window.addEventListener("keydown", onViewerKey);
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
    const source = viewerAssetSession();
    if (!source || viewerArt || artDiscAttempt === source) return;
    artDiscAttempt = source;
    void loadViewerArt(source).then((art) => {
        if (!art || viewerAssetSession() !== source) return;
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
