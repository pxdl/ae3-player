import {
    RATE, VoiceEnvelopePhase, VoiceField, VoiceSourceKind, VOICE_STATE_SIZE,
    type Snapshot,
} from "./player.ts";
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

const MONO_9 = "9px 'SFMono-Regular', Menlo, monospace";
const MONO_10 = "10px 'SFMono-Regular', Menlo, monospace";
const ENV_PHASE_LABELS = ["A", "D", "S", "R", "\u2013"] as const;

function canvasContext(canvas: HTMLCanvasElement): {
    ctx: CanvasRenderingContext2D; w: number; h: number;
} | null {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
}

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

/** Live monitor for the independent PS-ADPCM loop owned by each active SE
 * voice. Coordinates come only from the packed synth snapshot. */
export class SeSourceLoopViz {
    private readonly canvas: HTMLCanvasElement;
    private rows = -1;
    private rebuilding = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.resizeRows(0);
    }

    clear(): void {
        this.rebuilding = true;
        this.draw(null);
    }

    draw(snapshot: Snapshot | null): void {
        let rows = 0;
        if (snapshot) {
            const voices = snapshot.voices;
            for (let slot = 0; slot < 48; slot++) {
                const base = slot * VOICE_STATE_SIZE;
                if (this.isLoopRow(voices, base)) rows++;
            }
            this.rebuilding = false;
        }
        this.resizeRows(rows);
        const surface = canvasContext(this.canvas);
        if (!surface) return;
        const { ctx, w, h } = surface;
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, w, h);
        if (!snapshot || rows === 0) {
            ctx.fillStyle = DIM;
            ctx.font = MONO_10;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(
                this.rebuilding
                    ? "REBUILDING LIVE SOURCE STATE"
                    : "NO LIVE LOOPED SOURCE VOICES",
                w / 2, h / 2,
            );
            return;
        }

        let row = 0;
        const voices = snapshot.voices;
        for (let slot = 0; slot < 48; slot++) {
            const base = slot * VOICE_STATE_SIZE;
            if (!this.isLoopRow(voices, base)) continue;
            this.drawRow(ctx, w, row++, slot, voices, base);
        }
    }

    private resizeRows(rows: number): void {
        if (rows === this.rows) return;
        this.rows = rows;
        this.canvas.style.height = `${rows === 0 ? 54 : rows * 62}px`;
    }

    private isLoopRow(voices: Float64Array, base: number): boolean {
        const flags = voices[base + VoiceField.Flags]!;
        const samples = voices[base + VoiceField.SourceSamples]!;
        const loopStart = voices[base + VoiceField.SourceLoopStart]!;
        return !!(flags & 2)
            && voices[base + VoiceField.SeProgram] !== 0xff
            && voices[base + VoiceField.SourceKind] === VoiceSourceKind.Looped
            && samples > 0
            && loopStart >= 0
            && loopStart < samples
            && voices[base + VoiceField.SourcePhaseQ12]! >= 0;
    }

    private drawRow(
        ctx: CanvasRenderingContext2D,
        width: number,
        row: number,
        slot: number,
        voices: Float64Array,
        base: number,
    ): void {
        const y = row * 62;
        const samples = voices[base + VoiceField.SourceSamples]!;
        const loopStart = voices[base + VoiceField.SourceLoopStart]!;
        const phase = voices[base + VoiceField.SourcePhaseQ12]! / 4096;
        const env = voices[base + VoiceField.Envelope]!;
        const envPhase = voices[base + VoiceField.EnvelopePhase]!;
        const program = voices[base + VoiceField.SeProgram]!;
        const key = voices[base + VoiceField.Key]!;
        const waveform = voices[base + VoiceField.Waveform]!;
        const loops = voices[base + VoiceField.SourceLoops]!;
        const left = 8, right = width - 8;
        const laneW = Math.max(1, right - left);
        const split = left + loopStart / samples * laneW;
        const marker = left + Math.max(0, Math.min(1, phase / samples)) * laneW;

        if (row > 0) {
            ctx.fillStyle = GRID;
            ctx.fillRect(left, y, laneW, 1);
        }
        ctx.font = MONO_10;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.fillStyle = TEXT;
        ctx.fillText(
            `V${slot.toString().padStart(2, "0")}  P${program.toString().padStart(2, "0")} `
            + `K${key.toString().padStart(2, "0")}  W${waveform}`,
            left, y + 5,
        );
        ctx.textAlign = "right";
        ctx.fillStyle = GOLD;
        ctx.fillText(`\u00D7${loops}`, right, y + 5);

        ctx.fillStyle = "#242731";
        ctx.fillRect(left, y + 20, Math.max(1, split - left), 12);
        ctx.fillStyle = "rgba(110, 147, 184, 0.34)";
        ctx.fillRect(split, y + 20, Math.max(1, right - split), 12);
        ctx.strokeStyle = BLUE;
        ctx.strokeRect(split + 0.5, y + 20.5, Math.max(0, right - split - 1), 11);
        ctx.fillStyle = "#f4f6fb";
        ctx.fillRect(Math.round(marker) - 1, y + 17, 2, 18);

        ctx.font = MONO_9;
        ctx.fillStyle = DIM;
        ctx.textAlign = "left";
        ctx.fillText(`INTRO [0,${loopStart})`, left, y + 34);
        ctx.fillStyle = BLUE;
        ctx.textAlign = "right";
        ctx.fillText(`LOOP [${loopStart},${samples})`, right, y + 34);

        const envLabel = ENV_PHASE_LABELS[envPhase]
            ?? (envPhase === VoiceEnvelopePhase.Off ? "\u2013" : "?");
        ctx.fillStyle = DIM;
        ctx.textAlign = "left";
        ctx.fillText(`ENV ${envLabel}`, left, y + 49);
        const envX = left + 42, envW = Math.max(1, right - envX);
        ctx.fillStyle = "#242731";
        ctx.fillRect(envX, y + 49, envW, 7);
        ctx.fillStyle = PURPLE;
        ctx.fillRect(envX, y + 49, Math.max(0, Math.min(1, env / 32767)) * envW, 7);
    }
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
        const surface = canvasContext(this.canvas);
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

        let starts = 0, stops = 0;
        for (const event of this.noteEvents) {
            if (event.kind === "note") starts++;
            else stops++;
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
            `${starts} START${starts === 1 ? "" : "S"}  ·  `
            + `${stops} STOP${stops === 1 ? "" : "S"}  ·  `
            + `${info.controls} CONTROL${info.controls === 1 ? "" : "S"}  ·  `
            + `${this.exact ? "EXACT 480 Hz" : "CONSOLE 60 Hz"} TIMELINE`,
            left, 8);
        const sourceEnd = this.exact
            ? info.sourceEndExactFrame
            : info.sourceEndConsoleFrame;
        if (starts === 0 && stops > 0 && info.controls === 0 && !info.loop) {
            ctx.fillStyle = DIM;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                `VOICE-STOP REQUEST  ·  STARTS NO AUDIO SOURCE BY ITSELF`,
                left, 25);
        } else if (info.sustained) {
            ctx.fillStyle = GOLD;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                `SOURCE CONTINUES AFTER EVENTS  →  ∞  `
                + `(${info.sustainedVoices} NON-DECAYING LOOP/NOISE `
                + `VOICE${info.sustainedVoices === 1 ? "" : "S"})`,
                left, 25);
        } else if (info.loopingVoices && sourceEnd > this.eventFrames(info)) {
            ctx.fillStyle = GOLD;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                `LOOP/NOISE SOURCE CONTINUES AFTER EVENTS  →  `
                + `ENVELOPE END ≈${durationLabel(sourceEnd)}`,
                left, 25);
        } else {
            ctx.fillStyle = DIM;
            ctx.font = "9px 'SFMono-Regular', Menlo, monospace";
            ctx.fillText(
                info.activeVoices
                    ? `${info.activeVoices} NOTE${info.activeVoices === 1 ? "" : "S"} WITHOUT EXPLICIT NOTE-OFF`
                    : "ALL STARTED NOTES HAVE EXPLICIT NOTE-OFF",
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
            const program = (event.program ?? 0).toString(16).padStart(2, "0").toUpperCase();
            const key = (event.key ?? 0).toString(16).padStart(2, "0").toUpperCase();
            ctx.fillStyle = DIM;
            ctx.font = "8px 'SFMono-Regular', Menlo, monospace";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(`STOP P${program} K${key}`, x + 5, y);
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
