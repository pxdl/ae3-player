import { DiscReportStore } from "./disc-report.ts";
import {
    formatDiscSupportMarkdown,
    type DiscSupportFamily,
    type DiscSupportProgress,
    type DiscSupportReport,
    type DiscSupportStatus,
} from "./vendor/extract/index.ts";

interface DiscReportViewDependencies {
    status(message: string, error?: boolean): void;
    friendlyError(error: unknown): string;
}

const FAMILY_ORDER: readonly DiscSupportFamily[] = ["images", "effects", "fmv"];
const $ = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

function count(value: number): string {
    return value.toLocaleString("en-US");
}

function counted(value: number, noun: string): string {
    return `${count(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function bytes(value: number): string {
    const units = ["B", "KB", "MB", "GB"] as const;
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit++;
    }
    const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[unit]}`;
}

function statusLabel(status: DiscSupportStatus): string {
    switch (status) {
        case "passed": return "Passed";
        case "partial": return "Partial";
        case "failed": return "Failed";
        case "not-found": return "Not found";
    }
}

function appendCell(row: HTMLTableRowElement, value: string): void {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
}

export class DiscReportView {
    private store: DiscReportStore | null = null;
    private report: DiscSupportReport | null = null;
    private active = false;
    private busy = false;
    private readonly dependencies: DiscReportViewDependencies;
    private generation = 0;
    constructor(dependencies: DiscReportViewDependencies) {
        this.dependencies = dependencies;
        $<HTMLButtonElement>("report-run").onclick = () => void this.runReport();
        $<HTMLButtonElement>("report-copy-json").onclick = () =>
            void this.copyReport("json");
        $<HTMLButtonElement>("report-copy-markdown").onclick = () =>
            void this.copyReport("markdown");
        $<HTMLInputElement>("report-iso").onchange = () => void this.attachIso();
        this.renderWaiting();
    }

    setStore(store: DiscReportStore | null): void {
        if (this.store === store) return;
        this.generation++;
        this.store = store;
        this.report = null;
        this.busy = false;
        this.renderWaiting();
        if (this.active && store) void this.loadCached(store, this.generation);
    }

    open(): void {
        this.active = true;
        if (this.store && !this.report && !this.busy)
            void this.loadCached(this.store, this.generation);
    }

    close(): void {
        this.active = false;
    }

    dispose(): void {
        this.active = false;
        this.setStore(null);
    }

    private async loadCached(store: DiscReportStore,
                             generation: number): Promise<void> {
        try {
            const report = await store.cached();
            if (this.store !== store || this.generation !== generation) return;
            if (report) {
                this.report = report;
                this.renderReport(report);
            } else {
                this.renderWaiting();
            }
            if (store.persistenceWarning)
                this.dependencies.status(store.persistenceWarning, true);
        } catch (error) {
            if (this.store === store && this.generation === generation)
                this.dependencies.status(this.dependencies.friendlyError(error), true);
        }
    }

    private async attachIso(): Promise<void> {
        const input = $<HTMLInputElement>("report-iso");
        const file = input.files?.[0];
        input.value = "";
        const store = this.store;
        if (!file || !store || this.busy) return;
        this.setBusy(true, "Disc", "Checking that this is the same disc…");
        try {
            await store.attachIso(file);
            if (this.store !== store) return;
            $("report-iso-pick").hidden = true;
            await this.generate(store, true);
        } catch (error) {
            if (this.store === store) {
                this.dependencies.status(this.dependencies.friendlyError(error), true);
                this.renderFailure();
                this.setBusy(false);
            }
        }
    }

    private async runReport(): Promise<void> {
        const store = this.store;
        if (!store || this.busy) return;
        if (!store.hasIso()) {
            $("report-iso-pick").hidden = false;
            $<HTMLInputElement>("report-iso").click();
            return;
        }
        await this.generate(store, this.report !== null);
    }

    private async generate(store: DiscReportStore, force: boolean): Promise<void> {
        this.setBusy(true, "Preparing", "Opening DATA.BIN…");
        this.resetSideSteps();
        try {
            const report = await store.generate(progress =>
                this.renderProgress(progress), force);
            if (this.store !== store) return;
            this.report = report;
            this.renderReport(report);
            const warning = store.persistenceWarning;
            this.dependencies.status(
                warning ?? "Disc compatibility report complete",
                warning !== null,
            );
        } catch (error) {
            if (this.store === store) {
                this.dependencies.status(this.dependencies.friendlyError(error), true);
                this.renderFailure();
            }
        } finally {
            if (this.store === store) this.setBusy(false);
        }
    }

    private setBusy(busy: boolean, family = "", detail = ""): void {
        this.busy = busy;
        const panel = $("report-progress-panel");
        panel.hidden = !busy;
        $<HTMLButtonElement>("report-run").disabled = busy || !this.store;
        $<HTMLButtonElement>("report-copy-json").disabled = busy || !this.report;
        $<HTMLButtonElement>("report-copy-markdown").disabled = busy || !this.report;
        $<HTMLInputElement>("report-iso").disabled = busy;
        if (busy) {
            $("report-progress-family").textContent = family;
            $("report-progress-label").textContent = detail;
            $<HTMLProgressElement>("report-progress").value = 0;
            $("report-state").textContent = "Scanning";
            $("report-state").dataset.status = "scanning";
            $("report-side-state").textContent = "Scanning";
        }
    }

    private renderProgress(progress: DiscSupportProgress): void {
        const familyIndex = FAMILY_ORDER.indexOf(progress.family);
        const ratio = progress.total > 0 ? progress.done / progress.total : 0;
        $("report-progress-family").textContent =
            progress.family === "fmv" ? "Movies"
                : progress.family === "effects" ? "Sound effects" : "Images";
        const label = progress.path === "done"
            ? `${count(progress.total)} checks complete`
            : progress.path;

        const progressLabel = $("report-progress-label");
        progressLabel.textContent = label;
        progressLabel.title = progress.path;
        $<HTMLProgressElement>("report-progress").value = ratio;
        for (let index = 0; index < FAMILY_ORDER.length; index++) {
            const state = index < familyIndex || (index === familyIndex && progress.path === "done")
                ? "done"
                : index === familyIndex
                    ? "active"
                    : "waiting";
            this.setSideStep(FAMILY_ORDER[index]!, state,
                index === familyIndex && state === "active"
                    ? `${Math.min(progress.done, progress.total)}/${progress.total}`
                    : state);
        }
    }
    private renderFailure(): void {
        if (this.report) {
            this.renderReport(this.report);
            return;
        }
        const state = $("report-state");
        state.textContent = "Failed";
        state.dataset.status = "failed";
        $("report-side-state").textContent = "Failed";
        const active = document.querySelector<HTMLElement>(
            ".report-side-steps li[data-state=\"active\"]",
        );
        if (active) {
            active.dataset.state = "failed";
            const detail = active.querySelector("small");
            if (detail) detail.textContent = "failed";
        }
    }

    private renderWaiting(): void {
        $("report-results").hidden = true;
        $("report-progress-panel").hidden = true;
        const state = $("report-state");
        state.textContent = "Not run";
        state.dataset.status = "waiting";
        $("report-side-state").textContent = "Not run";
        const run = $<HTMLButtonElement>("report-run");
        run.textContent = "Run report";
        run.disabled = !this.store;
        $<HTMLButtonElement>("report-copy-json").disabled = true;
        $<HTMLButtonElement>("report-copy-markdown").disabled = true;
        $("report-iso-pick").hidden = this.store?.hasIso() ?? true;
        $<HTMLInputElement>("report-iso").disabled = false;
        this.resetSideSteps();
    }

    private resetSideSteps(): void {
        for (const family of FAMILY_ORDER)
            this.setSideStep(family, "waiting", "waiting");
    }

    private setSideStep(family: DiscSupportFamily, state: string,
                        detail: string): void {
        const item = document.querySelector<HTMLElement>(
            `[data-report-family="${family}"]`,
        );
        if (!item) return;
        item.dataset.state = state;
        const small = item.querySelector("small");
        if (small) small.textContent = detail;
    }

    private renderReport(report: DiscSupportReport): void {
        $("report-results").hidden = false;
        $("report-serial").textContent = report.disc.serial ?? "Unknown";
        $("report-volume").textContent = report.disc.volumeId || "Not set";
        $("report-data-size").textContent = bytes(report.disc.dataBinBytes);
        $("report-vfi-entries").textContent = count(report.disc.vfiEntries);
        $("report-table-hash").textContent = report.disc.tableSha256;

        this.renderFamily("images", report.images.status,
            counted(report.images.pictures, "picture"),
            `${counted(report.images.textures, "texture")} across `
                + counted(report.images.containers, "container"));
        this.renderFamily("effects", report.effects.status,
            `${count(report.effects.inspectedBanks)} / ${count(report.effects.pairedBanks)} `
                + `${report.effects.pairedBanks === 1 ? "bank" : "banks"} checked`,
            `${bytes(report.effects.bytesRead)} read from `
                + (report.effects.directories.join(", ") || "no sound-effect directories"));
        this.renderFamily("fmv", report.fmv.status,
            `${count(report.fmv.inspected)} / ${count(report.fmv.discovered)} `
                + `${report.fmv.discovered === 1 ? "movie" : "movies"} checked`,
            "STR/MPEG headers and subtitle file pairs");

        const statuses = [report.images.status, report.effects.status, report.fmv.status];
        const overall = statuses.includes("failed")
            ? "Failed"
            : statuses.includes("partial")
                ? "Partial"
                : "Complete";
        const state = $("report-state");
        state.textContent = overall;
        state.dataset.status = overall.toLowerCase();
        $("report-side-state").textContent = overall;
        for (const family of FAMILY_ORDER) {
            const familyStatus = report[family].status;
            this.setSideStep(family, familyStatus, statusLabel(familyStatus).toLowerCase());
        }

        this.renderIssues(report);
        this.renderMovies(report);
        $("report-json").textContent = `${JSON.stringify(report, null, 2)}\n`;
        const run = $<HTMLButtonElement>("report-run");
        run.textContent = "Run again";
        run.disabled = false;
        $<HTMLButtonElement>("report-copy-json").disabled = false;
        $<HTMLButtonElement>("report-copy-markdown").disabled = false;
        $("report-iso-pick").hidden = true;
    }

    private renderFamily(family: DiscSupportFamily, status: DiscSupportStatus,
                         value: string, detail: string): void {
        const card = document.querySelector<HTMLElement>(
            `[data-report-card="${family}"]`,
        );
        if (!card) return;
        card.dataset.status = status;
        const statusElement = card.querySelector<HTMLElement>("header strong");
        const valueElement = card.querySelector<HTMLElement>(".report-family-value");
        const detailElement = card.querySelector<HTMLElement>(".report-family-detail");
        if (statusElement) statusElement.textContent = statusLabel(status);
        if (valueElement) valueElement.textContent = value;
        if (detailElement) detailElement.textContent = detail;
    }

    private renderIssues(report: DiscSupportReport): void {
        const issues = [
            ...report.images.issues.map(issue => ({ family: "IMAGES", ...issue })),
            ...report.effects.issues.map(issue => ({ family: "EFFECTS", ...issue })),
            ...report.fmv.issues.map(issue => ({ family: "FMV", ...issue })),
        ];
        const section = $("report-issues");
        section.hidden = issues.length === 0;
        const list = $("report-issue-list");
        list.replaceChildren();
        for (const issue of issues) {
            const item = document.createElement("li");
            const family = document.createElement("span");
            family.textContent = issue.family;
            const body = document.createElement("div");
            const path = document.createElement("strong");
            path.textContent = issue.path;
            const reason = document.createElement("p");
            reason.textContent = issue.reason;
            body.append(path, reason);
            item.append(family, body);
            list.append(item);
        }
    }

    private renderMovies(report: DiscSupportReport): void {
        $("report-movie-count").textContent = count(report.fmv.movies.length);
        const rows = $<HTMLTableSectionElement>("report-movie-rows");
        rows.replaceChildren();
        for (const movie of report.fmv.movies) {
            const row = document.createElement("tr");
            appendCell(row, movie.name);
            appendCell(row, `${movie.width} × ${movie.height}`);
            appendCell(row, movie.fieldOrder);
            appendCell(row, `${movie.frameRate.toFixed(3)} fps`);
            rows.append(row);
        }
    }

    private async copyReport(format: "json" | "markdown"): Promise<void> {
        const report = this.report;
        if (!report) return;
        const button = $<HTMLButtonElement>(
            format === "json" ? "report-copy-json" : "report-copy-markdown",
        );
        const original = button.textContent ?? "Copy";
        const text = format === "json"
            ? `${JSON.stringify(report, null, 2)}\n`
            : formatDiscSupportMarkdown(report);
        try {
            await navigator.clipboard.writeText(text);
            button.textContent = "Copied";
            window.setTimeout(() => {
                if (button.textContent === "Copied") button.textContent = original;
            }, 1200);
        } catch (error) {
            this.dependencies.status(this.dependencies.friendlyError(error), true);
        }
    }
}
