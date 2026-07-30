import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import {
    decodeI3dAnimation,
    decodeI3dCollision,
    decodeI3dModel,
    decodeTim2,
    memberBytes,
    type DecodedAnimation,
    type DecodedCollision,
    type DecodedModel,
    type ModelAsset,
    type ModelAssetKind,
} from "./vendor/extract/index.ts";
import { download } from "./export.ts";
import {
    isTim2Member,
    modelAssetStem,
    modelMemberStem,
    type ModelCatalog,
    type ModelPackage,
    type ModelStore,
} from "./models.ts";

const LIST_PAGE = 300;
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const KIND_LABEL: Record<ModelAssetKind, string> = {
    model: "MODEL",
    animation: "ANIMATION",
    collision: "COLLISION",
};

interface LoadedScene {
    root: THREE.Group;
    clips: THREE.AnimationClip[];
    clipAssets: ModelAsset[];
    model: DecodedModel | null;
    collision: DecodedCollision | null;
    animation: DecodedAnimation | null;
    textureNames: string[];
    association: string | null;
}

type Status = (message: string, error?: boolean) => void;

function element<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

function escapeMarkup(value: string | number): string {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character]!);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}


function modelScore(animation: DecodedAnimation, boneNames: readonly string[]): number {
    const rotationTracks = animation.tracks.filter(track =>
        track.times.length > 0 && track.rotations.length === track.times.length * 4);
    if (rotationTracks.length === 0 || boneNames.length === 0) return 0;
    const bones = new Set(boneNames);
    const hits = rotationTracks.filter(track => bones.has(track.name)).length;
    const trackCoverage = hits / rotationTracks.length;
    const boneCoverage = hits / boneNames.length;
    return trackCoverage >= 0.75 && boneCoverage >= 0.5
        ? trackCoverage * 2 + boneCoverage : 0;
}

function commonPrefixLength(left: string, right: string): number {
    let length = 0;
    while (length < left.length && length < right.length
           && left[length] === right[length]) length++;
    return length;
}

function materialColor(name: string): THREE.Color {
    let hash = 0x811c9dc5;
    for (const character of name || "material") {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return new THREE.Color().setHSL((hash >>> 0) / 0xffff_ffff, 0.28, 0.58);
}

function matrixFrom(values: Float32Array, offset = 0): THREE.Matrix4 {
    return new THREE.Matrix4().fromArray(values, offset);
}

function disposeObject(root: THREE.Object3D): void {
    root.traverse(object => {
        if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                if ("map" in material && material.map instanceof THREE.Texture)
                    material.map.dispose();
                material.dispose();
            }
        }
    });
}

function clipFrom(animation: DecodedAnimation, name: string,
                  boneNames: ReadonlySet<string>): THREE.AnimationClip {
    const tracks = animation.tracks
        .filter(track => boneNames.has(track.name) && track.times.length > 0
            && track.rotations.length === track.times.length * 4)
        .map(track => new THREE.QuaternionKeyframeTrack(
            `${track.name}.quaternion`, track.times, track.rotations,
            THREE.InterpolateLinear,
        ));
    return new THREE.AnimationClip(name, animation.duration, tracks);
}

function textureFor(packageData: ModelPackage | null, name: string): THREE.DataTexture | null {
    if (!packageData || !name) return null;
    const normalized = name.toLowerCase();
    const member = packageData.members.find(candidate =>
        modelMemberStem(candidate) === normalized && isTim2Member(packageData.data, candidate));
    if (!member) return null;
    const image = decodeTim2(memberBytes(packageData.data, member), 0);
    const texture = new THREE.DataTexture(
        new Uint8Array(image.rgba), image.width, image.height,
        THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    texture.name = name;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
}

type ModelMaterial = THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;

function materialFor(name: string, packageData: ModelPackage | null,
                     textureNames: string[], lit: boolean): ModelMaterial {
    const map = textureFor(packageData, name);
    let zeroAlpha = 0;
    let partialAlpha = 0;
    let pixelCount = 0;
    if (map?.image?.data instanceof Uint8Array) {
        const rgba = map.image.data;
        pixelCount = rgba.length / 4;
        for (let index = 3; index < rgba.length; index += 4) {
            const alpha = rgba[index]!;
            if (alpha === 0) zeroAlpha++;
            else if (alpha < 250) partialAlpha++;
        }
    }
    const visiblePixels = pixelCount - zeroAlpha;
    const usesMask = zeroAlpha > 0 && visiblePixels > 0;
    const usesBlending = partialAlpha / Math.max(pixelCount, 1) >= 0.05;
    if (map) textureNames.push(name);
    const options = {
        name: name || "unnamed",
        color: map ? 0xffffff : materialColor(name),
        map,
        side: THREE.FrontSide,
        transparent: usesBlending,
        alphaTest: usesMask ? (usesBlending ? 0.01 : 0.5) : 0,
        depthWrite: !usesBlending,
    };
    return lit
        ? new THREE.MeshLambertMaterial(options)
        : new THREE.MeshBasicMaterial(options);
}

function buildModel(decoded: DecodedModel, packageData: ModelPackage | null): {
    root: THREE.Group;
    textureNames: string[];
} {
    const root = new THREE.Group();
    root.name = "I3D_MODEL";
    const bones = decoded.bones.map(source => {
        const bone = new THREE.Bone();
        bone.name = source.name;
        return bone;
    });
    for (let index = 0; index < bones.length; index++) {
        const source = decoded.bones[index]!;
        const world = matrixFrom(source.worldMatrix);
        const local = source.parent >= 0
            ? matrixFrom(decoded.bones[source.parent]!.worldMatrix).invert().multiply(world)
            : world;
        local.decompose(bones[index]!.position, bones[index]!.quaternion, bones[index]!.scale);
        if (source.parent >= 0) bones[source.parent]!.add(bones[index]!);
        else root.add(bones[index]!);
    }

    const textureNames: string[] = [];
    const materials = new Map<string, ModelMaterial>();
    for (const source of decoded.meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(source.positions, 3));
        geometry.setAttribute("uv", new THREE.BufferAttribute(source.uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
        const lit = source.normals.length === source.positions.length;
        if (lit) geometry.setAttribute("normal", new THREE.BufferAttribute(source.normals, 3));
        const materialKey = `${lit ? "lit" : "unlit"}\0${source.material}`;
        const material = materials.get(materialKey)
            ?? materialFor(source.material, packageData, textureNames, lit);
        materials.set(materialKey, material);
        if (source.jointBones.length === 0) {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = source.name;
            root.add(mesh);
            continue;
        }
        geometry.setAttribute("skinIndex", new THREE.BufferAttribute(source.skinIndices, 4));
        geometry.setAttribute("skinWeight", new THREE.BufferAttribute(source.skinWeights, 4));
        const skeletonBones = Array.from(source.jointBones, index => bones[index]!);
        const inverses = skeletonBones.map((_, index) =>
            matrixFrom(source.inverseBindMatrices, index * 16));
        const skeleton = new THREE.Skeleton(skeletonBones, inverses);
        const mesh = new THREE.SkinnedMesh(geometry, material);
        mesh.name = source.name;
        mesh.bindMode = THREE.DetachedBindMode;
        mesh.bind(skeleton, new THREE.Matrix4());
        root.add(mesh);
    }
    root.updateMatrixWorld(true);
    return { root, textureNames: [...new Set(textureNames)] };
}

function buildCollision(decoded: DecodedCollision): THREE.Group {
    const root = new THREE.Group();
    root.name = "I3D_COLLISION";
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
        name: decoded.material || "collision",
        color: 0x53d8ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.46,
        wireframe: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "collision_mesh";
    root.add(mesh);
    return root;
}

export class ModelBrowser {
    private store: ModelStore | null = null;
    private catalog: ModelCatalog | null = null;
    private assets: ModelAsset[] = [];
    private filtered: ModelAsset[] = [];
    private selected: ModelAsset | null = null;
    private selectedBytes: Uint8Array | null = null;
    private visible = LIST_PAGE;
    private loadToken = 0;
    private busy = false;
    private loaded: LoadedScene | null = null;
    private renderer: THREE.WebGLRenderer | null = null;
    private camera: THREE.PerspectiveCamera | null = null;
    private scene: THREE.Scene | null = null;
    private controls: OrbitControls | null = null;
    private mixer: THREE.AnimationMixer | null = null;
    private action: THREE.AnimationAction | null = null;
    private skeleton: THREE.SkeletonHelper | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private lastFrame = performance.now();
    private sceneRadius = 0;
    private playing = true;
    private readonly status: Status;

    constructor(status: Status) {
        this.status = status;
        this.wire();
    }

    setStore(store: ModelStore | null): void {
        this.store = store;
        this.catalog = null;
        this.assets = [];
        this.filtered = [];
        this.selected = null;
        this.selectedBytes = null;
        this.clearScene();
        this.renderList();
    }

    async open(): Promise<void> {
        this.ensureRenderer();
        if (!this.store) return;
        if (this.catalog) {
            this.showSetup(false);
            return;
        }
        const catalog = await this.store.cached();
        if (catalog) this.install(catalog);
        else this.showSetup(true);
    }

    close(): void {
        if (this.action) this.action.paused = true;
    }

    handleKey(event: KeyboardEvent): boolean {
        if (event.key === " " && this.action) {
            this.toggleAnimation();
            return true;
        }
        if (event.key === "Enter" && this.filtered.length > 0) {
            const index = this.selected
                ? Math.max(0, this.filtered.findIndex(asset => asset.id === this.selected!.id))
                : 0;
            void this.select(this.filtered[index]!);
            return true;
        }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && this.filtered.length > 0) {
            const current = this.selected
                ? this.filtered.findIndex(asset => asset.id === this.selected!.id) : -1;
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const next = Math.min(this.filtered.length - 1, Math.max(0, current + delta));
            void this.select(this.filtered[next]!);
            return true;
        }
        return false;
    }

    private wire(): void {
        element<HTMLInputElement>("model-search").addEventListener("input", () => this.filter());
        element<HTMLSelectElement>("model-kind").addEventListener("change", () => this.filter());
        element<HTMLUListElement>("modellist").addEventListener("scroll", event => {
            const list = event.currentTarget as HTMLUListElement;
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 160
                && this.visible < this.filtered.length) {
                this.visible += LIST_PAGE;
                this.renderList();
            }
        });
        element<HTMLButtonElement>("model-extract").addEventListener("click", () => void this.extract());
        element<HTMLInputElement>("model-iso").addEventListener("change", event => {
            const file = (event.currentTarget as HTMLInputElement).files?.[0];
            if (file) void this.attachAndExtract(file);
        });
        element<HTMLButtonElement>("model-export-source").addEventListener("click", () => this.exportSource());
        element<HTMLButtonElement>("model-export-glb").addEventListener("click", () => void this.exportGlb());
        element<HTMLButtonElement>("model-reset-view").addEventListener("click", () => this.frameLoaded());
        element<HTMLButtonElement>("model-wireframe").addEventListener("click", event =>
            this.toggleWireframe(event.currentTarget as HTMLButtonElement));
        element<HTMLButtonElement>("model-grid").addEventListener("click", event =>
            this.toggleGrid(event.currentTarget as HTMLButtonElement));
        element<HTMLButtonElement>("model-skeleton").addEventListener("click", event =>
            this.toggleSkeleton(event.currentTarget as HTMLButtonElement));
        element<HTMLButtonElement>("model-anim-play").addEventListener("click", () => this.toggleAnimation());
        element<HTMLSelectElement>("model-animation").addEventListener("change", event =>
            this.playClip(Number((event.currentTarget as HTMLSelectElement).value)));
        element<HTMLInputElement>("model-anim-time").addEventListener("input", event => {
            if (!this.action || !this.mixer) return;
            const time = Number((event.currentTarget as HTMLInputElement).value);
            this.action.paused = true;
            this.playing = false;
            this.action.time = time;
            this.mixer.setTime(time);
            this.updateAnimationUi();
        });
    }

    private ensureRenderer(): void {
        if (this.renderer) return;
        const canvas = element<HTMLCanvasElement>("model-canvas");
        const viewport = element<HTMLElement>("model-viewport");
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x080b0f);
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.001, 100_000);
        this.camera.position.set(2.5, 1.8, 3.5);
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.07;
        this.controls.zoomToCursor = true;
        this.controls.screenSpacePanning = true;
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        ambient.name = "AE3_AMBIENT";
        this.scene.add(ambient);
        const sun1 = new THREE.DirectionalLight(0xffffff, 0.7);
        sun1.name = "AE3_SUN1";
        sun1.position.set(-1, 1, -1);
        this.scene.add(sun1);
        const sun2 = new THREE.DirectionalLight(0xffffff, 0.7);
        sun2.name = "AE3_SUN2";
        sun2.position.set(1, 1, 1);
        this.scene.add(sun2);
        const grid = new THREE.GridHelper(20, 20, 0x294455, 0x15232d);
        grid.name = "MODEL_GRID";
        this.scene.add(grid);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(viewport);
        this.resize();
        this.lastFrame = performance.now();
        const animate = (now: number): void => {
            requestAnimationFrame(animate);
            const delta = Math.min(0.1, (now - this.lastFrame) / 1000);
            this.lastFrame = now;
            if (!element<HTMLElement>("model-main").hidden) {
                if (this.playing) this.mixer?.update(delta);
                this.controls?.update();
                this.updateAnimationUi();
                this.updateCameraRange();
                this.renderer?.render(this.scene!, this.camera!);
            }
        };
        requestAnimationFrame(animate);
    }

    private resize(): void {
        if (!this.renderer || !this.camera) return;
        const viewport = element<HTMLElement>("model-viewport");
        const width = Math.max(1, viewport.clientWidth);
        const height = Math.max(1, viewport.clientHeight);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    private showSetup(show: boolean): void {
        element<HTMLElement>("model-setup").hidden = !show;
        element<HTMLElement>("model-workspace").hidden = show;
        if (!show) return;
        const reconnect = this.store ? !this.store.hasIso() : false;
        element<HTMLButtonElement>("model-extract").hidden = reconnect;
        element<HTMLElement>("model-iso-pick").hidden = !reconnect;
    }

    private install(catalog: ModelCatalog): void {
        this.catalog = catalog;
        this.assets = [...catalog.assets].sort((left, right) =>
            COLLATOR.compare(left.fileName, right.fileName)
            || COLLATOR.compare(left.sourcePath, right.sourcePath)
            || left.memberIndex! - right.memberIndex!);
        this.showSetup(false);
        this.filter();
        const counts = this.assets.reduce((output, asset) => {
            output[asset.kind]++;
            return output;
        }, { model: 0, animation: 0, collision: 0 });
        this.status(`3D ARCHIVE READY · ${counts.model.toLocaleString()} MODELS · ${counts.animation.toLocaleString()} ANIMATIONS · ${counts.collision.toLocaleString()} COLLISION MESHES`);
    }

    private filter(): void {
        const query = element<HTMLInputElement>("model-search").value.trim().toLowerCase();
        const kind = element<HTMLSelectElement>("model-kind").value as "all" | ModelAssetKind;
        this.filtered = this.assets.filter(asset =>
            (kind === "all" || asset.kind === kind)
            && (!query || `${asset.fileName} ${asset.sourcePath} ${asset.attrs}`.toLowerCase().includes(query)));
        this.visible = LIST_PAGE;
        this.renderList();
    }

    private renderList(): void {
        const list = element<HTMLUListElement>("modellist");
        list.replaceChildren();
        for (const asset of this.filtered.slice(0, this.visible)) {
            const item = document.createElement("li");
            item.className = `model-list-item model-${asset.kind}${asset.id === this.selected?.id ? " selected" : ""}`;
            item.dataset.id = asset.id;
            item.innerHTML = `<span class="model-kind-mark">${KIND_LABEL[asset.kind].slice(0, 4)}</span><span><strong>${escapeMarkup(modelAssetStem(asset))}</strong><small>${escapeMarkup(asset.sourcePath)}</small></span>`;
            item.addEventListener("click", () => void this.select(asset));
            list.append(item);
        }
        element<HTMLElement>("model-result-count").textContent =
            `${this.filtered.length.toLocaleString()} ASSETS${this.visible < this.filtered.length ? ` · SHOWING ${this.visible.toLocaleString()}` : ""}`;
    }

    private async extract(): Promise<void> {
        if (!this.store || this.busy) return;
        if (!this.store.hasIso()) {
            this.showSetup(true);
            return;
        }
        this.busy = true;
        const progress = element<HTMLProgressElement>("model-progress");
        const text = element<HTMLElement>("model-setup-status");
        progress.hidden = false;
        try {
            const catalog = await this.store.extract((done, total, path) => {
                progress.max = Math.max(1, total);
                progress.value = done;
                text.textContent = `SCANNING ${done.toLocaleString()} / ${total.toLocaleString()} · ${path}`;
            });
            this.install(catalog);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            text.textContent = message;
            this.status(`3D SCAN FAILED: ${message}`, true);
        } finally {
            this.busy = false;
            progress.hidden = true;
        }
    }

    private async attachAndExtract(file: File): Promise<void> {
        if (!this.store || this.busy) return;
        this.busy = true;
        try {
            element<HTMLElement>("model-setup-status").textContent = "OPENING DISC…";
            await this.store.attachIso(file);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            element<HTMLElement>("model-setup-status").textContent = message;
            this.status(`DISC OPEN FAILED: ${message}`, true);
            this.busy = false;
            return;
        }
        this.busy = false;
        if (this.catalog) {
            this.showSetup(false);
            const selected = this.selected;
            if (selected) await this.select(selected);
            return;
        }
        await this.extract();
    }

    private async select(asset: ModelAsset): Promise<void> {
        if (!this.store || this.busy) return;
        const token = ++this.loadToken;
        this.selected = asset;
        this.selectedBytes = null;
        this.renderList();
        element<HTMLUListElement>("modellist").querySelector(`[data-id="${asset.id}"]`)
            ?.scrollIntoView({ block: "nearest" });
        this.updateActions();
        this.busy = true;
        element<HTMLElement>("model-loading").hidden = false;
        element<HTMLElement>("model-empty").hidden = true;
        this.status(`LOADING ${asset.fileName}…`);
        try {
            const [bytes, packageData] = await Promise.all([
                this.store.read(asset), this.store.package(asset),
            ]);
            if (!bytes) throw new Error("reconnect the same ISO to load this uncached asset");
            if (token !== this.loadToken) return;
            this.selectedBytes = bytes;
            const loaded = await this.decodeSelection(asset, bytes, packageData);
            if (token !== this.loadToken) {
                disposeObject(loaded.root);
                return;
            }
            this.present(asset, loaded);
            this.status(`VIEWING ${asset.fileName}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.clearScene();
            element<HTMLElement>("model-empty").hidden = false;
            element<HTMLElement>("model-empty").textContent = `Cannot preview ${asset.fileName}: ${message}`;
            this.renderInspector(asset, null, message);
            this.status(`3D PREVIEW FAILED: ${message}`, true);
            if (!this.store.hasIso()) {
                element<HTMLElement>("model-setup-status").textContent =
                    "Reconnect the same disc to load this package.";
                this.showSetup(true);
            }
        } finally {
            if (token === this.loadToken) {
                this.busy = false;
                element<HTMLElement>("model-loading").hidden = true;
                this.updateActions();
            }
        }
    }

    private async decodeSelection(asset: ModelAsset, bytes: Uint8Array,
                                  packageData: ModelPackage | null): Promise<LoadedScene> {
        if (asset.kind === "collision") {
            const collision = decodeI3dCollision(bytes, asset.fileName);
            return {
                root: buildCollision(collision), clips: [], clipAssets: [],
                model: null, collision, animation: null,
                textureNames: [], association: null,
            };
        }
        if (asset.kind === "model") {
            const model = decodeI3dModel(bytes, asset.fileName);
            const built = buildModel(model, packageData);
            const animations = this.compatibleAnimations(asset, model, packageData);
            return {
                root: built.root,
                clips: animations.map(item => item.clip),
                clipAssets: animations.map(item => item.asset),
                model, collision: null, animation: null,
                textureNames: built.textureNames,
                association: animations.length > 0
                    ? `${animations.length} package animation${animations.length === 1 ? "" : "s"} matched by bone name`
                    : null,
            };
        }

        const animation = decodeI3dAnimation(bytes, asset.fileName);
        const companion = await this.findCompanionModel(asset, animation, packageData);
        if (!companion) {
            return {
                root: new THREE.Group(), clips: [], clipAssets: [], model: null,
                collision: null, animation, textureNames: [],
                association: "No model with a compatible skeleton was found; source animation remains extractable.",
            };
        }
        const model = decodeI3dModel(companion.bytes, companion.asset.fileName);
        const built = buildModel(model, companion.packageData);
        const clip = clipFrom(animation, modelAssetStem(asset), new Set(model.bones.map(bone => bone.name)));
        return {
            root: built.root, clips: [clip], clipAssets: [asset], model,
            collision: null, animation, textureNames: built.textureNames,
            association: `Previewed on ${companion.asset.fileName}${companion.crossPackage
                ? ` from ${companion.asset.sourcePath}` : ""}; inferred from exact bone-track names.`,
        };
    }

    private compatibleAnimations(asset: ModelAsset, model: DecodedModel,
                                 packageData: ModelPackage | null): Array<{
        asset: ModelAsset;
        clip: THREE.AnimationClip;
    }> {
        if (!packageData || !this.catalog) return [];
        const boneNames = new Set(model.bones.map(bone => bone.name));
        const assets = this.catalog.assets.filter(candidate =>
            candidate.kind === "animation" && candidate.sourcePath === asset.sourcePath);
        const output: Array<{ asset: ModelAsset; clip: THREE.AnimationClip }> = [];
        for (const candidate of assets) {
            if (candidate.memberIndex === null) continue;
            const member = packageData.members[candidate.memberIndex];
            if (!member || member.name !== candidate.memberName) continue;
            const animation = decodeI3dAnimation(memberBytes(packageData.data, member), candidate.fileName);
            if (modelScore(animation, [...boneNames]) === 0) continue;
            output.push({
                asset: candidate,
                clip: clipFrom(animation, modelAssetStem(candidate), boneNames),
            });
        }
        return output;
    }

    private async findCompanionModel(asset: ModelAsset, animation: DecodedAnimation,
                                     packageData: ModelPackage | null): Promise<{
        asset: ModelAsset;
        bytes: Uint8Array;
        packageData: ModelPackage | null;
        crossPackage: boolean;
    } | null> {
        if (!this.store || !this.catalog) return null;
        let best: { asset: ModelAsset; bytes: Uint8Array; score: number } | null = null;
        if (packageData) for (const candidate of this.catalog.assets) {
            if (candidate.kind !== "model" || candidate.sourcePath !== asset.sourcePath
                || candidate.memberIndex === null) continue;
            const member = packageData.members[candidate.memberIndex];
            if (!member || member.name !== candidate.memberName) continue;
            const bytes = memberBytes(packageData.data, member);
            const score = modelScore(animation, candidate.boneNames ?? []);
            if (score > (best?.score ?? 0)) best = { asset: candidate, bytes, score };
        }
        if (best) return {
            asset: best.asset, bytes: best.bytes, packageData, crossPackage: false,
        };

        const animationName = modelAssetStem(asset).toLowerCase();
        const candidates = this.catalog.assets
            .filter(candidate => candidate.kind === "model"
                && candidate.sourcePath !== asset.sourcePath
                && modelScore(animation, candidate.boneNames ?? []) > 0)
            .map(candidate => ({
                asset: candidate,
                score: modelScore(animation, candidate.boneNames ?? []),
                prefix: commonPrefixLength(animationName,
                                           modelAssetStem(candidate).toLowerCase()),
            }))
            .sort((left, right) => right.prefix - left.prefix
                || right.score - left.score
                || COLLATOR.compare(left.asset.fileName, right.asset.fileName)
                || COLLATOR.compare(left.asset.sourcePath, right.asset.sourcePath));
        const chosen = candidates[0]?.asset;
        if (!chosen) return null;
        const [bytes, companionPackage] = await Promise.all([
            this.store.read(chosen), this.store.package(chosen),
        ]);
        if (!bytes)
            throw new Error("reconnect the same ISO to load the compatible model");
        return {
            asset: chosen, bytes, packageData: companionPackage, crossPackage: true,
        };
    }

    private present(asset: ModelAsset, loaded: LoadedScene): void {
        this.clearScene();
        this.loaded = loaded;
        this.scene!.add(loaded.root);
        if (loaded.model && loaded.model.bones.length > 0) {
            this.skeleton = new THREE.SkeletonHelper(loaded.root);
            this.skeleton.visible = element<HTMLButtonElement>("model-skeleton").classList.contains("on");
            this.scene!.add(this.skeleton);
        }
        this.mixer = new THREE.AnimationMixer(loaded.root);
        this.populateAnimations(loaded);
        this.frameLoaded();
        this.renderInspector(asset, loaded, null);
        element<HTMLElement>("model-empty").hidden = loaded.root.children.length > 0;
        if (loaded.root.children.length === 0) {
            element<HTMLElement>("model-empty").textContent = "Animation decoded. No compatible model was available in the same package.";
        }
        this.updateActions();
    }

    private clearScene(): void {
        this.action?.stop();
        this.action = null;
        this.mixer?.stopAllAction();
        this.mixer = null;
        if (this.skeleton && this.scene) this.scene.remove(this.skeleton);
        this.skeleton = null;
        if (this.loaded && this.scene) {
            this.scene.remove(this.loaded.root);
            disposeObject(this.loaded.root);
        }
        this.loaded = null;
        this.sceneRadius = 0;
        this.populateAnimations(null);
    }

    private populateAnimations(loaded: LoadedScene | null): void {
        const select = element<HTMLSelectElement>("model-animation");
        select.replaceChildren(new Option("BIND POSE", "-1"));
        if (loaded) loaded.clips.forEach((clip, index) => select.add(new Option(clip.name, String(index))));
        select.disabled = !loaded || loaded.clips.length === 0;
        element<HTMLButtonElement>("model-anim-play").disabled = select.disabled;
        element<HTMLInputElement>("model-anim-time").disabled = select.disabled;
        if (loaded?.clips.length) {
            select.value = "0";
            this.playClip(0);
        } else {
            this.playClip(-1);
        }
    }

    private playClip(index: number): void {
        this.action?.stop();
        this.action = null;
        this.mixer?.stopAllAction();
        if (!this.loaded || !this.mixer || index < 0 || !this.loaded.clips[index]) {
            this.playing = false;
            this.updateAnimationUi();
            return;
        }
        const clip = this.loaded.clips[index]!;
        this.action = this.mixer.clipAction(clip);
        this.action.reset().play();
        this.playing = true;
        const time = element<HTMLInputElement>("model-anim-time");
        time.max = String(Math.max(0, clip.duration));
        time.step = String(Math.max(1 / 300, clip.duration / 1000));
        time.value = "0";
        element<HTMLSelectElement>("model-animation").value = String(index);
        this.updateAnimationUi();
    }

    private toggleAnimation(): void {
        if (!this.action) return;
        this.playing = !this.playing;
        this.action.paused = !this.playing;
        this.updateAnimationUi();
    }

    private updateAnimationUi(): void {
        const button = element<HTMLButtonElement>("model-anim-play");
        button.textContent = this.playing ? "PAUSE" : "PLAY";
        button.classList.toggle("on", this.playing && this.action !== null);
        const slider = element<HTMLInputElement>("model-anim-time");
        if (this.action && document.activeElement !== slider) slider.value = String(this.action.time);
        const current = this.action?.time ?? 0;
        const duration = this.action?.getClip().duration ?? 0;
        element<HTMLElement>("model-anim-readout").textContent = `${current.toFixed(2)} / ${duration.toFixed(2)} s`;
    }

    private updateCameraRange(): void {
        if (!this.camera || !this.controls || this.sceneRadius <= 0) return;
        const distance = this.camera.position.distanceTo(this.controls.target);
        const near = Math.max(this.sceneRadius / 1000,
                              (distance - this.sceneRadius) * 0.5);
        const far = Math.max(near * 10, distance + this.sceneRadius * 2);
        if (Math.abs(this.camera.near - near) < near * 0.01
            && Math.abs(this.camera.far - far) < far * 0.01) return;
        this.camera.near = near;
        this.camera.far = far;
        this.camera.updateProjectionMatrix();
    }

    private frameLoaded(): void {
        if (!this.loaded || !this.camera || !this.controls) return;
        const box = new THREE.Box3().setFromObject(this.loaded.root);
        if (box.isEmpty()) return;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 0.01);
        const distance = radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.25;
        const direction = new THREE.Vector3(1, 0.6, 1).normalize();
        this.sceneRadius = radius;
        this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
        this.controls.target.copy(sphere.center);
        this.updateCameraRange();
        this.controls.minDistance = radius * 0.02;
        this.controls.maxDistance = radius * 100;
        this.controls.update();
        const grid = this.scene?.getObjectByName("MODEL_GRID");
        if (grid) {
            grid.scale.setScalar(Math.max(radius / 10, 0.01));
            grid.position.set(sphere.center.x, box.min.y, sphere.center.z);
        }
    }

    private toggleWireframe(button: HTMLButtonElement): void {
        button.classList.toggle("on");
        const enabled = button.classList.contains("on");
        this.loaded?.root.traverse(object => {
            if (!(object instanceof THREE.Mesh)) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) if ("wireframe" in material) material.wireframe = enabled;
        });
    }

    private toggleGrid(button: HTMLButtonElement): void {
        button.classList.toggle("on");
        const grid = this.scene?.getObjectByName("MODEL_GRID");
        if (grid) grid.visible = button.classList.contains("on");
    }

    private toggleSkeleton(button: HTMLButtonElement): void {
        button.classList.toggle("on");
        if (this.skeleton) this.skeleton.visible = button.classList.contains("on");
    }

    private renderInspector(asset: ModelAsset, loaded: LoadedScene | null,
                            error: string | null): void {
        const rows: Array<[string, string]> = [
            ["TYPE", KIND_LABEL[asset.kind]],
            ["SOURCE", asset.sourcePath],
            ["MEMBER", asset.memberName ?? "direct VFI entry"],
            ["ATTRIBUTES", asset.attrs || "—"],
            ["SOURCE SIZE", formatBytes(asset.byteLength)],
        ];
        if (loaded?.model) {
            const litPieces = loaded.model.meshes.filter(mesh =>
                mesh.normals.length === mesh.positions.length).length;
            rows.push(
                ["MESH PIECES", loaded.model.meshes.length.toLocaleString()],
                ["VERTICES", loaded.model.vertexCount.toLocaleString()],
                ["TRIANGLES", loaded.model.triangleCount.toLocaleString()],
                ["BONES", loaded.model.bones.length.toLocaleString()],
                ["MATERIALS", loaded.model.materials.filter(Boolean).join(", ") || "untextured"],
                ["TEXTURES", loaded.textureNames.join(", ") || "none resolved in package"],
                ["SHADING", litPieces > 0
                    ? `GAME FALLBACK LIGHTS · ${litPieces.toLocaleString()} / ${loaded.model.meshes.length.toLocaleString()} PIECES WITH AUTHORED NORMALS`
                    : "UNLIT · NO AUTHORED NORMALS"],
                ["ANIMATIONS", loaded.clips.length.toLocaleString()],
            );
        }
        if (loaded?.collision) rows.push(
            ["TRIANGLES", loaded.collision.triangleCount.toLocaleString()],
            ["MATERIAL", loaded.collision.material || "unnamed"],
        );
        if (loaded?.animation) rows.push(
            ["DURATION", `${loaded.animation.duration.toFixed(3)} s`],
            ["TRACKS", loaded.animation.tracks.length.toLocaleString()],
            ["ROTATION TRACKS", loaded.animation.tracks.filter(track =>
                track.times.length > 0
                && track.rotations.length === track.times.length * 4).length.toLocaleString()],
        );
        if (loaded?.association) rows.push(["ASSOCIATION", loaded.association]);
        if (error) rows.push(["ERROR", error]);
        element<HTMLElement>("model-inspector").innerHTML = `
            <span class="model-inspector-kicker">${KIND_LABEL[asset.kind]}</span>
            <h2>${escapeMarkup(modelAssetStem(asset))}</h2>
            <dl>${rows.map(([key, value]) => `<div><dt>${escapeMarkup(key)}</dt><dd>${escapeMarkup(value)}</dd></div>`).join("")}</dl>
            <p class="model-method-note">Geometry, skinning, TIM2 textures, authored normals, and I3M rotations are decoded locally. Lit pieces use the retail fallback ambient and two-sun rig; pieces without normals stay unlit. Stage light regions and fog are scene state and are not embedded in an isolated I3D model. Animation pairing uses exact bone-track names.</p>`;
    }

    private updateActions(): void {
        element<HTMLButtonElement>("model-export-source").disabled = !this.selectedBytes || this.busy;
        element<HTMLButtonElement>("model-export-glb").disabled = !this.loaded
            || this.loaded.root.children.length === 0 || this.busy;
    }

    private exportSource(): void {
        if (!this.selected || !this.selectedBytes) return;
        download(this.selectedBytes, this.selected.fileName, "application/octet-stream");
        this.status(`EXPORTED ${this.selected.fileName}`);
    }

    private async exportGlb(): Promise<void> {
        if (!this.selected || !this.loaded || this.busy) return;
        this.busy = true;
        this.updateActions();
        try {
            const exporter = new GLTFExporter();
            const result = await exporter.parseAsync(this.loaded.root, {
                binary: true,
                onlyVisible: false,
                animations: this.loaded.clips,
            });
            if (!(result instanceof ArrayBuffer)) throw new Error("GLB exporter returned JSON instead of binary data");
            const file = `${modelAssetStem(this.selected)}.glb`;
            download(result, file, "model/gltf-binary");
            const animationCount = this.loaded.clips.length;
            this.status(`EXPORTED ${file}${animationCount
                ? ` WITH ${animationCount} ANIMATION${animationCount === 1 ? "" : "S"}`
                : ""}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.status(`GLB EXPORT FAILED: ${message}`, true);
        } finally {
            this.busy = false;
            this.updateActions();
        }
    }
}
