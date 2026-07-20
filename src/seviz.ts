import { RATE, type Snapshot } from "./player.ts";
import type { SeBytecodeEvent, SeRequestInfo } from "./se.ts";

const TICKS_PER_SECOND = 480;
const BG = "#101116";
const PANEL = "#181a21";
const GRID = "#292c35";
const TEXT = "#d6dae4";
const DIM = "#7f8593";
const ACCENT = "#e05157";
const GOLD = "#ffc440";
const GREEN = "#6f9a76";
const BLUE = "#6e93b8";

function commandLabel(command = 0): string {
    if (command === 0x01) return "LFO DEPTH";
    if (command === 0x02) return "LFO RATE";
    if (command === 0x07) return "VELOCITY";
    if (command === 0x0a) return "PAN";
    if (command === 0x41) return "GLIDE";
    if (command === 0x60) return "LOOP";
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

/** Event-score view for one embedded SE request. Unlike the BGM piano roll,
 * this shows the request's 480 Hz relative-delay bytecode and authored jump. */
export class SeSequenceViz {
    private info: SeRequestInfo | null = null;
    private noteEvents: SeBytecodeEvent[] = [];
    private controlEvents: SeBytecodeEvent[] = [];
    private minKey = 60;
    private maxKey = 60;
    private readonly canvas: HTMLCanvasElement;

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
        this.draw(null, false);
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

    draw(snapshot: Snapshot | null, looping: boolean): void {
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
            ctx.fillText("SELECT A REQUEST TO INSPECT ITS SEQUENCE", w / 2, h / 2);
            return;
        }

        const left = 44, right = 14, top = 35, bottom = 30;
        const innerW = Math.max(1, w - left - right);
        const controlH = Math.min(82, Math.max(55, h * 0.28));
        const noteBottom = h - bottom - controlH;
        const controlTop = noteBottom + 13;
        const endTick = Math.max(1,
            info.loop?.count === 0 ? info.loop.endTick : info.durationTicks);
        const xAt = (tick: number): number => left + tick / endTick * innerW;

        ctx.fillStyle = PANEL;
        ctx.fillRect(left, top, innerW, Math.max(1, h - top - bottom));

        const seconds = endTick / TICKS_PER_SECOND;
        const step = niceStep(seconds);
        ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (let sec = 0; sec <= seconds + step * 0.25; sec += step) {
            const x = xAt(sec * TICKS_PER_SECOND);
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
        const noteTop = top + 12;
        const noteHeight = Math.max(12, noteBottom - noteTop - 8);
        const yAt = (key: number): number =>
            noteTop + (maxKey - key) / keySpan * noteHeight;

        ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
        ctx.textBaseline = "middle";
        ctx.textAlign = "right";
        ctx.fillStyle = DIM;
        ctx.fillText(maxKey.toString(16).toUpperCase().padStart(2, "0"), left - 7, noteTop);
        if (minKey !== maxKey)
            ctx.fillText(minKey.toString(16).toUpperCase().padStart(2, "0"), left - 7, noteTop + noteHeight);

        for (const event of this.noteEvents)
            this.drawNote(ctx, event, xAt(event.tick), yAt(event.key ?? 60));

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
            const x = xAt(event.tick);
            const lane = i % 3;
            const y = controlTop + lane * 18;
            const label = commandLabel(event.command);
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

        if (info.loop) {
            const x0 = xAt(info.loop.startTick), x1 = xAt(info.loop.endTick);
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
            ctx.textAlign = "right";
            ctx.textBaseline = "top";
            ctx.fillText(info.loop.count === 0 ? "AUTHORED ∞" : `REPEAT ×${info.loop.count}`,
                         x1 - 4, top + 10);
        }

        ctx.fillStyle = TEXT;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.font = "10px 'SFMono-Regular', Menlo, monospace";
        const summary = `${info.notes} NOTE EVENTS  ·  ${info.controls} CONTROLS  ·  480 TICKS/S`;
        ctx.fillText(summary, left, 8);

        if (snapshot) {
            let tick = snapshot.pos / RATE * TICKS_PER_SECOND;
            if (looping && info.loop && tick > info.loop.endTick) {
                const cycle = Math.max(1, info.loop.cycleTicks);
                tick = info.loop.startTick + (tick - info.loop.startTick) % cycle;
            }
            const x = xAt(Math.min(tick, endTick));
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
        ctx.strokeStyle = GREEN;
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x, y + 7);
        ctx.stroke();
        ctx.fillStyle = `rgba(111, 154, 118, ${0.45 + velocity * 0.55})`;
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
}
