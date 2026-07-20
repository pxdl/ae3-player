import { RATE, type Snapshot } from "./player.ts";
import type { SeBytecodeEvent, SeRequestInfo } from "./se.ts";

const BG = "#101116";
const PANEL = "#181a21";
const GRID = "#292c35";
const TEXT = "#d6dae4";
const DIM = "#7f8593";
const ACCENT = "#e05157";
const GOLD = "#ffc440";
const GREEN = "#6f9a76";
const BLUE = "#6e93b8";
const PURPLE = "#a88ac2";

function commandLabel(event: SeBytecodeEvent): string {
    const command = event.command ?? 0;
    const value = event.args?.[0];
    if (command === 0x01) return `LFO DEPTH ${value}`;
    if (command === 0x02) return `LFO RATE ${value}`;
    if (command === 0x07) return `VELOCITY ${value}`;
    if (command === 0x0a) return `PAN ${value}`;
    if (command === 0x41) return `GLIDE ${value}t`;
    if (command === 0x60)
        return `STREAM JUMP \u00D7${event.args?.[2] || "\u221E"}`;
    return `B0 ${command.toString(16).padStart(2, "0").toUpperCase()}`;
}

function niceStep(seconds: number): number {
    const target = seconds / 6;
    for (const step of [0.1, 0.25, 0.5, 1, 2, 5, 10, 20])
        if (step >= target) return step;
    return 30;
}

function secondsLabel(seconds: number): string {
    if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function durationLabel(frames: number): string {
    const seconds = frames / RATE;
    if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
    if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
    return secondsLabel(seconds);
}

/** Event-score view for one embedded SE request. Unlike the BGM piano roll,
 * this shows the request's 480 Hz relative-delay bytecode and authored jump. */
export class SeSequenceViz {
    private info: SeRequestInfo | null = null;
    private noteEvents: SeBytecodeEvent[] = [];
    private controlEvents: SeBytecodeEvent[] = [];
    private minKey = 60;
    private maxKey = 60;
    private readonly canvas: HTMLCanvasElement;
    private exact = true;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    set(info: SeRequestInfo | null): void {
        this.info = info;
        this.noteEvents = [];
        this.controlEvents = [];
        this.minKey = 127;
        this.maxKey = 0;
        for (const event of info?.events ?? []) {
            if (event.kind === "note" || event.kind === "off") {
                this.noteEvents.push(event);
                this.minKey = Math.min(this.minKey, event.key ?? this.minKey);
                this.maxKey = Math.max(this.maxKey, event.key ?? this.maxKey);
            } else {
                this.controlEvents.push(event);
            }
        }
        if (this.minKey > this.maxKey) this.minKey = this.maxKey = 60;
        this.draw(null, false, this.exact);
    }

    private context(): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (!w || !h) return null;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
        if (this.canvas.width !== pw || this.canvas.height !== ph) {
            this.canvas.width = pw;
            this.canvas.height = ph;
        }
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return null;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, w, h };
    }

    /** Map a pointer coordinate onto the currently displayed event domain. */
    frameAt(clientX: number): number | null {
        if (!this.info) return null;
        const rect = this.canvas.getBoundingClientRect();
        const left = 58, right = 18;
        const innerW = Math.max(1, rect.width - left - right);
        const frac = Math.max(0, Math.min(1, (clientX - rect.left - left) / innerW));
        const loop = this.loopFrames(this.info);
        const end = this.info.loop?.count === 0
            ? loop!.end
            : this.eventFrames(this.info);
        return Math.round(frac * Math.max(1, end));
    }

    private eventFrames(info: SeRequestInfo): number {
        return this.exact ? info.exactFrames : info.consoleFrames;
    }

    private loopFrames(info: SeRequestInfo): {
        start: number; end: number; cycle: number;
    } | null {
        if (!info.loop) return null;
        return this.exact
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

    private frame(event: SeBytecodeEvent): number {
        return this.exact ? event.exactFrame : event.consoleFrame;
    }

    draw(snapshot: Snapshot | null, looping: boolean, exact = true): void {
        this.exact = exact;
        const surface = this.context();
        if (!surface) return;
        const { ctx, w, h } = surface;
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, w, h);
        const info = this.info;
        if (!info) {
            ctx.fillStyle = DIM;
            ctx.font = "11px 'SFMono-Regular', Menlo, monospace";
            ctx.textAlign = "center";
            ctx.fillText("SELECT A REQUEST TO INSPECT ITS EVENT SCORE", w / 2, h / 2);
            return;
        }

        const left = 58, right = 18, top = 48, bottom = 32;
        const innerW = Math.max(1, w - left - right);
        const controlH = Math.min(88, Math.max(62, h * 0.30));
        const noteBottom = h - bottom - controlH;
        const controlTop = noteBottom + 15;
        const loopFrames = this.loopFrames(info);
        const endFrame = Math.max(1,
            info.loop?.count === 0 ? loopFrames!.end : this.eventFrames(info));
        const xAt = (frame: number): number => left + frame / endFrame * innerW;

        ctx.fillStyle = PANEL;
        ctx.fillRect(left, top, innerW, Math.max(1, h - top - bottom));

        if (info.loop) {
            const x0 = xAt(loopFrames!.start), x1 = xAt(loopFrames!.end);
            ctx.fillStyle = "rgba(255, 196, 64, 0.055)";
            ctx.fillRect(x0, top, Math.max(1, x1 - x0), h - top - bottom);
            ctx.strokeStyle = GOLD;
            ctx.beginPath();
            ctx.moveTo(x0, top + 1);
            ctx.lineTo(x0, top + 7);
            ctx.lineTo(x1, top + 7);
            ctx.lineTo(x1, top + 1);
            ctx.stroke();
            ctx.fillStyle = GOLD;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.textAlign = "right";
            ctx.textBaseline = "top";
            ctx.fillText(info.loop.count === 0 ? "STREAM JUMP \u221E" : `STREAM REPEAT \u00D7${info.loop.count}`,
                         x1 - 4, top + 10);
        }

        const seconds = endFrame / RATE;
        const step = niceStep(seconds);
        ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (let sec = 0; sec <= seconds + step * 0.25; sec += step) {
            const x = xAt(sec * RATE);
            ctx.strokeStyle = GRID;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, top);
            ctx.lineTo(x + 0.5, h - bottom);
            ctx.stroke();
            ctx.fillStyle = DIM;
            ctx.fillText(secondsLabel(sec), x, top - 6);
        }

        const { minKey, maxKey } = this;
        const keySpan = Math.max(1, maxKey - minKey);
        const noteTop = top + 14;
        const noteHeight = Math.max(12, noteBottom - noteTop - 8);
        const yAt = (key: number): number =>
            noteTop + (maxKey - key) / keySpan * noteHeight;

        ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
        ctx.textBaseline = "middle";
        ctx.textAlign = "right";
        ctx.fillStyle = DIM;
        ctx.fillText(`KEY ${maxKey.toString(16).toUpperCase().padStart(2, "0")}`,
                     left - 7, noteTop);
        if (minKey !== maxKey)
            ctx.fillText(`KEY ${minKey.toString(16).toUpperCase().padStart(2, "0")}`,
                         left - 7, noteTop + noteHeight);

        for (const event of this.noteEvents)
            this.drawNote(ctx, event, xAt(this.frame(event)), yAt(event.key ?? 60));

        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(left, noteBottom + 0.5);
        ctx.lineTo(w - right, noteBottom + 0.5);
        ctx.stroke();

        ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        for (let i = 0; i < this.controlEvents.length; i++) {
            const event = this.controlEvents[i]!;
            const x = xAt(this.frame(event));
            const lane = i % 3;
            const y = controlTop + lane * 18;
            const label = commandLabel(event);
            const width = ctx.measureText(label).width + 10;
            const boxX = Math.min(x + 4, w - right - width - 2);
            ctx.fillStyle = event.kind === "loop" ? "#4a3420" : "#263646";
            ctx.fillRect(boxX, y - 6, width, 13);
            ctx.fillStyle = event.kind === "loop" ? GOLD : BLUE;
            ctx.fillText(label, boxX + 5, y + 0.5);
            ctx.strokeStyle = event.kind === "loop" ? GOLD : BLUE;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, noteBottom + 4);
            ctx.lineTo(x + 0.5, y - 7);
            ctx.stroke();
        }

        ctx.fillStyle = TEXT;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.font = "10px 'SFMono-Regular', Menlo, monospace";
        ctx.fillText(
            `${info.notes} NOTE EVENT${info.notes === 1 ? "" : "S"}  \u00B7  `
            + `${info.controls} CONTROL${info.controls === 1 ? "" : "S"}  \u00B7  `
            + `${this.exact ? "EXACT 480 Hz" : "CONSOLE 60 Hz"} TIMELINE`,
            left, 8);
        const sourceEnd = this.exact
            ? info.sourceEndExactFrame
            : info.sourceEndConsoleFrame;
        if (info.sustained) {
            ctx.fillStyle = GOLD;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                `SOURCE CONTINUES AFTER EVENTS  \u2192  \u221E  `
                + `(${info.sustainedVoices} NON-DECAYING LOOP/NOISE `
                + `VOICE${info.sustainedVoices === 1 ? "" : "S"})`,
                left, 25);
        } else if (info.loopingVoices && sourceEnd > this.eventFrames(info)) {
            ctx.fillStyle = GOLD;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                `LOOP/NOISE SOURCE CONTINUES AFTER EVENTS  \u2192  `
                + `ENVELOPE END \u2248${durationLabel(sourceEnd)}`,
                left, 25);
        } else {
            ctx.fillStyle = DIM;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                info.activeVoices
                    ? `${info.activeVoices} NOTE${info.activeVoices === 1 ? "" : "S"} WITHOUT EXPLICIT NOTE-OFF`
                    : "ALL NOTES HAVE EXPLICIT NOTE-OFF",
                left, 25);
        }

        if (snapshot) {
            let frame = snapshot.pos;
            if (looping && loopFrames && frame > loopFrames.end)
                frame = loopFrames.start
                    + (frame - loopFrames.start) % Math.max(1, loopFrames.cycle);
            const x = xAt(Math.min(frame, endFrame));
            ctx.strokeStyle = ACCENT;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, top - 1);
            ctx.lineTo(x, h - bottom + 1);
            ctx.stroke();
            ctx.fillStyle = ACCENT;
            ctx.beginPath();
            ctx.moveTo(x - 4, top - 1);
            ctx.lineTo(x + 4, top - 1);
            ctx.lineTo(x, top + 5);
            ctx.closePath();
            ctx.fill();
            ctx.lineWidth = 1;
        }
    }

    private drawNote(ctx: CanvasRenderingContext2D, event: SeBytecodeEvent,
                     x: number, y: number): void {
        if (event.kind === "off") {
            ctx.strokeStyle = DIM;
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.stroke();
            return;
        }
        const velocity = (event.velocity ?? 0) / 127;
        const color = event.indefinite
            ? GOLD
            : event.noise ? PURPLE : event.sampleLoop ? BLUE : GREEN;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x, y + 7);
        ctx.stroke();
        ctx.globalAlpha = 0.45 + velocity * 0.55;
        ctx.fillStyle = color;
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.globalAlpha = 1;
        const source = event.noise ? "N" : event.sampleLoop ? "L" : "1";
        ctx.fillStyle = color;
        ctx.font = "8px 'SFMono-Regular', Menlo, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(source + (event.reverb ? "R" : ""), x + 4, y);
    }
}
