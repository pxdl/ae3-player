import type { DecodedMaterialState } from "./models.ts";

export type Vec4 = readonly [number, number, number, number];

export interface DirectionalLightVector {
    direction: Vec4;
    color: Vec4;
}

export interface HemisphereLightVector {
    direction: Vec4;
    positiveColor: Vec4;
    negativeColor: Vec4;
}

export interface PointLightVector {
    position: Vec4;
    color: Vec4;
}

export interface SpotLightVector extends PointLightVector {
    direction: Vec4;
    cone: readonly [cutoff: number, scale: number];
}

export interface RadialLightVector extends PointLightVector {
    coefficients: Vec4;
}

export interface FogSource {
    color: Vec4;
    near: number;
    nearFactor: number;
    far: number;
    farFactor: number;
}

export interface EvaluatedFogState {
    fogColor: bigint;
    a: number;
    b: number;
}

const TEXTURED_FACTOR_SCALE: Vec4 = [128, 128, 128, 128];
const UNTEXTURED_FACTOR_SCALE: Vec4 = [255, 255, 255, 128];

const ALPHA_REGISTERS = new Map<number, bigint>([
    [0x01, 0x40n], [0x02, 0x00n],
    [0x10, 0x44n], [0x11, 0x48n], [0x12, 0x42n],
    [0x20, 0x54n], [0x21, 0x58n], [0x22, 0x52n],
]);
const ALPHA_TESTS = [1, 0, 1, 4, 7, 2, 3, 6, 5] as const;

/** Exact ALPHA_1 payload emitted by FUN_003bd238, or null when it emits no write. */
export function i3dAlphaRegister(mode: number): bigint | null {
    return ALPHA_REGISTERS.get(mode) ?? null;
}

/** Exact TEST_1 payload emitted by the normal (payload +0x33 == 0) FUN_003bd048 path. */
export function i3dTestRegister(state: DecodedMaterialState): bigint | null {
    if (state.alphaTestOverride) return null;
    let emit = false;
    let ate = 0;
    let atst = 1;
    let aref = 0;
    let afail = 0;
    if (state.alphaTestMode !== 0) {
        emit = true;
        ate = 1;
        atst = ALPHA_TESTS[state.alphaTestMode] ?? 1;
        aref = Math.max(0, Math.min(0xff, Math.trunc(state.alphaReference * 128)));
        switch (state.alphaFailMode) {
        case 0x10:
            afail = 1;
            break;
        case 0x0f:
            afail = 2;
            break;
        case 0x18:
            afail = 3;
            break;
        }
    }
    let date = 0;
    let datm = 0;
    if (state.destinationAlphaMode === 2) emit = true;
    else if (state.destinationAlphaMode === 9) {
        emit = true; date = 1; datm = 1;
    } else if (state.destinationAlphaMode === 10) {
        emit = true; date = 1;
    }
    let ztst = 2;
    if (state.depthTestMode === 1) {
        emit = true; ztst = 0;
    } else if (state.depthTestMode === 2) {
        emit = true; ztst = 1;
    } else if (state.depthTestMode === 0x13) {
        emit = true; ztst = 3;
    } else if (state.depthTestMode === 0x14) {
        emit = true; ztst = 2;
    }
    if (!emit) return null;
    return BigInt(ate | atst << 1 | aref << 4 | afail << 12 |
                  date << 14 | datm << 15 | 1 << 16 | ztst << 17);
}

function madd(accumulator: number, left: number, right: number): number {
    return Math.fround(Math.fround(left * right) + accumulator);
}

function msub(accumulator: number, left: number, right: number): number {
    return Math.fround(accumulator - Math.fround(left * right));
}

function clampColor(value: number): number {
    return Math.max(0, Math.min(255, value));
}

function dot3(ax: number, ay: number, az: number,
              bx: number, by: number, bz: number): number {
    let result = Math.fround(ax * bx);
    result = madd(result, ay, by);
    return madd(result, az, bz);
}

function lengthSquared3(x: number, y: number, z: number): number {
    return dot3(x, y, z, x, y, z);
}

function reciprocalLength3(x: number, y: number, z: number): number {
    return Math.fround(1 / Math.sqrt(lengthSquared3(x, y, z)));
}

function polynomialIntensity(value: number, coefficients: Vec4): number {
    const squared = Math.fround(value * value);
    const fourth = Math.fround(squared * squared);
    const eighth = Math.fround(fourth * fourth);
    let intensity = Math.fround(value * coefficients[0]);
    intensity = madd(intensity, squared, coefficients[1]);
    intensity = madd(intensity, fourth, coefficients[2]);
    return Math.max(0, madd(intensity, eighth, coefficients[3]));
}

function accumulate(result: number[], color: Vec4, intensity: number): void {
    for (let component = 0; component < 4; component++)
        result[component] = madd(result[component]!, color[component], intensity);
}

/** Literal VUM[0x3f5] selected by FUN_003bbf80 from texture presence. */
export function i3dFactorScale(textured: boolean): Vec4 {
    return textured ? TEXTURED_FACTOR_SCALE : UNTEXTURED_FACTOR_SCALE;
}

/** Fog constants and FOGCOL emitted by FUN_003ae900 from source offsets +0x00..+0x1c. */
export function evaluateFogState(source: FogSource): EvaluatedFogState {
    const nearTerm = Math.fround(Math.fround(1 - source.nearFactor) * 255);
    const farTerm = Math.fround(Math.fround(1 - source.farFactor) * 255);
    const range = Math.fround(source.far - source.near);
    const delta = Math.fround(nearTerm - farTerm);
    const t = Math.fround(Math.fround(source.far * delta) / range);
    const a = Math.fround(nearTerm - t);
    const b = Math.fround(source.near * t);
    let fogColor = 0n;
    for (let component = 0; component < 3; component++) {
        const scaled = Math.fround(Math.max(0, Math.min(1, source.color[component])) * 255);
        fogColor |= BigInt(Math.trunc(scaled)) << BigInt(component * 8);
    }
    return { fogColor, a, b };
}

/** VU1 output-path fog value before FTOI4: clamp(A + B / clipW, 0, 255). */
export function evaluateFogFactor(clipW: number, state: EvaluatedFogState): number {
    const reciprocal = Math.fround(1 / clipW);
    return clampColor(madd(state.a, state.b, reciprocal));
}

/** VU1 handler 0x0039: four-lane signed dots, per-light max(0, dot), then color MADs. */
export function evaluateDirectionalLights(normal: Vec4,
                                          lights: readonly DirectionalLightVector[]): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dot = Math.max(0, dot3(normal[0], normal[1], normal[2],
                                      light.direction[0], light.direction[1],
                                      light.direction[2]));
        accumulate(result, light.color, dot);
    }
    return result as [number, number, number, number];
}

/** VU1 handler 0x0066: signed dots transformed by a shared x/x²/x⁴/x⁸ polynomial. */
export function evaluateMode2DirectionalLights(
    normal: Vec4, lights: readonly DirectionalLightVector[], coefficients: Vec4,
): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dot = dot3(normal[0], normal[1], normal[2],
                         light.direction[0], light.direction[1],
                         light.direction[2]);
        accumulate(result, light.color, polynomialIntensity(dot, coefficients));
    }
    return result as [number, number, number, number];
}

/**
 * VU1 handler 0x00c8. Inputs are already transformed into VU work space.
 * Intensity is max(0, N·(P-X)) / |P-X|².
 */
export function evaluatePointLights(position: Vec4, normal: Vec4,
                                    lights: readonly PointLightVector[]): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dx = Math.fround(light.position[0] - position[0]);
        const dy = Math.fround(light.position[1] - position[1]);
        const dz = Math.fround(light.position[2] - position[2]);
        const dot = Math.max(0, dot3(dx, dy, dz, normal[0], normal[1], normal[2]));
        const reciprocalLength = reciprocalLength3(dx, dy, dz);
        const intensity = Math.fround(dot *
            Math.fround(reciprocalLength * reciprocalLength));
        accumulate(result, light.color, intensity);
    }
    return result as [number, number, number, number];
}

/**
 * VU1 handler 0x0108. It normalizes P-X, normalizes viewDirection + L,
 * then applies the mode-2 polynomial to N·H.
 */
export function evaluateMode2PointLights(
    position: Vec4, normal: Vec4, viewDirection: Vec4,
    lights: readonly PointLightVector[], coefficients: Vec4,
): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dx = Math.fround(light.position[0] - position[0]);
        const dy = Math.fround(light.position[1] - position[1]);
        const dz = Math.fround(light.position[2] - position[2]);
        const inverseDistance = reciprocalLength3(dx, dy, dz);
        const lx = Math.fround(dx * inverseDistance);
        const ly = Math.fround(dy * inverseDistance);
        const lz = Math.fround(dz * inverseDistance);
        const hx = Math.fround(viewDirection[0] + lx);
        const hy = Math.fround(viewDirection[1] + ly);
        const hz = Math.fround(viewDirection[2] + lz);
        const inverseHalfLength = reciprocalLength3(hx, hy, hz);
        const dot = dot3(Math.fround(hx * inverseHalfLength),
                         Math.fround(hy * inverseHalfLength),
                         Math.fround(hz * inverseHalfLength),
                         normal[0], normal[1], normal[2]);
        accumulate(result, light.color, polynomialIntensity(dot, coefficients));
    }
    return result as [number, number, number, number];
}

/** VU1 handler 0x019a: cone-ramped, distance-independent spot diffuse. */
export function evaluateSpotLights(position: Vec4, normal: Vec4,
                                   lights: readonly SpotLightVector[]): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dx = Math.fround(light.position[0] - position[0]);
        const dy = Math.fround(light.position[1] - position[1]);
        const dz = Math.fround(light.position[2] - position[2]);
        const inverseDistance = reciprocalLength3(dx, dy, dz);
        const lx = Math.fround(dx * inverseDistance);
        const ly = Math.fround(dy * inverseDistance);
        const lz = Math.fround(dz * inverseDistance);
        const coneDot = dot3(lx, ly, lz,
                             light.direction[0], light.direction[1], light.direction[2]);
        const cone = Math.min(1, Math.max(0,
            Math.fround(Math.fround(coneDot - light.cone[0]) * light.cone[1])));
        const diffuse = Math.min(1, Math.max(0,
            dot3(lx, ly, lz, normal[0], normal[1], normal[2])));
        accumulate(result, light.color, Math.fround(cone * diffuse));
    }
    return result as [number, number, number, number];
}

/**
 * VU1 handler 0x0212. The cone ramp multiplies N·normalize(viewDirection + L)
 * before the mode-2 polynomial.
 */
export function evaluateMode2SpotLights(
    position: Vec4, normal: Vec4, viewDirection: Vec4,
    lights: readonly SpotLightVector[], coefficients: Vec4,
): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dx = Math.fround(light.position[0] - position[0]);
        const dy = Math.fround(light.position[1] - position[1]);
        const dz = Math.fround(light.position[2] - position[2]);
        const inverseDistance = reciprocalLength3(dx, dy, dz);
        const lx = Math.fround(dx * inverseDistance);
        const ly = Math.fround(dy * inverseDistance);
        const lz = Math.fround(dz * inverseDistance);
        const coneDot = dot3(lx, ly, lz,
                             light.direction[0], light.direction[1], light.direction[2]);
        const cone = Math.min(1, Math.max(0,
            Math.fround(Math.fround(coneDot - light.cone[0]) * light.cone[1])));
        const hx = Math.fround(viewDirection[0] + lx);
        const hy = Math.fround(viewDirection[1] + ly);
        const hz = Math.fround(viewDirection[2] + lz);
        const inverseHalfLength = reciprocalLength3(hx, hy, hz);
        const halfDot = dot3(Math.fround(hx * inverseHalfLength),
                             Math.fround(hy * inverseHalfLength),
                             Math.fround(hz * inverseHalfLength),
                             normal[0], normal[1], normal[2]);
        const input = Math.fround(cone * halfDot);
        accumulate(result, light.color, polynomialIntensity(input, coefficients));
    }
    return result as [number, number, number, number];
}

/**
 * VU1 handler 0x02e4: normal-independent radial polynomial,
 * clamp(kx·r² + ky·r + kz, 0, kw).
 */
export function evaluateRadialLights(position: Vec4,
                                     lights: readonly RadialLightVector[]): Vec4 {
    const result = [0, 0, 0, 0];
    for (const light of lights) {
        const dx = Math.fround(light.position[0] - position[0]);
        const dy = Math.fround(light.position[1] - position[1]);
        const dz = Math.fround(light.position[2] - position[2]);
        const squaredDistance = lengthSquared3(dx, dy, dz);
        const distance = Math.fround(Math.sqrt(squaredDistance));
        let intensity = Math.fround(squaredDistance * light.coefficients[0]);
        intensity = madd(intensity, distance, light.coefficients[1]);
        intensity = Math.fround(intensity + light.coefficients[2]);
        intensity = Math.min(light.coefficients[3], Math.max(0, intensity));
        accumulate(result, light.color, intensity);
    }
    return result as [number, number, number, number];
}

/** VU1 handler 0x02bc: signed dot mapped to complementary hemisphere weights. */
export function evaluateHemisphereLights(normal: Vec4,
                                         lights: readonly HemisphereLightVector[],
                                         initial: Vec4 = [0, 0, 0, 0]): Vec4 {
    const result = [...initial];
    for (const light of lights) {
        const dot = dot3(normal[0], normal[1], normal[2],
                         light.direction[0], light.direction[1],
                         light.direction[2]);
        const positiveWeight = madd(0.5, dot, 0.5);
        const negativeWeight = msub(0.5, dot, 0.5);
        for (let component = 0; component < 4; component++) {
            result[component] = madd(result[component]!,
                                     light.positiveColor[component], positiveWeight);
            result[component] = madd(result[component]!,
                                     light.negativeColor[component], negativeWeight);
        }
    }
    return result as [number, number, number, number];
}

/** Exact VU1 color arithmetic for textured 0x03fc and untextured 0x0488 output paths. */
export function evaluateFinalColor(vertexFactor: Vec4, lighting: Vec4,
                                   ambient: Vec4, factorScale: Vec4,
                                   textured: boolean): Vec4 {
    const result = [0, 0, 0, 0];
    for (let component = 0; component < 4; component++) {
        if (textured) {
            const scaledLighting = Math.fround(lighting[component] * factorScale[component]);
            const combined = madd(scaledLighting, ambient[component], factorScale[component]);
            result[component] = clampColor(Math.fround(vertexFactor[component] * combined));
        } else {
            const scaledFactor = Math.fround(vertexFactor[component] * factorScale[component]);
            const scaledAmbient = Math.fround(ambient[component] * scaledFactor);
            result[component] = clampColor(madd(scaledAmbient, lighting[component], scaledFactor));
        }
    }
    return result as [number, number, number, number];
}
