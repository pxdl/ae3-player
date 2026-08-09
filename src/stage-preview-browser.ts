import { download } from "./export.ts";
import {
    StagePreviewDecodeCancelledError,
    StagePreviewDecoder,
} from "./stage-preview-decoder.ts";
import type {
    StagePreviewCatalog,
    StagePreviewEntry,
    StagePreviewFrame,
    StagePreviewStore,
} from "./stage-previews.ts";

export interface StagePreviewBrowserHooks {
    status(message: string, error?: boolean): void;
    friendlyError(cause: unknown): string;
}

interface DecodedSelection {
    key: string;
    frame: number;
    image: ImageData;
}

const $ = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

function escapeMarkup(value: string | number): string {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function hex(value: number, width = 0): string {
    return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteDetail(bytes: number): string {
    const units = bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
        : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
    return `${hex(bytes)} · ${units}`;
}

function metadataSection(title: string,
                         rows: readonly (readonly [string, string])[]): string {
    return `<section><h3>${escapeMarkup(title)}</h3><dl>${rows.map(([label, value]) =>
        `<div><dt>${escapeMarkup(label)}</dt><dd>${escapeMarkup(value)}</dd></div>`).join("")}</dl></section>`;
}

function drawImage(canvas: HTMLCanvasElement, image: ImageData): void {
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context)
        throw new Error("2D canvas is unavailable");
    context.putImageData(image, 0, 0);
    canvas.hidden = false;
}

async function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    const { promise, resolve, reject } = Promise.withResolvers<Blob>();
    canvas.toBlob(blob => blob
        ? resolve(blob)
        : reject(new Error("PNG encoding failed")), "image/png");
    return promise;
}

export class StagePreviewBrowser {
    readonly #hooks: StagePreviewBrowserHooks;
    #store: StagePreviewStore | null = null;
    #catalog: StagePreviewCatalog | null = null;
    #selected: StagePreviewEntry | null = null;
    #frame = 0;
    #decoder: StagePreviewDecoder | null = null;
    #decoded: DecodedSelection | null = null;
    #catalogPending: Promise<void> | null = null;
    #selectionGeneration = 0;
    #exporting = false;
    #open = false;

    constructor(hooks: StagePreviewBrowserHooks) {
        this.#hooks = hooks;
        $("stage-preview-list").addEventListener("click", event => {
            const button = (event.target as Element)
                .closest<HTMLButtonElement>("[data-stage-preview-key]");
            const stage = this.#catalog?.stages.find(candidate =>
                candidate.key === button?.dataset.stagePreviewKey);
            if (stage) void this.#select(stage, 0);
        });
        $("stage-preview-frames").addEventListener("click", event => {
            const button = (event.target as Element)
                .closest<HTMLButtonElement>("[data-stage-preview-frame]");
            const frame = Number(button?.dataset.stagePreviewFrame);
            if (this.#selected && Number.isInteger(frame) && frame >= 0 && frame < 8)
                void this.#select(this.#selected, frame);
        });
        $("stage-preview-export-png").onclick = () => void this.#export("png");
        $("stage-preview-export-ipc").onclick = () => void this.#export("ipc");
        $("stage-preview-export-tm2").onclick = () => void this.#export("tm2");
        $("stage-preview-export-archive").onclick = () => void this.#export("archive");
        $<HTMLInputElement>("stage-preview-iso").onchange = () =>
            void this.#reconnectIso();
        this.#updateActions();
    }

    setStore(store: StagePreviewStore): void {
        if (this.#store === store) return;
        this.#selectionGeneration++;
        this.#store = store;
        this.#catalog = null;
        this.#selected = null;
        this.#decoded = null;
        this.#catalogPending = null;
        this.#renderList();
        this.#updateActions();
        if (this.#open) void this.#ensureCatalog();
    }

    open(): void {
        this.#open = true;
        void this.#ensureCatalog();
    }

    close(): void {
        this.#open = false;
        this.#selectionGeneration++;
    }

    dispose(): void {
        this.#selectionGeneration++;
        this.#decoder?.dispose();
        this.#decoder = null;
    }

    snapshot(): object {
        return {
            catalog: this.#catalog,
            selected: this.#selected?.key ?? null,
            frame: this.#frame,
            decoded: this.#decoded !== null,
            exporting: this.#exporting,
        };
    }

    handleKey(event: KeyboardEvent): boolean {
        const stages = this.#catalog?.stages;
        if (!stages?.length) return false;
        const selected = Math.max(0, stages.findIndex(stage =>
            stage.key === this.#selected?.key));
        switch (event.key) {
            case "ArrowUp":
            case "ArrowDown": {
                const delta = event.key === "ArrowUp" ? -1 : 1;
                const index = (selected + delta + stages.length) % stages.length;
                void this.#select(stages[index]!, 0);
                requestAnimationFrame(() => {
                    $("stage-preview-list")
                        .querySelector(`[data-stage-preview-key="${CSS.escape(stages[index]!.key)}"]`)
                        ?.scrollIntoView({ block: "nearest" });
                });
                return true;
            }
            case "ArrowLeft":
            case "ArrowRight": {
                if (!this.#selected) return false;
                const delta = event.key === "ArrowLeft" ? -1 : 1;
                void this.#select(this.#selected, (this.#frame + delta + 8) % 8);
                return true;
            }
            case "e":
            case "E":
                void this.#export("png");
                return true;
            case "x":
            case "X":
                void this.#export("ipc");
                return true;
            case "t":
            case "T":
                void this.#export("tm2");
                return true;
            case "a":
            case "A":
                void this.#export("archive");
                return true;
            default:
                return false;
        }
    }

    async #ensureCatalog(): Promise<void> {
        if (!this.#store || this.#catalog || this.#catalogPending) return;
        const store = this.#store;
        const setup = $("stage-preview-setup");
        const setupStatus = $("stage-preview-setup-status");
        const progress = $<HTMLProgressElement>("stage-preview-progress");
        setup.hidden = false;
        $("stage-preview-workspace").hidden = true;
        setupStatus.classList.remove("err");
        setupStatus.textContent = "Reading and validating stages.bin…";
        progress.hidden = false;
        progress.removeAttribute("value");
        $("stage-preview-iso-pick").hidden = true;

        const pending = (async () => {
            try {
                const catalog = await store.catalog();
                if (this.#store !== store) return;
                if (!catalog) {
                    progress.hidden = true;
                    if (store.hasIso()) {
                        setupStatus.textContent = "Stage previews are unavailable on this disc. No regional stages.bin archive was found.";
                        this.#hooks.status("Stage previews are unavailable on this disc");
                    } else {
                        setupStatus.textContent = "The stage archive is not cached yet. Reconnect the same ISO to load it once.";
                        $("stage-preview-iso-pick").hidden = false;
                        this.#hooks.status("Reconnect the same ISO to open stage previews");
                    }
                    return;
                }
                this.#installCatalog(catalog);
            } catch (cause) {
                if (this.#store !== store) return;
                progress.hidden = true;
                setupStatus.textContent = this.#hooks.friendlyError(cause);
                setupStatus.classList.add("err");
                $("stage-preview-iso-pick").hidden = store.hasIso();
                this.#hooks.status(setupStatus.textContent, true);
            }
        })();
        this.#catalogPending = pending;
        try {
            await pending;
        } finally {
            if (this.#catalogPending === pending) this.#catalogPending = null;
        }
    }

    #installCatalog(catalog: StagePreviewCatalog): void {
        this.#catalog = catalog;
        $("stage-preview-setup").hidden = true;
        $("stage-preview-workspace").hidden = false;
        $("stage-preview-count").textContent = `${catalog.stages.length} SLOTS`;
        this.#renderList();
        this.#updateActions();
        this.#hooks.status(`${catalog.stages.length} stage previews · choose _00 through _07`);
        const stage = catalog.stages[0];
        if (stage) void this.#select(stage, 0);
    }

    #renderList(): void {
        const list = $("stage-preview-list");
        const stages = this.#catalog?.stages ?? [];
        list.innerHTML = stages.map(stage =>
            `<li class="stage-preview-row${stage.key === this.#selected?.key ? " selected" : ""}">
                <button type="button" data-stage-preview-key="${escapeMarkup(stage.key)}"
                    aria-current="${stage.key === this.#selected?.key ? "true" : "false"}">
                    <strong>${escapeMarkup(stage.key)}</strong>
                    <span>SLOT ${stage.slotIndex.toString().padStart(2, "0")}</span>
                </button>
            </li>`).join("");
        if (stages.length === 0)
            list.innerHTML = '<li class="stage-preview-empty">Open the tab to read the archive.</li>';
    }

    async #select(stage: StagePreviewEntry, frameIndex: number): Promise<void> {
        const store = this.#store;
        const frame = stage.frames[frameIndex];
        if (!store || !frame) return;
        const generation = ++this.#selectionGeneration;
        this.#selected = stage;
        this.#frame = frameIndex;
        this.#decoded = null;
        this.#renderList();
        this.#renderFrameButtons();
        this.#renderInspector(stage, frame);
        this.#updateActions();
        const previewCanvas = $<HTMLCanvasElement>("stage-preview-canvas");
        const titleCanvas = $<HTMLCanvasElement>("stage-preview-title");
        previewCanvas.hidden = true;
        titleCanvas.hidden = true;
        this.#setPreviewState(`Decoding ${frame.member.name}.ipc…`);

        try {
            const [title, ipc] = await Promise.all([
                store.decodeTitle(stage.title),
                store.readFrame(frame),
            ]);
            if (generation !== this.#selectionGeneration) return;
            drawImage(titleCanvas, title);
            this.#decoder ??= new StagePreviewDecoder();
            const image = await this.#decoder.decode(ipc, frame.member.name);
            if (generation !== this.#selectionGeneration) return;
            drawImage(previewCanvas, image);
            this.#decoded = { key: stage.key, frame: frameIndex, image };
            this.#setPreviewState("");
            this.#updateActions();
            this.#hooks.status(`${frame.member.name}.ipc · 256×256 · IPU control ${hex(frame.ipc.control, 4)}`);
        } catch (cause) {
            if (generation !== this.#selectionGeneration
                || cause instanceof StagePreviewDecodeCancelledError)
                return;
            const message = this.#hooks.friendlyError(cause);
            this.#setPreviewState(message, true);
            this.#hooks.status(message, true);
        }
    }

    #renderFrameButtons(): void {
        for (const button of $("stage-preview-frames")
            .querySelectorAll<HTMLButtonElement>("[data-stage-preview-frame]")) {
            const frame = Number(button.dataset.stagePreviewFrame);
            button.setAttribute("aria-pressed", String(frame === this.#frame));
        }
    }

    #renderInspector(stage: StagePreviewEntry, frame: StagePreviewFrame): void {
        const catalog = this.#catalog;
        if (!catalog) return;
        $("stage-preview-inspector").innerHTML = [
            metadataSection("ARCHIVE", [
                ["Source", catalog.sourcePath],
                ["Stored bytes", byteDetail(catalog.archiveSize)],
                ["Slots", String(catalog.slotCount)],
                ["Slot capacity", byteDetail(catalog.slotSize)],
                ["Stored stride", byteDetail(catalog.storedSlotSize)],
                ["Storage", catalog.compressed ? "SZ-compressed slots" : "Raw fixed slots"],
            ]),
            metadataSection("STAGE SLOT", [
                ["Raw key", stage.key],
                ["Slot index", String(stage.slotIndex)],
                ["IPC members", String(stage.frames.length)],
                ["Title member", stage.title.member.name],
                ["Title bytes", byteDetail(stage.title.member.size)],
                ["Title picture", `${stage.title.picture.width}×${stage.title.picture.height}`],
                ["TIM2 image type", hex(stage.title.picture.imageType, 2)],
            ]),
            metadataSection(`IPC FRAME _${frame.frame.toString().padStart(2, "0")}`, [
                ["Member", frame.member.name],
                ["Member bytes", byteDetail(frame.member.size)],
                ["Dimensions", `${frame.ipc.width}×${frame.ipc.height}`],
                ["Version", hex(frame.ipc.version, 4)],
                ["Format", hex(frame.ipc.format, 4)],
                ["IPU control", hex(frame.ipc.control, 4)],
                ["Inserted flags", hex(frame.ipc.ipuFlags, 2)],
                ["Decode command", hex(frame.ipc.decodeCommand, 2)],
                ["DMA qwords", String(frame.ipc.qwordCount)],
                ["Frame data", byteDetail(frame.ipc.frameDataSize)],
                ["Qword padding", byteDetail(frame.ipc.paddingSize)],
            ]),
        ].join("");
    }

    #setPreviewState(message: string, error = false): void {
        const state = $("stage-preview-state");
        state.textContent = message;
        state.hidden = message.length === 0;
        state.classList.toggle("err", error);
    }

    #updateActions(): void {
        const selected = this.#selected !== null;
        const decoded = this.#decoded?.key === this.#selected?.key
            && this.#decoded?.frame === this.#frame;
        $<HTMLButtonElement>("stage-preview-export-png").disabled =
            this.#exporting || !decoded;
        $<HTMLButtonElement>("stage-preview-export-ipc").disabled =
            this.#exporting || !selected;
        $<HTMLButtonElement>("stage-preview-export-tm2").disabled =
            this.#exporting || !selected;
        $<HTMLButtonElement>("stage-preview-export-archive").disabled =
            this.#exporting || !this.#catalog;
    }

    async #export(kind: "png" | "ipc" | "tm2" | "archive"): Promise<void> {
        const store = this.#store;
        const stage = this.#selected;
        const frame = stage?.frames[this.#frame];
        if (!store || this.#exporting) return;
        if (kind !== "archive" && (!stage || !frame)) return;
        if (kind === "png" && (this.#decoded?.key !== stage!.key
            || this.#decoded.frame !== this.#frame))
            return;
        this.#exporting = true;
        this.#updateActions();
        try {
            if (kind === "archive") {
                const archive = await store.readArchive();
                if (!archive) throw new Error("stage-preview archive is unavailable");
                download(archive, "stages.bin", "application/octet-stream");
            } else if (kind === "ipc") {
                download(await store.readFrame(frame!), `${frame!.member.name}.ipc`,
                    "application/octet-stream");
            } else if (kind === "tm2") {
                download(await store.readTitle(stage!.title), `${stage!.title.member.name}.tm2`,
                    "application/octet-stream");
            } else {
                const blob = await pngBlob($<HTMLCanvasElement>("stage-preview-canvas"));
                download(blob, `${frame!.member.name}.png`, "image/png");
            }
            this.#hooks.status(`Exported ${kind === "archive" ? "stages.bin" : kind.toUpperCase()}`);
        } catch (cause) {
            const message = this.#hooks.friendlyError(cause);
            this.#hooks.status(message, true);
            this.#setPreviewState(message, true);
        } finally {
            this.#exporting = false;
            this.#updateActions();
        }
    }

    async #reconnectIso(): Promise<void> {
        const input = $<HTMLInputElement>("stage-preview-iso");
        const file = input.files?.[0];
        const store = this.#store;
        if (!file || !store) return;
        const setupStatus = $("stage-preview-setup-status");
        const progress = $<HTMLProgressElement>("stage-preview-progress");
        setupStatus.classList.remove("err");
        setupStatus.textContent = "Reading disc identity…";
        progress.hidden = false;
        progress.removeAttribute("value");
        input.disabled = true;
        try {
            await store.attachIso(file);
            this.#catalog = null;
            await this.#ensureCatalog();
        } catch (cause) {
            setupStatus.textContent = this.#hooks.friendlyError(cause);
            setupStatus.classList.add("err");
            progress.hidden = true;
            this.#hooks.status(setupStatus.textContent, true);
        } finally {
            input.disabled = false;
            input.value = "";
        }
    }
}
