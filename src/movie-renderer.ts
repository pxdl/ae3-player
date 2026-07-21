import type { DecodedMovieFrame } from "./movie-decoder-protocol.ts";
import { movieFrameByteLength } from "./movie-decoder-protocol.ts";

export interface MovieRenderInfo {
    width: number;
    height: number;
    label: string;
}

export interface MovieFrameRenderer {
    configure(info: MovieRenderInfo): void;
    render(frame: DecodedMovieFrame): void;
    clear(): void;
    dispose(): void;
}

export interface MovieRendererEvents {
    contextLost(): void;
    contextRestored(): void;
    contextError(cause: Error): void;
}

interface RendererResources {
    program: WebGLProgram;
    vertexArray: WebGLVertexArrayObject;
    textures: readonly [WebGLTexture, WebGLTexture, WebGLTexture];
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 textureCoordinate;

void main() {
    vec2 positions[3] = vec2[3](
        vec2(-1.0, -1.0),
        vec2(3.0, -1.0),
        vec2(-1.0, 3.0)
    );
    vec2 position = positions[gl_VertexID];
    gl_Position = vec4(position, 0.0, 1.0);
    vec2 coordinate = position * 0.5 + 0.5;
    textureCoordinate = vec2(coordinate.x, 1.0 - coordinate.y);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D lumaTexture;
uniform sampler2D blueChromaTexture;
uniform sampler2D redChromaTexture;
out vec4 outputColor;

void main() {
    float y = 1.16438356 * (texture(lumaTexture, textureCoordinate).r - 0.06274510);
    float cb = texture(blueChromaTexture, textureCoordinate).r - 0.50196078;
    float cr = texture(redChromaTexture, textureCoordinate).r - 0.50196078;
    outputColor = vec4(
        y + 1.59602678 * cr,
        y - 0.39176229 * cb - 0.81296764 * cr,
        y + 2.01723214 * cb,
        1.0
    );
}
`;

const NOOP_EVENTS: MovieRendererEvents = {
    contextLost() {},
    contextRestored() {},
    contextError() {},
};

export class WebGlYuvRenderer implements MovieFrameRenderer {
    readonly #canvas: HTMLCanvasElement;
    readonly #events: MovieRendererEvents;
    #gl: WebGL2RenderingContext;
    #resources: RendererResources | null = null;
    #info: MovieRenderInfo | null = null;
    #currentFrame: DecodedMovieFrame | null = null;
    #lost = false;
    #disposed = false;

    constructor(canvas: HTMLCanvasElement, events: MovieRendererEvents = NOOP_EVENTS) {
        this.#canvas = canvas;
        this.#events = events;
        this.#gl = requireWebGl2(canvas);
        this.#canvas.addEventListener("webglcontextlost", this.#handleContextLost);
        this.#canvas.addEventListener("webglcontextrestored", this.#handleContextRestored);
    }

    get contextLost(): boolean {
        return this.#lost;
    }

    configure(info: MovieRenderInfo): void {
        this.#assertLive();
        movieFrameByteLength(info.width, info.height);
        if (info.label.length === 0)
            throw new Error("movie canvas label is required");
        this.#canvas.width = info.width;
        this.#canvas.height = info.height;
        this.#canvas.setAttribute("role", "img");
        this.#canvas.setAttribute("aria-label", info.label);
        this.#info = { ...info };
        this.#currentFrame = null;
        if (!this.#lost)
            this.#buildResources(info);
    }

    render(frame: DecodedMovieFrame): void {
        this.#assertLive();
        const info = this.#info;
        if (info === null)
            throw new Error("movie renderer is not configured");
        validateFrame(frame, info);
        this.#currentFrame = frame;
        if (this.#lost)
            return;
        const resources = this.#resources;
        if (resources === null)
            throw new Error("movie renderer resources are unavailable");

        const gl = this.#gl;
        gl.useProgram(resources.program);
        gl.bindVertexArray(resources.vertexArray);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        for (let index = 0; index < resources.textures.length; index++) {
            const lumaPlane = index === 0;
            const planeWidth = lumaPlane ? info.width : info.width / 2;
            const planeHeight = lumaPlane ? info.height : info.height / 2;
            const plane = new Uint8Array(
                frame.data,
                frame.layout[index].offset,
                planeWidth * planeHeight,
            );
            gl.activeTexture(gl.TEXTURE0 + index);
            gl.bindTexture(gl.TEXTURE_2D, resources.textures[index]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, planeWidth, planeHeight,
                gl.RED, gl.UNSIGNED_BYTE, plane);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    clear(): void {
        this.#currentFrame = null;
        this.#clearSurface();
    }

    dispose(): void {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#canvas.removeEventListener("webglcontextlost", this.#handleContextLost);
        this.#canvas.removeEventListener("webglcontextrestored", this.#handleContextRestored);
        this.#deleteResources();
        this.#currentFrame = null;
        this.#info = null;
    }

    #buildResources(info: MovieRenderInfo): void {
        this.#deleteResources();
        const gl = this.#gl;
        const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
        const vertexArray = gl.createVertexArray();
        if (vertexArray === null) {
            gl.deleteProgram(program);
            throw new Error("could not create movie vertex array");
        }
        const textures = [
            createTexture(gl, info.width, info.height),
            createTexture(gl, info.width / 2, info.height / 2),
            createTexture(gl, info.width / 2, info.height / 2),
        ] as const;
        this.#resources = { program, vertexArray, textures };
        gl.viewport(0, 0, info.width, info.height);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.DITHER);
        gl.useProgram(program);
        setSampler(gl, program, "lumaTexture", 0);
        setSampler(gl, program, "blueChromaTexture", 1);
        setSampler(gl, program, "redChromaTexture", 2);
        this.#clearSurface();
    }

    #clearSurface(): void {
        if (this.#disposed || this.#lost)
            return;
        const gl = this.#gl;
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    #deleteResources(): void {
        const resources = this.#resources;
        if (resources === null)
            return;
        this.#gl.deleteProgram(resources.program);
        this.#gl.deleteVertexArray(resources.vertexArray);
        for (const texture of resources.textures)
            this.#gl.deleteTexture(texture);
        this.#resources = null;
    }

    #handleContextLost = (event: Event): void => {
        event.preventDefault();
        this.#lost = true;
        this.#resources = null;
        this.#events.contextLost();
    };

    #handleContextRestored = (): void => {
        this.#lost = false;
        const info = this.#info;
        if (this.#disposed || info === null)
            return;
        try {
            this.#gl = requireWebGl2(this.#canvas);
            this.#buildResources(info);
            if (this.#currentFrame !== null)
                this.render(this.#currentFrame);
            this.#events.contextRestored();
        } catch (cause) {
            this.#events.contextError(cause instanceof Error ? cause : new Error(String(cause)));
        }
    };

    #assertLive(): void {
        if (this.#disposed)
            throw new Error("movie renderer is disposed");
    }
}

function requireWebGl2(canvas: HTMLCanvasElement): WebGL2RenderingContext {
    const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        desynchronized: true,
        failIfMajorPerformanceCaveat: true,
        powerPreference: "high-performance",
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        stencil: false,
    });
    if (gl === null)
        throw new Error("WebGL2 is required for movie playback");
    return gl;
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string,
        fragmentSource: string): WebGLProgram {
    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (program === null) {
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        throw new Error("could not create movie shader program");
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || "unknown link error";
        gl.deleteProgram(program);
        throw new Error(`could not link movie shader: ${message}`);
    }
    return program;
}

function createShader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
    const shader = gl.createShader(kind);
    if (shader === null)
        throw new Error("could not create movie shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || "unknown compile error";
        gl.deleteShader(shader);
        throw new Error(`could not compile movie shader: ${message}`);
    }
    return shader;
}

function createTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
    const texture = gl.createTexture();
    if (texture === null)
        throw new Error("could not create movie texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height);
    return texture;
}

function setSampler(gl: WebGL2RenderingContext, program: WebGLProgram,
        name: string, unit: number): void {
    const location = gl.getUniformLocation(program, name);
    if (location === null)
        throw new Error(`movie shader uniform ${name} is unavailable`);
    gl.uniform1i(location, unit);
}

function validateFrame(frame: DecodedMovieFrame, info: MovieRenderInfo): void {
    const expectedBytes = movieFrameByteLength(info.width, info.height);
    const yBytes = info.width * info.height;
    const chromaBytes = yBytes / 4;
    if (frame.format !== "I420" || frame.width !== info.width || frame.height !== info.height
            || frame.data.byteLength !== expectedBytes)
        throw new Error("movie frame does not match renderer configuration");
    const chromaStride = info.width / 2;
    if (frame.layout[0].offset !== 0 || frame.layout[0].stride !== info.width
            || frame.layout[1].offset !== yBytes
            || frame.layout[1].stride !== chromaStride
            || frame.layout[2].offset !== yBytes + chromaBytes
            || frame.layout[2].stride !== chromaStride)
        throw new Error("movie frame is not tightly packed I420");
}
