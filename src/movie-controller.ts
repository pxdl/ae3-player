import { friendlyError, type DiscSession } from "./disc.ts";
import { MoviePlaybackSession, type MoviePlaybackState } from "./movie-playback.ts";
import { movieSourceComplete } from "./movie-presentation.ts";
import { defaultMovieSelection, type MovieSelection } from "./movies.ts";
import type {
    MovieCacheInfo,
    MovieCatalog,
    MovieEntry,
    MovieExport,
    MovieExportKind,
} from "./movies.ts";

export type MovieStartMode = "preview" | "play";

export interface MovieControllerSnapshot {
    revision: number;
    active: boolean;
    catalog: MovieCatalog | null;
    entry: MovieEntry | null;
    cache: MovieCacheInfo | null;
    prepared: boolean;
    hasIso: boolean;
    sourceRequired: boolean;
    cancellable: boolean;
    loading: boolean;
    exporting: boolean;
    progress: number;
    status: string;
    error: boolean;
    current: number;
    duration: number;
    playing: boolean;
    caption: string | null;
    captionsEnabled: boolean;
    selection: MovieSelection | null;
}

export interface MovieControllerHooks {
    changed(): void;
    pauseOtherMedia(): void;
    deliver(output: MovieExport): void;
}

export class MovieController {
    private readonly hooks: MovieControllerHooks;
    private session: DiscSession | null = null;
    private catalog: MovieCatalog | null = null;
    private catalogResolved = false;
    private catalogLoading = false;
    private selectedName: string | null = null;
    private selection: MovieSelection | null = null;
    private resumeAt = 0;
    private captionsEnabled = true;
    private playback: MoviePlaybackSession | null = null;
    private cache: MovieCacheInfo | null = null;
    private active = false;
    private attaching = false;
    private preparing = false;
    private exporting = false;
    private progress = 0;
    private status = "";
    private error = false;
    private revision = 0;
    private attachAbort: AbortController | null = null;
    private exportAbort: AbortController | null = null;
    private playbackAbort: AbortController | null = null;
    private playIntentGeneration = 0;
    private playbackAutoplay = false;
    private playbackTask: Promise<void> | null = null;
    private playbackDisposal: Promise<void> = Promise.resolve();
    private playbackDisposalWarning: string | null = null;
    private connectionGeneration = 0;

    constructor(hooks: MovieControllerHooks) {
        this.hooks = hooks;
    }

    async connect(session: DiscSession,
                  isCurrent: () => boolean = () => true): Promise<void> {
        if (!isCurrent()) return;
        const generation = ++this.connectionGeneration;
        this.abortAll();
        this.session = null;
        this.catalog = null;
        this.catalogResolved = false;
        this.catalogLoading = false;
        this.selectedName = null;
        this.selection = null;
        this.resumeAt = 0;
        this.cache = null;
        this.attaching = false;
        this.preparing = false;
        this.exporting = false;
        this.progress = 0;
        this.status = "";
        this.error = false;
        await this.disposePlayback();
        if (generation !== this.connectionGeneration || !isCurrent()) return;
        this.session = session;
        this.touch();
        if (this.active) this.requestCatalog();
    }

    setActive(active: boolean): void {
        if (this.active === active) return;
        this.active = active;
        if (active) {
            this.hooks.pauseOtherMedia();
            this.touch();
            this.requestCatalog();
            if (this.selectedName) void this.previewIfAvailable("preview");
            return;
        }
        this.invalidatePlayIntent();
        this.playback?.pause();
        this.playback?.detach();
        this.touch();
    }

    snapshot(): MovieControllerSnapshot {
        const playback = this.selectedPlayback();
        const entry = this.selectedEntry();
        const hasIso = this.session?.movies.hasIso() ?? false;
        const sourceComplete = entry !== null && this.cache !== null
            && movieSourceComplete(entry, this.cache);
        const status = this.currentStatus(playback);
        const cleanupStatus = this.playbackDisposalWarning
            ? `Movie decoder cleanup warning: ${this.playbackDisposalWarning}`
            : "";
        return {
            revision: this.revision,
            active: this.active,
            catalog: this.catalog,
            entry,
            cache: this.cache,
            prepared: playback !== null && playback.state !== "error",
            hasIso,
            sourceRequired: this.catalogResolved && (
                this.catalog === null
                || (!hasIso && entry !== null && !sourceComplete)
            ),
            cancellable: this.attachAbort !== null || this.exportAbort !== null
                || this.playbackAbort !== null || this.playbackBusy(playback),
            loading: this.catalogLoading || this.attaching || this.preparing,
            exporting: this.exporting,
            progress: this.progress,
            status: [status, cleanupStatus].filter(Boolean).join(" · "),
            error: this.error || playback?.state === "error"
                || this.playbackDisposalWarning !== null,
            current: playback?.currentTime ?? 0,
            duration: playback?.duration ?? entry?.duration ?? 0,
            playing: playback?.playing ?? false,
            caption: playback?.caption ?? null,
            captionsEnabled: this.captionsEnabled,
            selection: this.selection,
        };
    }

    select(name: string, mode: MovieStartMode): void {
        if (this.exporting || this.attaching) return;
        const entry = this.catalog?.entries.find(candidate => candidate.name === name);
        if (!entry) return;
        if (this.selectedName === name) {
            if (this.active) this.startPreparation(mode);
            return;
        }

        this.invalidatePlayIntent();
        const priorTask = this.playbackTask;
        this.playback?.pause();
        this.selectedName = name;
        this.selection = defaultMovieSelection(entry);
        this.resumeAt = 0;
        this.cache = null;
        this.progress = 0;
        this.status = "";
        this.error = false;
        this.touch();
        void this.finishSelection(name, mode, priorTask).catch(cause => {
            if (this.selectedName === name) this.fail(cause);
        });
    }

    move(delta: number, mode: MovieStartMode): void {
        const entries = this.catalog?.entries;
        if (!entries?.length || this.exporting || this.attaching) return;
        const current = Math.max(0, entries.findIndex(entry => entry.name === this.selectedName));
        const index = (current + delta % entries.length + entries.length) % entries.length;
        this.select(entries[index]!.name, mode);
    }

    togglePlayback(): void {
        if (!this.active) return;
        const playback = this.selectedPlayback();
        if (playback?.playing) {
            playback.pause();
            return;
        }
        if (this.selectedName) this.select(this.selectedName, "play");
    }

    seek(ratio: number): void {
        const playback = this.selectedPlayback();
        if (!this.active || !playback || !Number.isFinite(ratio)) return;
        this.seekPlayback(playback, playback.duration * Math.min(Math.max(ratio, 0), 1));
    }

    seekBy(seconds: number): void {
        const playback = this.selectedPlayback();
        if (!this.active || !playback || !Number.isFinite(seconds)) return;
        this.seekPlayback(playback, playback.currentTime + seconds);
    }

    attach(canvas: HTMLCanvasElement): void {
        const playback = this.selectedPlayback();
        if (!this.active || !playback) return;
        void playback.attach(canvas).catch(cause => {
            if (this.playback !== playback || !this.active) return;
            this.fail(cause);
        });
    }

    toggleCaptions(): void {
        this.captionsEnabled = !this.captionsEnabled;
        this.selectedPlayback()?.setCaptionsEnabled(this.captionsEnabled);
        this.touch();
    }

    setSubtitleTrack(id: string | null): void {
        const entry = this.selectedEntry();
        if (!entry || !this.selection || this.exporting || this.attaching
                || (id !== null && !entry.subtitleTracks.some(track => track.id === id)))
            return;
        this.selection = { ...this.selection, subtitleId: id };
        this.selectedPlayback()?.setSubtitleTrack(id);
        this.touch();
    }

    setAudioTrack(index: number): void {
        const entry = this.selectedEntry();
        if (!entry || !this.selection || this.exporting || this.attaching
                || !entry.audioTracks.some(track => track.index === index)
                || this.selection.audioTrack === index)
            return;
        const playback = this.selectedPlayback();
        const mode = playback?.playing || this.playbackAutoplay ? "play" : "preview";
        this.resumeAt = playback?.currentTime ?? this.resumeAt;
        this.invalidatePlayIntent();
        const priorTask = this.playbackTask;
        playback?.pause();
        this.selection = { ...this.selection, audioTrack: index };
        this.status = "Switching audio language…";
        this.error = false;
        this.touch();
        void this.finishSelection(entry.name, mode, priorTask).catch(cause => {
            if (this.selectedName === entry.name && this.selection?.audioTrack === index)
                this.fail(cause);
        });
    }

    async attachIso(file: File): Promise<void> {
        if (!this.session || this.catalogLoading || this.attaching
                || this.preparing || this.exporting)
            return;
        const target = this.session;
        this.invalidatePlayIntent();
        const priorTask = this.playbackTask;
        if (priorTask) await priorTask;
        await this.disposePlayback();
        if (this.session !== target) return;

        const controller = new AbortController();
        this.attachAbort = controller;
        this.attaching = true;
        this.progress = 0;
        this.status = "Reading disc image…";
        this.error = false;
        this.touch();
        try {
            await target.movies.attachIso(file, (value, stage) => {
                if (this.attachAbort !== controller || this.session !== target) return;
                this.progress = value;
                this.status = stage;
            }, controller.signal);
            controller.signal.throwIfAborted();
            if (this.session !== target) return;
            this.catalog = await target.movies.catalog(controller.signal);
            this.catalogResolved = true;
            controller.signal.throwIfAborted();
            if (this.session !== target) return;
            if (!this.catalog?.entries.some(entry => entry.name === this.selectedName))
                this.selectedName = this.catalog?.entries[0]?.name ?? null;
            const selected = this.selectedEntry();
            this.selection = selected ? defaultMovieSelection(selected) : null;
            this.resumeAt = 0;
            const unavailable = this.catalog?.issues.length ?? 0;
            this.status = `${this.catalog?.entries.length ?? 0} movies indexed locally`
                + (unavailable ? `; ${unavailable} unavailable` : "");
            this.error = false;
            if (this.selectedName) await this.refreshCache(this.selectedName, controller.signal);
        } catch (cause) {
            if (this.attachAbort === controller && this.session === target)
                this.reportOperationError(cause, controller.signal, "Movie scan cancelled.");
        } finally {
            if (this.attachAbort === controller) {
                this.attachAbort = null;
                this.attaching = false;
                this.touch();
            }
        }
        if (this.active && this.session === target
                && !controller.signal.aborted && !this.error)
            await this.previewIfAvailable("preview");
    }

    startExport(kind: MovieExportKind, captions: boolean): void {
        if (!this.session || !this.selectedName || this.attaching || this.preparing
                || this.exporting)
            return;
        void this.exportSelected(kind, captions);
    }

    cancel(): void {
        let cancelling = false;
        const cancellingStart = this.playbackAbort !== null;
        if (cancellingStart) {
            this.invalidatePlayIntent();
            cancelling = true;
        } else {
            this.playIntentGeneration++;
        }
        if (this.attachAbort) {
            this.attachAbort.abort();
            cancelling = true;
        }
        if (this.exportAbort) {
            this.exportAbort.abort();
            cancelling = true;
        }
        const playback = this.selectedPlayback();
        if (this.playbackBusy(playback)) {
            cancelling = true;
            const name = playback!.name;
            void this.disposePlayback().then(() => {
                if (this.selectedName !== name) return;
                this.status = "Playback cancelled. Press Play to try again.";
                this.error = false;
                this.touch();
            }).catch(cause => {
                if (this.selectedName !== name) return;
                this.fail(cause);
            });
        }
        if (!cancelling) return;
        this.status = cancellingStart && playback === null
            ? "Playback start cancelled. Press Play to try again."
            : "Cancelling…";
        this.error = false;
        this.touch();
    }

    removeCached(): void {
        if (!this.session || !this.selectedName || this.attaching || this.preparing
                || this.exporting)
            return;
        const target = this.session;
        const name = this.selectedName;
        this.invalidatePlayIntent();
        void (async () => {
            if (this.playback?.name === name) await this.disposePlayback();
            await target.movies.remove(name);
            if (this.session !== target || this.selectedName !== name) return;
            this.cache = await target.movies.cacheInfo(name);
            if (this.session !== target || this.selectedName !== name) return;
            this.status = "Cached copies removed. Original disc files were untouched.";
            this.error = false;
            this.touch();
        })().catch(cause => {
            if (this.session !== target || this.selectedName !== name) return;
            this.fail(cause);
        });
    }

    reportError(message: string): void {
        this.status = message;
        this.error = true;
        this.touch();
    }

    async dispose(): Promise<void> {
        ++this.connectionGeneration;
        this.abortAll();
        this.active = false;
        this.session = null;
        await this.disposePlayback();
        this.catalog = null;
        this.catalogResolved = false;
        this.catalogLoading = false;
        this.selectedName = null;
        this.selection = null;
        this.resumeAt = 0;
        this.cache = null;
        this.attaching = false;
        this.preparing = false;
        this.exporting = false;
        this.progress = 0;
        this.status = "";
        this.error = false;
        this.touch();
    }

    private selectedEntry(): MovieEntry | null {
        return this.catalog?.entries.find(entry => entry.name === this.selectedName) ?? null;
    }

    private selectedPlayback(): MoviePlaybackSession | null {
        return this.playback?.name === this.selectedName ? this.playback : null;
    }

    private touch(): void {
        this.revision++;
        this.hooks.changed();
    }

    private requestCatalog(): void {
        const target = this.session;
        if (!target || this.catalogResolved || this.catalogLoading) return;
        const generation = this.connectionGeneration;
        this.catalogLoading = true;
        this.status = "Loading movie catalog…";
        this.error = false;
        this.touch();
        void this.loadCatalog(target, generation);
    }

    private async loadCatalog(target: DiscSession, generation: number): Promise<void> {
        try {
            const catalog = await target.movies.catalog();
            if (this.session !== target || generation !== this.connectionGeneration) return;
            this.catalogLoading = false;
            this.catalog = catalog;
            this.catalogResolved = true;
            this.selectedName = catalog?.entries[0]?.name ?? null;
            this.selection = catalog?.entries[0]
                ? defaultMovieSelection(catalog.entries[0]) : null;
            this.resumeAt = 0;
            const unavailable = catalog?.issues.length ?? 0;
            this.status = catalog
                ? `${catalog.entries.length} movies indexed locally`
                    + (unavailable ? `; ${unavailable} unavailable` : "")
                : "Attach the source ISO once to scan its movie archive.";
            this.error = false;
            this.touch();
            if (!this.selectedName) return;
            if (this.active) await this.previewIfAvailable("preview");
            else await this.refreshCache(this.selectedName);
        } catch (cause) {
            if (this.session !== target || generation !== this.connectionGeneration) return;
            this.catalogLoading = false;
            this.catalogResolved = true;
            this.fail(cause);
        }
    }

    private invalidatePlayIntent(): void {
        this.playIntentGeneration++;
        this.playbackAutoplay = false;
        this.playbackAbort?.abort();
    }

    private abortAll(): void {
        this.invalidatePlayIntent();
        this.playbackAbort = null;
        this.playbackTask = null;
        this.attachAbort?.abort();
        this.exportAbort?.abort();
        this.attachAbort = null;
        this.exportAbort = null;
        this.playback?.pause();
        this.playback?.detach();
    }

    private startIsCurrent(target: DiscSession, name: string,
                           controller: AbortController, generation: number,
                           playback?: MoviePlaybackSession): boolean {
        return this.playbackAbort === controller && !controller.signal.aborted
            && this.session === target && this.selectedName === name && this.active
            && this.playIntentGeneration === generation
            && (playback === undefined || this.playback === playback);
    }

    private disposePlayback(): Promise<void> {
        const playback = this.playback;
        this.playback = null;
        if (!playback) return this.playbackDisposal;
        const disposal = this.playbackDisposal.then(() => playback.dispose());
        this.playbackDisposal = disposal.then(
            () => {
                this.playbackDisposalWarning = null;
            },
            cause => {
                this.playbackDisposalWarning = friendlyError(cause);
                console.error("movie playback disposal failed", cause);
            },
        );
        return this.playbackDisposal;
    }

    private async refreshCache(name: string, signal?: AbortSignal): Promise<void> {
        const target = this.session;
        if (!target) return;
        try {
            const cache = await target.movies.cacheInfo(name, signal);
            if (this.session !== target || this.selectedName !== name) return;
            this.cache = cache;
            this.touch();
        } catch (cause) {
            if (signal?.aborted) throw cause;
            if (this.session !== target || this.selectedName !== name) return;
            this.fail(cause);
        }
    }

    private async finishSelection(name: string, mode: MovieStartMode,
                                  priorTask: Promise<void> | null): Promise<void> {
        const target = this.session;
        const generation = this.playIntentGeneration;
        if (priorTask) await priorTask;
        if (this.session !== target || this.playIntentGeneration !== generation) return;
        await this.disposePlayback();
        if (this.session !== target || this.playIntentGeneration !== generation) return;
        if (this.selectedName !== name || !this.active) {
            if (this.selectedName === name) await this.refreshCache(name);
            return;
        }
        await this.previewIfAvailable(mode);
    }

    private startPreparation(mode: MovieStartMode): void {
        if (this.playbackTask) {
            if (mode === "play") this.playbackAutoplay = true;
            return;
        }
        const task = this.prepareSelected(mode);
        this.playbackTask = task;
        void task.catch(cause => {
            if (this.playbackTask === task) this.fail(cause);
        }).finally(() => {
            if (this.playbackTask === task) this.playbackTask = null;
        }).catch(cause => {
            console.error("movie preparation failure handler failed", cause);
        });
    }

    private async prepareSelected(mode: MovieStartMode): Promise<void> {
        if (!this.session || !this.selectedName || this.exporting || this.attaching
                || !this.active)
            return;
        const target = this.session;
        const name = this.selectedName;
        const selection = this.selection;
        const resumeAt = this.resumeAt;
        if (!selection) return;
        const existing = this.selectedPlayback();
        if (existing && existing.state !== "error") {
            if (mode !== "play") return;
            this.hooks.pauseOtherMedia();
            try {
                await existing.play();
                if (this.session !== target || this.selectedName !== name
                        || !this.active || this.playback !== existing)
                    existing.pause();
            } catch (cause) {
                if (this.session === target && this.selectedName === name
                        && this.active && this.playback === existing)
                    this.fail(cause);
            }
            return;
        }

        const generation = ++this.playIntentGeneration;
        const controller = new AbortController();
        this.playbackAbort = controller;
        this.playbackAutoplay = mode === "play";
        this.preparing = true;
        this.progress = 0;
        this.status = "Loading movie…";
        this.error = false;
        this.touch();
        try {
            const prepared = await target.movies.prepare(name, value => {
                if (!this.startIsCurrent(target, name, controller, generation)) return;
                this.progress = value;
                this.status = "Loading movie…";
            }, controller.signal, selection);
            controller.signal.throwIfAborted();
            if (!this.startIsCurrent(target, name, controller, generation)) return;
            await this.disposePlayback();
            if (!this.startIsCurrent(target, name, controller, generation)) return;
            let playback: MoviePlaybackSession;
            playback = new MoviePlaybackSession(prepared, {
                stateChanged() {},
                captionChanged() {},
                error: cause => {
                    if (this.playback !== playback) return;
                    this.fail(cause);
                },
            });
            if (!this.startIsCurrent(target, name, controller, generation)) {
                await playback.dispose();
                return;
            }
            this.playback = playback;
            playback.setSubtitleTrack(this.selection?.subtitleId ?? null);
            playback.setCaptionsEnabled(this.captionsEnabled);
            if (resumeAt > 0) await playback.seek(resumeAt);
            if (!this.startIsCurrent(target, name, controller, generation, playback)) return;
            this.resumeAt = 0;
            this.cache = prepared.cache;
            this.progress = 1;
            if (this.playbackAutoplay) {
                this.hooks.pauseOtherMedia();
                await playback.play();
                if (!this.startIsCurrent(target, name, controller, generation, playback)) {
                    playback.pause();
                    return;
                }
            }
            this.status = playbackStatus(playback.state, this.status);
            this.error = false;
            this.touch();
        } catch (cause) {
            if (this.startIsCurrent(target, name, controller, generation))
                this.reportOperationError(cause, controller.signal, "Movie loading cancelled.");
        } finally {
            if (this.playbackAbort === controller) {
                this.playbackAbort = null;
                this.playbackAutoplay = false;
                this.preparing = false;
                this.touch();
            }
        }
    }

    private async previewIfAvailable(mode: MovieStartMode): Promise<void> {
        const target = this.session;
        const name = this.selectedName;
        const entry = this.selectedEntry();
        if (!target || !name || !entry || !this.active) return;
        if (this.selectedPlayback()) {
            this.startPreparation(mode);
            return;
        }
        try {
            const cache = await target.movies.cacheInfo(name);
            if (this.session !== target || this.selectedName !== name || !this.active
                    || this.selectedEntry() !== entry)
                return;
            this.cache = cache;
            this.touch();
            if (!target.movies.hasIso() && !movieSourceComplete(entry, cache)) {
                this.status = "Attach the source ISO to preview this movie.";
                this.error = false;
                this.touch();
                return;
            }
            this.startPreparation(mode);
        } catch (cause) {
            if (this.session !== target || this.selectedName !== name || !this.active) return;
            this.fail(cause);
        }
    }

    private async exportSelected(kind: MovieExportKind, captions: boolean): Promise<void> {
        const target = this.session;
        const name = this.selectedName;
        const selection = this.selection;
        if (!target || !name || !selection) return;
        const controller = new AbortController();
        this.exportAbort = controller;
        this.exporting = true;
        this.progress = 0;
        if (kind === "mp4")
            this.status = "Starting Fast MP4 export…";
        else if (kind === "mkv")
            this.status = "Starting Lossless MKV export…";
        else
            this.status = `Preparing ${kind} export…`;
        this.error = false;
        this.touch();
        try {
            const output = await target.movies.export(name, kind, captions, (value, stage) => {
                if (this.exportAbort !== controller || this.session !== target
                        || this.selectedName !== name)
                    return;
                this.progress = value;
                this.status = stage;
            }, controller.signal, selection);
            controller.signal.throwIfAborted();
            if (this.session !== target || this.selectedName !== name) return;
            this.hooks.deliver(output);
            this.cache = await target.movies.cacheInfo(name, controller.signal);
            controller.signal.throwIfAborted();
            if (this.session !== target || this.selectedName !== name) return;
            this.progress = 1;
            this.status = `${output.filename} ready`;
            this.error = false;
        } catch (cause) {
            if (this.exportAbort === controller && this.session === target
                    && this.selectedName === name)
                this.reportOperationError(cause, controller.signal, "Export cancelled.");
        } finally {
            if (this.exportAbort === controller) {
                this.exportAbort = null;
                this.exporting = false;
                this.touch();
            }
        }
    }

    private seekPlayback(playback: MoviePlaybackSession, seconds: number): void {
        void playback.seek(seconds).catch(cause => {
            if (this.playback !== playback) return;
            this.fail(cause);
        });
    }

    private playbackBusy(playback: MoviePlaybackSession | null): boolean {
        return playback !== null && (playback.state === "initializing-decoder"
            || playback.state === "priming" || playback.state === "seeking"
            || playback.state === "buffering");
    }

    private currentStatus(playback: MoviePlaybackSession | null): string {
        if (this.error) return this.status;
        if (!this.attaching && !this.preparing && !this.exporting && playback)
            return playbackStatus(playback.state, this.status);
        return this.status;
    }

    private reportOperationError(cause: unknown, signal: AbortSignal,
                                 cancelledStatus: string): void {
        if (isCancellation(cause, signal)) {
            this.status = cancelledStatus;
            this.error = false;
            return;
        }
        this.fail(cause, false);
    }

    private fail(cause: unknown, notify = true): void {
        console.error("movie operation failed", cause);
        this.status = friendlyError(cause);
        this.error = true;
        if (notify) this.touch();
    }
}

function playbackStatus(state: MoviePlaybackState, fallback: string): string {
    switch (state) {
    case "idle":
    case "initializing-decoder":
    case "priming": return "Loading movie…";
    case "ready": return "Ready.";
    case "playing": return "Playing.";
    case "paused": return "Paused.";
    case "seeking": return "Seeking…";
    case "buffering": return "Buffering…";
    case "ended": return "Ended.";
    case "error": return fallback;
    case "disposed": return "";
    }
}

function isCancellation(cause: unknown, signal: AbortSignal): boolean {
    return signal.aborted && (cause === signal.reason
        || (cause instanceof DOMException && cause.name === "AbortError"));
}
