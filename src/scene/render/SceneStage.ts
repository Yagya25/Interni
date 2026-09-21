import {
  BufferAttribute,
  CanvasTexture,
  NeutralToneMapping,
  Color,
  DepthTexture,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  RedFormat,
  Scene as ThreeScene,
  Raycaster,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  BoxGeometry,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { clamp, degToRad, lerp, range, smoothstep } from "@/lib/math";
import { findOperation, type SceneOperation } from "@/scene/model/operations";
import { ringRadius, turnsOnFloor } from "@/scene/model/editing";
import { findById, objectCenter, roomBounds } from "@/scene/model/queries";
import type { ArtificialLight, Id, Material as SceneMaterial, Scene, SceneObject, Vec3 } from "@/scene/model/types";
import { bracketBox, dimensionString, DynamicSegments, lineMaterial, rotationRing } from "./annotations";
import { buildArchitecture, type ArchitectureBuild } from "./architecture";
import { LightRig } from "./lighting";
import { MaterialFactory, type MaterialOptions } from "./materials";
import { builderFor, type BuildContext } from "./objects";
import {
  createGlobalUniforms,
  createInstanceUniforms,
  createRevealUniforms,
  createShadowDepthMaterial,
  displayColor,
  extendVisibility,
  PHOTO_ATTRIBUTE,
  Role,
  Variant,
  type InstanceUniforms,
  type RevealUniforms,
} from "./shading";
import { TextureLibrary } from "./textures";
import { pixelRatioFor, QUALITY, type QualityProfile, type StageQuality } from "./quality";
import { copyViewState, createViewState, revealGroups, type RevealGroup, type ViewState } from "./viewState";


export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** The element clipped to the hero frame (wraps the canvas). */
  viewport: HTMLElement;
  scene: Scene;
  /** Optional redesign of the same room, revealed by `view.wave`. */
  variant?: Scene;
  operations?: readonly SceneOperation[];
  /** Where each material group's reveal starts. */
  revealSeeds?: Partial<Record<RevealGroup, Vec3>>;
  /** Bring your own state object, e.g. one a timeline already animates. */
  view?: ViewState;
  /**
   * Record what the room's capture camera can see, as it stood at this time
   * of day, so `view.photo` can show the room as the photograph knows it.
   */
  photograph?: { time: number };
  quality: StageQuality;
  onError?: (error: Error) => void;
}

interface ObjectRuntime {
  source: SceneObject;
  variant: number;
  group: Group;
  uniforms: InstanceUniforms;
  materials: Map<string, MeshStandardMaterial>;
  rest: Vector3;
  restRotation: number;
  /** Placement in the redesign, for objects that persist into it. */
  arrangeTo?: { position: Vector3; rotation: number };
  liftDirection: Vector3;
  liftAmount: number;
  parent?: ObjectRuntime;
  /** This frame's displacement from edits and lift, inherited by children. */
  carried: Vector3;
  bracket?: LineSegments;
  bracketMaterial?: LineBasicMaterial;
  blob?: Mesh;
  blobMaterial?: MeshBasicMaterial;
  height: number;
}

interface LampSlot {
  light: PointLight;
  fixture: ObjectRuntime;
  offset: Vector3;
  power: number;
  /** The scene light this fixture emits, re-read whenever the scene changes. */
  source: ArtificialLight;
}

interface Anchor {
  element: HTMLElement;
  key: string;
  layer: HTMLElement | null;
  /** The label box, when this anchor carries one. Absent for bare markers. */
  tag: HTMLElement | null;
  /** Tags that may lose their place first when a group is crowded. */
  minor: boolean;
  /** Measured tag size, refreshed on resize rather than per frame. */
  tagWidth: number;
  tagHeight: number;
  /** Screen box of the placed tag, reused each frame to avoid allocation. */
  readonly box: { x0: number; x1: number; y0: number; y1: number };
  /**
   * What was last written to the element. Styles are only touched when they
   * change, so a still label costs no style work while the camera moves on.
   */
  written: { x: number; y: number; lead: number; flip: boolean };
}

/** Leader length from pin to tag: the resting length, and the most we stretch. */
const LEAD_REST = 12;
const LEAD_MAX = 132;
/** Clear space kept between two tags once they have been pushed apart. */
const LEAD_GAP = 4;
/** Space a tag keeps from the edge of the stage before it flips sides. */
const EDGE_MARGIN = 12;
/** Space kept clear at the top of the stage, where page navigation sits. */
const TOP_CLEARANCE = 64;

const UP = new Vector3(0, 1, 0);
const FALLBACK_MATERIAL: SceneMaterial = {
  id: "fallback",
  class: "paint",
  name: "Unknown",
  color: "#d8d3ca",
  roughness: 0.9,
  metalness: 0,
  pattern: "none",
};

/** Approximate colour of a black-body light source. */
function kelvinToColor(kelvin: number) {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  return new Color(clamp(r / 255), clamp(g / 255), clamp(b / 255));
}

/** A single bell over 0..1, for "while this is happening" emphasis. */
const bell = (t: number) => Math.sin(clamp(t) * Math.PI);

/**
 * Renders a Scene, and optionally its redesign, as one continuous stage.
 * Owns WebGL resources; call `dispose()` when done.
 */
export class SceneStage {
  readonly view: ViewState;
  private readonly renderer: WebGLRenderer;
  private readonly three = new ThreeScene();
  private readonly camera = new PerspectiveCamera(50, 1, 0.05, 80);
  private readonly textures: TextureLibrary;
  private readonly globals = createGlobalUniforms();
  private readonly reveal = Object.fromEntries(
    revealGroups.map((g) => [g, createRevealUniforms()]),
  ) as Record<RevealGroup, RevealUniforms>;
  private readonly materials: MaterialFactory;
  private readonly pmrem: PMREMGenerator;
  private readonly envTexture: Texture;

  private before?: ArchitectureBuild;
  private after?: ArchitectureBuild;
  private rig?: LightRig;
  private readonly objects = new Map<Id, ObjectRuntime>();
  private readonly afterObjects = new Map<Id, ObjectRuntime>();
  private orderedBefore: ObjectRuntime[] = [];
  private lamps: LampSlot[] = [];
  private relations?: DynamicSegments;
  private rays?: DynamicSegments;
  private readonly dimensionLines: LineSegments[] = [];
  /** The ring the selected piece is turned by. Built on first selection. */
  private ring?: LineSegments;
  private readonly ringMaterial = lineMaterial(0);
  private readonly edgeMaterial = lineMaterial(0);
  private readonly dimensionMaterial = lineMaterial(0);
  private readonly relationMaterial: LineDashedMaterial;
  private readonly rayMaterial: LineDashedMaterial;
  private readonly capMaterial = new MeshBasicMaterial({ color: displayColor("#2a2825"), toneMapped: false });
  private ground?: Mesh;
  private readonly restyleFrom = new Color();
  private readonly restyleTo = new Color();
  private blobTexture?: Texture;

  private readonly roomMin = new Vector3();
  private readonly roomMax = new Vector3();
  private readonly roomCenter = new Vector3();

  private anchors: Anchor[] = [];
  private tagsMeasured = false;
  /** Anchors placed this frame, in resolution order. Reused to avoid garbage. */
  private readonly placed: Anchor[] = [];
  private frameElement: HTMLElement | null = null;
  private frameRect = { x: 0, y: 0, w: 1, h: 1 };
  private size = { w: 1, h: 1 };
  private hovered: Id | null = null;
  private selected: Id | null = null;
  /** The scene as it currently stands, which edits move forward. */
  private current: Scene;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly dragPlane = new Plane();
  private active = true;
  private ready = false;
  private frameRequest = 0;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver;
  /** Which variant newly built objects belong to. Fixed once `init` runs. */
  private baseVariant: number = Variant.shared;
  /** A scene that arrived before the build finished. Applied once it has. */
  private queued?: Scene;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();
  private readonly tmp4 = new Vector3();
  private readonly tmpSize = new Vector2();

  /** The depth the photograph recorded: what its camera could see. */
  private photoDepth?: WebGLRenderTarget;
  /** The view the photograph is taken in. */
  private readonly photoView?: ViewState;
  /** Holds the live view while the stage draws another one. */
  private readonly scratchView: ViewState;
  /** Retaken, lazily, whenever the canvas or the hero frame changes shape. */
  private photoStale = true;
  private photoReady = false;

  private readonly profile: QualityProfile;
  /** Set by the frame governor when a device proves slower than its tier. */
  private ratioCap = Infinity;
  private lastFrameAt = 0;
  private readonly intervals = new Float32Array(90);
  private readonly sortedIntervals = new Float32Array(90);
  private intervalCount = 0;
  private governorQuietUntil = 0;

  /**
   * The shadow map is redrawn only when something that casts or lights it
   * has changed. Most of the film moves only the camera, which leaves every
   * shadow exactly where it was.
   */
  private readonly shadowKey = new Float64Array(9).fill(NaN);
  /** Rises with every scene edit, so an edit always redraws shadows. */
  private sceneVersion = 0;

  constructor(private readonly options: StageOptions) {
    const { canvas, scene, quality, viewport } = options;
    this.current = scene;
    this.profile = QUALITY[quality];
    this.view =
      options.view ??
      createViewState({
      px: scene.camera.position[0],
      py: scene.camera.position[1],
      pz: scene.camera.position[2],
      tx: scene.camera.target[0],
      ty: scene.camera.target[1],
      tz: scene.camera.target[2],
      fov: scene.camera.verticalFov,
    });

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(pixelRatioFor(this.profile, viewport.clientWidth, viewport.clientHeight));
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Neutral keeps material colours true and rolls highlights off softly,
    // which is how a well-exposed interior photograph behaves.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setClearColor(new Color("#efece6"), 1);
    // Synchronous shader validation is for development. In production it
    // blocks parallel compilation and surfaces driver-level notices from
    // three's own shader chunks.
    this.renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";

    this.textures = new TextureLibrary(this.renderer.capabilities.getMaxAnisotropy());
    this.materials = new MaterialFactory(this.textures, this.globals, this.reveal);

    this.pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTexture = this.pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    this.three.environment = this.envTexture;

    this.relationMaterial = new LineDashedMaterial({
      color: "#191816",
      dashSize: 0.06,
      gapSize: 0.05,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.rayMaterial = this.relationMaterial.clone();
    this.rayMaterial.color.set("#191816");

    if (options.photograph) {
      const c = scene.camera;
      this.photoView = createViewState({
        px: c.position[0],
        py: c.position[1],
        pz: c.position[2],
        tx: c.target[0],
        ty: c.target[1],
        tz: c.target[2],
        fov: c.verticalFov,
      });
      this.photoView.frame = 0;
      this.photoView.time = options.photograph.time;
    }
    this.scratchView = createViewState(this.view.camera);

    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    // (the frame element is observed too, see setFrameElement)
    this.resizeObserver.observe(options.viewport);
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Build everything. Yields between steps so a loader can paint. */
  async init(onProgress?: (progress: number) => void) {
    const yieldFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const { scene, variant, operations = [] } = this.options;
    const report = (p: number) => onProgress?.(p);

    report(0.05);
    this.configureRoom(scene);
    // Textures are the slowest part; draw them up front.
    [...scene.materials, ...(variant?.materials ?? []), ...operations.flatMap(materialsOf)].forEach((m) =>
      this.textures.get(m.pattern, m.patternScale ?? 1),
    );
    report(0.3);
    await yieldFrame();
    if (this.disposed) return;

    const hasVariant = Boolean(variant);
    this.before = buildArchitecture(scene, {
      materials: this.materials,
      instance: createInstanceUniforms(Role.architecture, hasVariant ? Variant.before : Variant.shared),
      includeShared: true,
      edgeMaterial: this.edgeMaterial,
      capMaterial: this.capMaterial,
    });
    this.three.add(this.before.root);
    if (variant) {
      this.after = buildArchitecture(variant, {
        materials: this.materials,
        instance: createInstanceUniforms(Role.architecture, Variant.after),
        includeShared: false,
        edgeMaterial: this.edgeMaterial,
        capMaterial: this.capMaterial,
      });
      this.three.add(this.after.root);
    }
    this.addShadowEnclosure(scene);
    report(0.45);
    await yieldFrame();
    if (this.disposed) return;

    const beforeVariant = hasVariant ? Variant.before : Variant.shared;
    this.baseVariant = beforeVariant;
    scene.objects.forEach((o) => this.objects.set(o.id, this.buildObject(o, scene, beforeVariant)));
    const replace = findOperation(operations, "replace");
    if (replace) {
      const replacement = this.buildObject(replace.replacement, scene, beforeVariant);
      replacement.uniforms.uClipY.value = -1;
      this.objects.set(replace.replacement.id, replacement);
    }
    variant?.objects.forEach((o) => this.afterObjects.set(o.id, this.buildObject(o, variant, Variant.after)));
    this.linkObjects();
    // Everything is still where the photograph found it.
    if (this.options.photograph) this.bakePhotoCoordinates();
    report(0.7);
    await yieldFrame();
    if (this.disposed) return;

    this.buildLighting(scene, variant);
    this.buildAnnotations(scene);
    this.buildGround();
    report(0.8);
    await yieldFrame();
    if (this.disposed) return;

    this.applyView();
    try {
      await this.renderer.compileAsync(this.three, this.camera);
    } catch {
      // Older drivers without parallel compile: the first render compiles.
    }
    if (this.disposed) return;
    this.warmUp();
    this.ready = true;
    report(1);
    // Edits made while the room was still building are applied now, against
    // the scene it was actually built from.
    if (this.queued) {
      const queued = this.queued;
      this.queued = undefined;
      this.syncScene(queued);
    }
    this.renderNow();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    this.resizeObserver.disconnect();
    this.options.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.three.traverse((object) => {
      if (object instanceof Mesh || object instanceof LineSegments) {
        object.geometry.dispose();
        const mats: Material[] = Array.isArray(object.material) ? object.material : [object.material];
        mats.forEach((m) => m.dispose());
        if (object instanceof Mesh && object.customDepthMaterial) object.customDepthMaterial.dispose();
      }
    });
    this.ring?.geometry.dispose();
    this.ringMaterial.dispose();
    this.materials.dispose();
    this.textures.dispose();
    this.blobTexture?.dispose();
    this.photoDepth?.depthTexture?.dispose();
    this.photoDepth?.dispose();
    this.envTexture.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }

  // -------------------------------------------------------------------------
  // Public controls

  invalidate() {
    if (!this.ready || !this.active || this.disposed || this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.renderNow();
    });
  }

  /** Pause rendering while the stage is off screen. */
  setActive(active: boolean) {
    this.active = active;
    if (active) this.invalidate();
  }

  /** The element whose box the photograph is composed into at `view.frame = 1`. */
  setFrameElement(element: HTMLElement | null) {
    if (this.frameElement) this.resizeObserver.unobserve(this.frameElement);
    this.frameElement = element;
    if (element) this.resizeObserver.observe(element);
    this.measureFrame();
    this.invalidate();
  }

  /** Collect DOM labels (`data-anchor`) to be pinned to points in the scene. */
  bindOverlay(root: HTMLElement) {
    this.anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-anchor]")).map((element) => ({
      element,
      key: element.dataset.anchor ?? "",
      layer: element.closest<HTMLElement>("[data-layer]"),
      tag: element.querySelector<HTMLElement>("[data-tag]"),
      minor: element.dataset.small !== undefined,
      tagWidth: 0,
      tagHeight: 0,
      box: { x0: 0, x1: 0, y0: 0, y1: 0 },
      written: { x: NaN, y: NaN, lead: NaN, flip: false },
    }));
    // Substantial labels claim their place first; small ones fit around them.
    // The sort is stable, so markup order decides everything else.
    this.anchors.sort((a, b) => Number(a.minor) - Number(b.minor));
    this.tagsMeasured = false;
    // Tags are set in a webfont; their widths change when it arrives.
    document.fonts?.ready.then(() => {
      if (this.disposed) return;
      this.tagsMeasured = false;
      this.invalidate();
    });
    this.invalidate();
  }

  /**
   * Cache each tag's size. Tag text never changes, so this is read once and
   * again after a resize, rather than per frame where it would force layout
   * in the middle of a scroll. Hidden layers use `visibility`, not `display`,
   * so their tags still have a measurable box.
   *
   * Early frames can run before the overlay has been laid out, when every box
   * reads zero. That result is not cached: measuring is retried until the tags
   * have real sizes, and again once the webfont they are set in has loaded,
   * since that changes their width.
   */
  private measureTags() {
    let laidOut = true;
    for (const anchor of this.anchors) {
      if (!anchor.tag) continue;
      anchor.tagWidth = anchor.tag.offsetWidth;
      anchor.tagHeight = anchor.tag.offsetHeight;
      if (anchor.tagHeight === 0) laidOut = false;
    }
    this.tagsMeasured = laidOut;
  }

  setHover(objectId: Id | null) {
    if (this.hovered === objectId) return;
    this.hovered = objectId;
    this.invalidate();
  }

  setSelection(objectId: Id | null) {
    if (this.selected === objectId) return;
    this.selected = objectId;
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Picking

  /**
   * The object under a point in client coordinates, or null for the room
   * itself or empty space. Architecture is included in the cast so that a
   * piece standing behind a wall is not pickable through it.
   */
  pick(clientX: number, clientY: number): Id | null {
    if (!this.ready || this.disposed) return null;
    if (!this.castFrom(clientX, clientY)) return null;
    const targets: Object3D[] = [];
    if (this.before) targets.push(this.before.root);
    for (const runtime of this.objects.values()) targets.push(runtime.group);

    for (const hit of this.raycaster.intersectObjects(targets, true)) {
      // Linework and the invisible shadow enclosure are not surfaces a
      // person can point at.
      if (!(hit.object instanceof Mesh)) continue;
      const material = hit.object.material;
      if (!Array.isArray(material) && material.colorWrite === false) continue;
      return objectIdOf(hit.object);
    }
    return null;
  }

  /**
   * Where a point in client coordinates meets the plane through `origin`
   * with the given normal. Dragging a piece is a cast onto the plane it is
   * free to move in: the floor under it, or the wall it hangs on.
   */
  pointOnPlane(clientX: number, clientY: number, origin: Vec3, normal: Vec3): Vec3 | null {
    if (this.disposed || !this.castFrom(clientX, clientY)) return null;
    this.dragPlane.setFromNormalAndCoplanarPoint(
      this.tmp.set(...normal).normalize(),
      this.tmp2.set(...origin),
    );
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.tmp);
    return hit ? [hit.x, hit.y, hit.z] : null;
  }

  private castFrom(clientX: number, clientY: number): boolean {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  // -------------------------------------------------------------------------
  // Editing

  /**
   * Move the stage onto a new version of its scene.
   *
   * Operations produce a new Scene that shares everything they did not
   * touch, so the diff below is mostly reference comparisons: a sofa sliding
   * across the floor repaints no materials and rebuilds no geometry. Only a
   * change to what an object *is* - its category, form or measured size -
   * costs a rebuild.
   */
  syncScene(next: Scene) {
    const previous = this.current;
    if (next === previous || this.disposed) return;
    if (!this.ready) {
      // Nothing is built to diff against yet.
      this.queued = next;
      return;
    }
    this.current = next;

    const changed = new Set<Id>();
    if (next.materials !== previous.materials) {
      const before = new Map(previous.materials.map((m) => [m.id, m]));
      for (const material of next.materials) {
        if (before.get(material.id) !== material) changed.add(material.id);
      }
    }

    if (changed.size > 0 || next.surfaces !== previous.surfaces) this.syncSurfaces(next, changed);
    if (changed.size > 0 || next.objects !== previous.objects) this.syncObjects(next, changed);
    if (next.lights !== previous.lights) this.syncLights(next);
    this.sceneVersion += 1;
    this.invalidate();
  }

  private syncSurfaces(next: Scene, changed: Set<Id>) {
    this.before?.surfaceMaterials.forEach((material, surfaceId) => {
      const surface = findById(next.surfaces, surfaceId);
      if (!surface) return;
      const source = findById(next.materials, surface.materialId) ?? FALLBACK_MATERIAL;
      if (material.userData.sourceId === source.id && !changed.has(source.id)) return;
      this.materials.applyTo(material, source);
    });
  }

  private syncObjects(next: Scene, changed: Set<Id>) {
    const present = new Set<Id>();
    // Only a change to what is in the room, or to what holds it up, can
    // alter the support chains. A sofa sliding across the floor cannot,
    // so the relinking below stays out of the drag.
    let structural = false;
    for (const object of next.objects) {
      present.add(object.id);
      const runtime = this.objects.get(object.id);
      if (!runtime) {
        this.objects.set(object.id, this.buildObject(object, next, this.baseVariant));
        structural = true;
        continue;
      }
      if (rebuildNeeded(runtime.source, object)) {
        this.disposeRuntime(runtime);
        this.objects.set(object.id, this.buildObject(object, next, this.baseVariant));
        structural = true;
        continue;
      }
      let repaint = changed.size > 0;
      if (runtime.source !== object) {
        if (runtime.source.support !== object.support) structural = true;
        // A material's own definition can change under an object that did
        // not, and an object can be pointed at a different one.
        if (runtime.source.materials !== object.materials) repaint = true;
        runtime.source = object;
        runtime.rest.set(...object.transform.position);
        runtime.restRotation = object.transform.rotation[1];
        const [sx, sy, sz] = object.transform.scale;
        runtime.group.rotation.x = object.transform.rotation[0];
        runtime.group.rotation.z = object.transform.rotation[2];
        if (!runtime.group.scale.equals(this.tmp2.set(sx, sy, sz))) {
          runtime.group.scale.set(sx, sy, sz);
          // The contact shadow is a separate plane, so it is scaled by hand.
          runtime.blob?.scale.set(sx, 1, sz);
        }
        runtime.height = object.dimensions[1] * sy;
      }
      if (repaint) this.syncObjectMaterials(runtime, object, next, changed);
    }

    for (const [id, runtime] of this.objects) {
      if (present.has(id)) continue;
      this.disposeRuntime(runtime);
      this.objects.delete(id);
      structural = true;
    }
    // Support chains, lift directions and draw order are all derived.
    if (structural) this.linkObjects();
  }

  private syncObjectMaterials(
    runtime: ObjectRuntime,
    object: SceneObject,
    scene: Scene,
    changed: Set<Id>,
  ) {
    runtime.materials.forEach((material) => {
      const slot = material.userData.slot as string | undefined;
      const source =
        findById(scene.materials, (slot && object.materials[slot]) || "") ?? FALLBACK_MATERIAL;
      if (material.userData.sourceId === source.id && !changed.has(source.id)) return;
      this.materials.applyTo(material, source);
      // A repaint supersedes any restyle the timeline had blended part-way.
      delete material.userData.restyleFrom;
    });
  }

  private syncLights(next: Scene) {
    for (const lamp of this.lamps) {
      const source = next.lights.find(
        (l): l is ArtificialLight => l.kind === "artificial" && l.id === lamp.source.id,
      );
      if (!source) continue;
      if (source.colorTemperature !== lamp.source.colorTemperature) {
        lamp.light.color.copy(kelvinToColor(source.colorTemperature));
      }
      lamp.source = source;
    }
  }

  private disposeRuntime(runtime: ObjectRuntime) {
    const perished = new Set<Material>();
    runtime.group.traverse((child) => {
      if (child instanceof Mesh || child instanceof LineSegments) child.geometry.dispose();
      if (child instanceof Mesh && child.customDepthMaterial) perished.add(child.customDepthMaterial);
    });
    perished.forEach((m) => m.dispose());
    runtime.group.removeFromParent();
    runtime.materials.forEach((m) => m.dispose());
    runtime.bracketMaterial?.dispose();
    if (runtime.blob) {
      runtime.blob.removeFromParent();
      runtime.blob.geometry.dispose();
      runtime.blobMaterial?.dispose();
    }
    this.orderedBefore = this.orderedBefore.filter((r) => r !== runtime);
    this.lamps = this.lamps.filter((lamp) => {
      if (lamp.fixture !== runtime) return true;
      lamp.light.removeFromParent();
      lamp.light.dispose();
      return false;
    });
  }

  // -------------------------------------------------------------------------
  // Building

  private configureRoom(scene: Scene) {
    const b = roomBounds(scene);
    this.roomMin.set(...b.min);
    this.roomMax.set(...b.max);
    this.roomCenter.addVectors(this.roomMin, this.roomMax).multiplyScalar(0.5);
    this.globals.uRoomMin.value.copy(this.roomMin);
    // The open side of the room (behind the camera) has no wall to darken.
    this.globals.uRoomMax.value.set(b.max[0], b.max[1], b.max[2] + 50);
    this.globals.uCapturePos.value.set(...scene.camera.position);
    for (const group of revealGroups) {
      const seed = this.options.revealSeeds?.[group];
      if (seed) this.reveal[group].uRevealSeed.value.set(...seed);
      else this.reveal[group].uRevealSeed.value.copy(this.roomCenter);
    }
  }

  private buildObject(object: SceneObject, scene: Scene, variant: number): ObjectRuntime {
    const uniforms = createInstanceUniforms(Role.object, variant);
    const cache = new Map<string, MeshStandardMaterial>();
    const materialFor = (slot: string, options: MaterialOptions = {}) => {
      const key = `${slot}|${options.key ?? ""}|${options.side ?? ""}|${options.sectionCaps ? 1 : 0}`;
      let material = cache.get(key);
      if (!material) {
        const source = findById(scene.materials, object.materials[slot] ?? "") ?? FALLBACK_MATERIAL;
        material = this.materials.create(source, uniforms, options);
        material.userData.slot = slot;
        cache.set(key, material);
      }
      return material;
    };
    const context: BuildContext = { object, material: materialFor, textures: this.textures };
    const group = builderFor(object.category)(context);
    group.name = `object:${object.id}`;
    // Unlit helpers only need the visibility rules, which read the sweep.
    const visibility = { ...uniforms, uWave: this.globals.uWave };
    const depth = createShadowDepthMaterial(visibility);
    group.traverse((child) => {
      if (child instanceof Mesh) child.customDepthMaterial = depth;
    });

    const [px, py, pz] = object.transform.position;
    group.position.set(px, py, pz);
    group.rotation.set(...object.transform.rotation);
    group.scale.set(...object.transform.scale);
    this.three.add(group);

    const runtime: ObjectRuntime = {
      source: object,
      variant,
      group,
      uniforms,
      materials: cache,
      rest: group.position.clone(),
      restRotation: object.transform.rotation[1],
      liftDirection: new Vector3(0, 1, 0),
      liftAmount: 0,
      carried: new Vector3(),
      height: object.dimensions[1] * object.transform.scale[1],
    };

    if (variant !== Variant.after) {
      runtime.bracketMaterial = lineMaterial(0);
      runtime.bracket = bracketBox(object.dimensions, runtime.bracketMaterial);
      group.add(runtime.bracket);
    }

    if (object.support.kind === "floor" && object.category !== "rug") {
      runtime.blobMaterial = new MeshBasicMaterial({
        map: this.getBlobTexture(),
        color: "#000000",
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        toneMapped: false,
      });
      extendVisibility(runtime.blobMaterial, visibility);
      const [w, , d] = object.dimensions;
      runtime.blob = new Mesh(new PlaneGeometry(w * 1.25 + 0.1, d * 1.25 + 0.1).rotateX(-Math.PI / 2), runtime.blobMaterial);
      runtime.blob.renderOrder = 1;
      this.three.add(runtime.blob);
    }
    return runtime;
  }

  /** Resolve support chains, lift directions and redesign targets. */
  private linkObjects() {
    const { variant } = this.options;
    const liftFor = (o: SceneObject, index: number) => {
      if (o.category === "rug") return 0.03;
      return 0.1 + (index % 3) * 0.045;
    };
    let index = 0;
    for (const runtime of this.objects.values()) {
      const support = runtime.source.support;
      if (support.kind === "wall") {
        const wall = this.before?.walls.find((w) => w.id === support.wallId);
        if (wall) runtime.liftDirection.copy(wall.inward);
        runtime.liftAmount = 0.16;
      } else if (support.kind === "ceiling") {
        runtime.liftDirection.set(0, -1, 0);
        runtime.liftAmount = 0.2;
      } else if (support.kind === "object") {
        runtime.parent = this.objects.get(support.objectId);
        runtime.liftAmount = 0.08;
      } else {
        runtime.liftAmount = liftFor(runtime.source, index++);
      }
      const target = variant?.objects.find((o) => o.id === runtime.source.id);
      if (target) {
        runtime.arrangeTo = {
          position: new Vector3(...target.transform.position),
          rotation: target.transform.rotation[1],
        };
      }
    }
    // Parents before children so carried motion is ready when read.
    const depthOf = (r: ObjectRuntime): number => (r.parent ? depthOf(r.parent) + 1 : 0);
    this.orderedBefore = [...this.objects.values()].sort((a, b) => depthOf(a) - depthOf(b));
  }

  /**
   * Record where every surface sat in the capture camera's view, with the
   * room at rest, as a vertex attribute (see `PHOTO_ATTRIBUTE`). Runs once,
   * after building and before anything has moved.
   */
  private bakePhotoCoordinates() {
    const shot = this.options.scene.camera;
    const eye = new PerspectiveCamera();
    eye.position.set(...shot.position);
    eye.lookAt(...shot.target);
    eye.updateMatrixWorld(true);
    const toEye = new Matrix4();
    const point = new Vector3();
    const baked = new Set<BufferGeometry>();
    const roots = [this.before?.root, ...[...this.objects.values()].map((r) => r.group)];
    for (const root of roots) {
      if (!root) continue;
      root.updateMatrixWorld(true);
      root.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        // A geometry shared by two meshes can hold only one set of
        // coordinates, so the second gets a copy of its own.
        if (baked.has(node.geometry)) node.geometry = node.geometry.clone();
        baked.add(node.geometry);
        toEye.multiplyMatrices(eye.matrixWorldInverse, node.matrixWorld);
        const position = node.geometry.getAttribute("position");
        const out = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i += 1) {
          point.fromBufferAttribute(position, i).applyMatrix4(toEye).toArray(out, i * 3);
        }
        node.geometry.setAttribute(PHOTO_ATTRIBUTE, new BufferAttribute(out, 3));
      });
    }
  }

  /**
   * Take the photograph: record, from the room's capture camera and with
   * the room as it stood then, the depth of whatever that camera could see.
   *
   * The picture itself is not kept. Shown from anywhere but where it was
   * taken, a photograph's pixels are stretched and soften; the room renders
   * sharply from any viewpoint. What the photograph contributes is knowledge:
   * which surfaces it saw, and so which it never did.
   *
   * The frustum is widened just enough to also fill the hero frame, whose
   * proportions differ from the canvas's, and the depth is recorded at up to
   * twice the canvas's resolution so the edge of the unseen stays clean.
   */
  private capturePhotograph() {
    const { photoView } = this;
    if (!photoView) return;
    this.photoStale = false;
    const g = this.globals;
    const hovered = this.hovered;
    const selected = this.selected;
    const held = copyViewState(this.scratchView, this.view);
    copyViewState(this.view, photoView);
    this.hovered = this.selected = null;
    // A texture must not be sampled while it is being written.
    g.uPhotoDepth.value = null;
    this.applyView();

    const { w, h } = this.size;
    const aspect = w / h;
    const fov = photoView.camera.fov;
    const cover = (a: number) => {
      const t = Math.tan(degToRad(effectiveFov(fov, a)) / 2);
      return Math.max(t, (t * a) / aspect);
    };
    const half = Math.max(cover(aspect), cover(this.frameRect.w / this.frameRect.h)) * 1.02;
    const camera = this.camera;
    camera.clearViewOffset();
    camera.aspect = aspect;
    camera.fov = (2 * Math.atan(half) * 180) / Math.PI;
    camera.updateProjectionMatrix();

    const buffer = this.renderer.getDrawingBufferSize(this.tmpSize);
    const scale = Math.min(
      2,
      MAX_TEXTURE_EDGE / Math.max(buffer.x, buffer.y),
      Math.sqrt(PHOTO_DEPTH_BUDGET / (buffer.x * buffer.y)),
    );
    const dw = Math.max(1, Math.round(buffer.x * scale));
    const dh = Math.max(1, Math.round(buffer.y * scale));
    if (!this.photoDepth) {
      // Only the depth attachment is read; the colour is a single channel.
      this.photoDepth = new WebGLRenderTarget(dw, dh, { format: RedFormat, depthTexture: new DepthTexture(dw, dh) });
    } else if (this.photoDepth.width !== dw || this.photoDepth.height !== dh) {
      this.photoDepth.setSize(dw, dh);
    }
    this.renderer.setRenderTarget(this.photoDepth);
    this.renderer.render(this.three, camera);
    this.renderer.setRenderTarget(null);

    g.uPhotoDepth.value = this.photoDepth.depthTexture;
    g.uPhotoTexel.value.set(1 / dw, 1 / dh);
    g.uPhotoProjection.value.copy(camera.projectionMatrix);
    g.uPhotoNear.value = camera.near;
    g.uPhotoFar.value = camera.far;
    this.photoReady = true;

    copyViewState(this.view, held);
    this.hovered = hovered;
    this.selected = selected;
  }

  /**
   * Draw once with every layer of the story showing, behind the loader.
   * Compiling a program is not the whole cost: drivers build some shader
   * variants only when a draw first needs them, and a line or cap that first
   * appears in the middle of a scroll would stall that frame to do it.
   */
  private warmUp() {
    const held = copyViewState(this.scratchView, this.view);
    Object.assign(this.view, {
      frame: 0,
      depth: 1,
      depthFront: 10,
      clay: 0.5,
      edges: 1,
      explode: 0.5,
      separate: 0.5,
      boxes: 1,
      rays: 1,
      time: 0.5,
      editReplace: 0.5,
      cutaway: 1,
      relations: 1,
      dimensions: 1,
      wave: 0.5,
      waveLine: 1,
    });
    this.applyView();
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.three, this.camera);
    copyViewState(this.view, held);
    this.shadowKey.fill(NaN);
  }

  /** Invisible walls that only cast shadows, closing the room to the sun. */
  private addShadowEnclosure(scene: Scene) {
    const b = roomBounds(scene);
    const material = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const front = new Mesh(new BoxGeometry(b.max[0] - b.min[0] + 0.4, scene.room.height, 0.16), material);
    front.position.set((b.min[0] + b.max[0]) / 2, scene.room.height / 2, b.max[2] + 0.08);
    front.castShadow = true;
    this.three.add(front);
  }

  private buildLighting(scene: Scene, variant?: Scene) {
    const windows = (this.before?.openings ?? []).filter((o) => o.kind === "window");
    this.rig = new LightRig(this.three, this.roomCenter, windows, this.profile.shadowMapSize);

    const addLamps = (source: Scene, objects: Map<Id, ObjectRuntime>) => {
      source.lights
        .filter((l): l is ArtificialLight => l.kind === "artificial")
        .forEach((l) => {
          const fixture = objects.get(l.fixtureId);
          if (!fixture) return;
          const light = new PointLight(kelvinToColor(l.colorTemperature), 0, 0, 2);
          light.castShadow = false;
          this.three.add(light);
          const pendant = fixture.source.category === "pendant-lamp";
          this.lamps.push({
            light,
            fixture,
            offset: new Vector3(...l.emitterOffset),
            power: pendant ? 2.6 : 3.4,
            source: l,
          });
        });
    };
    addLamps(scene, this.objects);
    if (variant) addLamps(variant, this.afterObjects);
  }

  private buildAnnotations(scene: Scene) {
    this.relations = new DynamicSegments(scene.relationships.length, this.relationMaterial);
    this.three.add(this.relations.lines);

    const windows = (this.before?.openings ?? []).filter((o) => o.kind === "window");
    this.rays = new DynamicSegments(windows.length * 2, this.rayMaterial);
    this.three.add(this.rays.lines);

    // Plan dimensions sit at wall-top height, outside the walls, where a
    // raised view reads them the way it reads a plan. Height stands at the
    // open front corner.
    const min = this.roomMin;
    const max = this.roomMax;
    const top = scene.room.height + 0.01;
    const t = 0.16;
    const width = dimensionString(
      new Vector3(min.x, top, min.z - t),
      new Vector3(max.x, top, min.z - t),
      new Vector3(0, 0, -0.5),
      this.dimensionMaterial,
    );
    const depth = dimensionString(
      new Vector3(min.x - t, top, max.z),
      new Vector3(min.x - t, top, min.z),
      new Vector3(-0.5, 0, 0),
      this.dimensionMaterial,
    );
    const height = dimensionString(
      new Vector3(max.x + t, 0, max.z),
      new Vector3(max.x + t, scene.room.height, max.z),
      new Vector3(0.45, 0, 0),
      this.dimensionMaterial,
    );
    this.dimensionLines.push(width, depth, height);
    this.dimensionLines.forEach((l) => this.three.add(l));
  }

  private buildGround() {
    this.ground = new Mesh(
      new PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
      new ShadowMaterial({ color: "#2a2520", opacity: 0, transparent: true, depthWrite: false }),
    );
    this.ground.position.y = -0.245;
    this.ground.receiveShadow = true;
    this.three.add(this.ground);
  }

  private getBlobTexture() {
    if (this.blobTexture) return this.blobTexture;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.45, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new CanvasTexture(canvas);
    // The blob is used as an alpha mask on black.
    this.blobTexture = texture;
    return texture;
  }

  // -------------------------------------------------------------------------
  // Frame

  private resize() {
    const { viewport } = this.options;
    const w = Math.max(1, viewport.clientWidth);
    const h = Math.max(1, viewport.clientHeight);
    // Re-read every time: zooming the page or moving the window to another
    // display changes the device pixel ratio without resizing anything.
    const ratio = pixelRatioFor(this.profile, w, h, this.ratioCap);
    if (w !== this.size.w || h !== this.size.h || ratio !== this.renderer.getPixelRatio()) {
      if (w !== this.size.w || h !== this.size.h) {
        // The photograph is framed for the canvas as it was.
        this.photoStale = true;
        // Label type is responsive, so the cached tag boxes are now stale.
        this.tagsMeasured = false;
      }
      this.size = { w, h };
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
    this.measureFrame();
    this.renderNow();
  }

  private measureFrame() {
    const { viewport } = this.options;
    const previous = this.frameRect;
    if (!this.frameElement) {
      this.frameRect = { x: 0, y: 0, w: this.size.w, h: this.size.h };
    } else {
      const outer = viewport.getBoundingClientRect();
      const inner = this.frameElement.getBoundingClientRect();
      this.frameRect = {
        x: inner.left - outer.left,
        y: inner.top - outer.top,
        w: Math.max(1, inner.width),
        h: Math.max(1, inner.height),
      };
    }
    // The photograph's frustum is widened to cover the hero frame.
    if (previous.w !== this.frameRect.w || previous.h !== this.frameRect.h) this.photoStale = true;
  }

  private renderNow() {
    if (!this.ready || this.disposed) return;
    this.observeFrame(performance.now());
    if (this.photoStale && this.view.photo > 0.001) this.capturePhotograph();
    this.applyView();
    if (this.shadowsChanged()) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.three, this.camera);
    this.projectAnchors();
  }

  /** Whether anything that casts a shadow, or the sun, has moved. */
  private shadowsChanged() {
    const v = this.view;
    const key = this.shadowKey;
    let changed = false;
    const values = SHADOW_VALUES;
    values[0] = v.time;
    values[1] = v.separate;
    values[2] = v.editMove;
    values[3] = v.editReplace;
    values[4] = v.arrange;
    values[5] = v.wave;
    values[6] = v.explode;
    values[7] = v.cutaway;
    values[8] = this.sceneVersion;
    for (let i = 0; i < values.length; i += 1) {
      if (key[i] !== values[i]) {
        key[i] = values[i];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The frame governor. While the stage renders continuously, it keeps the
   * last few seconds of frame intervals; if the typical frame is taking long
   * enough to drop below about 45 frames a second, it draws fewer pixels,
   * a quarter step at a time, down to the tier's floor. It never steps back
   * up within a visit, so the resolution cannot oscillate.
   */
  private observeFrame(now: number) {
    const interval = now - this.lastFrameAt;
    this.lastFrameAt = now;
    // A gap means the stage was idle, not slow.
    if (interval > 100) return;
    this.intervals[this.intervalCount] = interval;
    this.intervalCount += 1;
    if (this.intervalCount < this.intervals.length) return;
    this.intervalCount = 0;
    if (now < this.governorQuietUntil) return;
    this.sortedIntervals.set(this.intervals);
    this.sortedIntervals.sort();
    const median = this.sortedIntervals[this.sortedIntervals.length >> 1];
    const ratio = this.renderer.getPixelRatio();
    if (median > SLOW_FRAME_MS && ratio > this.profile.minPixelRatio) {
      this.ratioCap = Math.max(this.profile.minPixelRatio, ratio - 0.25);
      this.governorQuietUntil = now + 2000;
      this.resize();
    }
  }

  private applyView() {
    const v = this.view;
    this.applyCamera();

    // Understanding layers
    const g = this.globals;
    g.uPhoto.value = this.photoReady ? v.photo : 0;
    g.uDepthMix.value = v.depth;
    g.uDepthFront.value = v.depthFront;
    g.uClay.value = v.clay;
    g.uAO.value = v.occlusion * (1 - smoothstep(0, 0.25, v.explode));
    g.uDimArch.value = v.dimArchitecture;
    g.uDimObj.value = v.dimObjects;
    for (const group of revealGroups) this.reveal[group].uReveal.value = v.reveal[group];
    this.edgeMaterial.opacity = v.edges * 0.55;
    this.capMaterial.visible = v.cutaway > 0.01 || v.explode > 0.01;

    // Redesign sweep
    const sweepFrom = this.roomMin.x - 0.5;
    const sweepTo = this.roomMax.x + 0.5;
    const hasVariant = Boolean(this.options.variant);
    const waveX = hasVariant ? (v.wave <= 0 ? -100 : v.wave >= 1 ? 100 : lerp(sweepFrom, sweepTo, v.wave)) : -100;
    g.uWave.value = waveX;
    g.uWaveLine.value = v.waveLine;

    this.applyStructure();
    this.applyObjects();
    this.applyLighting(waveX);
    this.applyAnnotations();

    // The ceiling, ghosted, while the structure is pulled apart.
    const ghost = this.before?.ceilingGhost;
    if (ghost) {
      const k = smoothstep(0.05, 0.5, v.explode);
      ghost.group.visible = k > 0.01;
      ghost.fill.opacity = k * 0.4;
      ghost.line.opacity = k * 0.5;
    }

    // Sky behind the windows exists only while the room is a photograph:
    // not in the model views, the exploded view or the cutaway, and not
    // once the camera has risen above the ceiling, from where the planes
    // would be seen floating outside the walls. It returns with the glass
    // when materials are identified.
    const inside =
      (1 - smoothstep(this.roomMax.y, this.roomMax.y + 0.6, v.camera.py)) *
      (1 - smoothstep(0.15, 0.45, v.cutaway)) *
      (1 - smoothstep(0.02, 0.2, v.explode)) *
      (1 - v.clay * (1 - v.reveal.glass));
    this.before?.backdrops.forEach((b) => {
      const m = b.material as MeshBasicMaterial;
      m.opacity = inside;
      b.visible = inside > 0.01;
    });
    if (this.ground) (this.ground.material as ShadowMaterial).opacity = 0.16 * smoothstep(0.3, 0.8, v.cutaway);
  }

  private applyCamera() {
    const v = this.view;
    const t = clamp(v.frame);
    const { w: W, h: H } = this.size;
    const f = this.frameRect;
    // Interpolate the visible rectangle between the hero frame and full bleed.
    const rect = {
      x: lerp(0, f.x, t),
      y: lerp(0, f.y, t),
      w: lerp(W, f.w, t),
      h: lerp(H, f.h, t),
    };
    const aspect = rect.w / rect.h;
    this.camera.position.set(v.camera.px, v.camera.py, v.camera.pz);
    this.camera.lookAt(v.camera.tx, v.camera.ty, v.camera.tz);
    this.camera.aspect = aspect;
    this.camera.fov = effectiveFov(v.camera.fov, aspect);
    // The photograph is composed inside `rect`; the canvas shows everything
    // around it, and the viewport is clipped to the rectangle.
    this.camera.setViewOffset(rect.w, rect.h, -rect.x, -rect.y, W, H);
    this.camera.updateProjectionMatrix();

    const clip =
      t > 0.001
        ? `inset(${rect.y.toFixed(2)}px ${(W - rect.x - rect.w).toFixed(2)}px ${(H - rect.y - rect.h).toFixed(2)}px ${rect.x.toFixed(2)}px)`
        : "none";
    if (this.options.viewport.style.clipPath !== clip) this.options.viewport.style.clipPath = clip;
  }

  private applyStructure() {
    const e = this.view.explode;
    const wallOut = 0.85 * e;
    for (const build of [this.before, this.after]) {
      if (!build) continue;
      build.ceiling.position.y = 1.05 * e;
      for (const wall of build.walls) {
        const base = wall.group.userData.base ?? (wall.group.userData.base = wall.group.position.clone());
        wall.group.position.copy(base).addScaledVector(wall.inward, -wallOut);
      }
      for (const opening of build.openings) {
        const base = opening.group.userData.base ?? (opening.group.userData.base = opening.group.position.clone());
        // Openings pull away from their wall towards the room.
        opening.group.position.copy(base).addScaledVector(opening.inward, -wallOut + 1.2 * e);
      }
    }
  }

  private applyObjects() {
    const v = this.view;
    const ops = this.options.operations ?? [];
    const move = findOperation(ops, "move");
    const replace = findOperation(ops, "replace");
    const restyle = findOperation(ops, "restyle");
    const arrange = smoothstep(0, 1, v.arrange);

    for (const r of this.orderedBefore) {
      const id = r.source.id;
      const p = this.tmp.copy(r.rest);
      let rotation = r.restRotation;
      const carried = r.carried.set(0, 0, 0);

      if (move && id === move.objectId) {
        const k = smoothstep(0, 1, v.editMove);
        const to = this.tmp2.set(...move.to);
        carried.addScaledVector(to.sub(r.rest), k);
        rotation = lerp(rotation, move.rotationY, k);
      }
      if (r.parent) carried.add(r.parent.carried);
      const lift = r.liftAmount * v.separate;
      carried.addScaledVector(r.parent ? UP : r.liftDirection, lift);
      p.add(carried);

      if (r.arrangeTo && arrange > 0) {
        const settled = this.tmp2.copy(r.rest).add(carried);
        p.lerpVectors(settled, r.arrangeTo.position, arrange);
        rotation = lerpAngle(rotation, r.arrangeTo.rotation, arrange);
      }
      r.group.position.copy(p);
      r.group.rotation.y = rotation;

      // Replacement: the old piece sinks away, the new one is built up.
      if (replace) {
        const k = v.editReplace;
        if (id === replace.objectId) r.uniforms.uClipY.value = lerp(r.height + 0.12, -0.02, range(0, 0.5, k));
        if (id === replace.replacement.id) r.uniforms.uClipY.value = lerp(-0.02, r.height + 0.12, range(0.5, 1, k));
      }

      if (r.bracketMaterial) {
        const hovered = this.hovered === id;
        // Selection reads an object out of the room on its own. Hovering
        // only does so where the driver has asked for it, so the story can
        // keep its brackets off until the room becomes something to touch.
        const focus = Math.max(this.selected === id ? 1 : 0, hovered ? v.hover * 0.55 : 0);
        let emphasis = 0;
        if (move && id === move.objectId) emphasis = bell(v.editMove);
        if (replace && (id === replace.objectId || id === replace.replacement.id)) emphasis = bell(v.editReplace);
        if (restyle && id === restyle.objectId) emphasis = bell(v.editMaterial);
        const visible = replace && id === replace.replacement.id ? range(0.4, 0.6, v.editReplace) : 1;
        const hiddenOld = replace && id === replace.objectId ? 1 - range(0.4, 0.6, v.editReplace) : 1;
        r.bracketMaterial.opacity = Math.max(
          v.boxes * (hovered ? 1 : 0.62) * visible * hiddenOld,
          emphasis * 0.95,
          focus,
        );
        r.bracketMaterial.color.copy(
          hovered || focus > 0 || emphasis > 0.02 ? this.globals.uAccent.value : INK,
        );
        r.bracket!.visible = r.bracketMaterial.opacity > 0.005;
      }
      if (r.blob && r.blobMaterial) {
        r.blob.position.set(p.x, 0.004, p.z);
        r.blob.rotation.y = rotation;
        const shown =
          replace && id === replace.objectId
            ? 1 - range(0, 0.5, v.editReplace)
            : replace && id === replace.replacement.id
              ? range(0.5, 1, v.editReplace)
              : 1;
        r.blobMaterial.opacity = 0.34 * (1 - smoothstep(0, 0.6, v.separate)) * shown;
      }
    }

    if (restyle) {
      const runtime = this.objects.get(restyle.objectId);
      const k = smoothstep(0, 1, v.editMaterial);
      runtime?.materials.forEach((material) => {
        if (material.userData.slot !== restyle.slot) return;
        if (!material.userData.restyleFrom) material.userData.restyleFrom = material.color.clone();
        this.restyleFrom.copy(material.userData.restyleFrom);
        this.restyleTo.set(restyle.to.color);
        material.color.copy(this.restyleFrom).lerp(this.restyleTo, k);
      });
    }

    for (const r of this.afterObjects.values()) {
      if (r.blob && r.blobMaterial) {
        r.blob.position.set(r.group.position.x, 0.004, r.group.position.z);
        r.blob.rotation.y = r.group.rotation.y;
        r.blobMaterial.opacity = 0.34;
      }
    }

    this.applyRing();
  }

  /**
   * The rotation ring sits on whatever carries the selected piece, just
   * clear of its footprint. It is the only handle the workspace shows:
   * inside it the piece is dragged, on it the piece is turned.
   */
  private applyRing() {
    const runtime = this.selected ? this.objects.get(this.selected) : undefined;
    const shows = runtime !== undefined && turnsOnFloor(runtime.source);
    if (!shows) {
      if (this.ring) this.ring.visible = false;
      return;
    }
    if (!this.ring) {
      this.ring = rotationRing(this.ringMaterial);
      this.three.add(this.ring);
    }
    const radius = ringRadius(runtime.source);
    this.ring.visible = true;
    this.ring.position.set(
      runtime.group.position.x,
      runtime.group.position.y + 0.006,
      runtime.group.position.z,
    );
    this.ring.rotation.y = runtime.group.rotation.y;
    this.ring.scale.setScalar(radius);
    this.ringMaterial.opacity = 0.85;
    this.ringMaterial.color.copy(this.globals.uAccent.value);
  }

  private applyLighting(waveX: number) {
    if (!this.rig) return;
    const s = this.rig.update(this.view.time);
    this.renderer.toneMappingExposure = s.exposure;
    this.three.environmentIntensity = s.environment;
    // In the depth view the sky is simply "far".
    this.before?.backdrops.forEach((b) => {
      (b.material as MeshBasicMaterial).color
        .copy(s.exterior)
        .multiplyScalar(s.exteriorIntensity)
        .lerp(DEPTH_FAR, this.view.depth);
    });

    for (const lamp of this.lamps) {
      const { fixture } = lamp;
      const x = fixture.group.position.x;
      const presence =
        fixture.variant === Variant.after
          ? smoothstep(x - 0.3, x + 0.3, waveX)
          : fixture.variant === Variant.before
            ? 1 - smoothstep(x - 0.3, x + 0.3, waveX)
            : 1;
      // A fixture follows the daylight until somebody reaches for the switch.
      const src = lamp.source;
      const base = src.on === undefined ? s.lamps : src.on ? 1 : 0;
      const level = base * (src.intensity ?? 1) * presence;
      lamp.light.position
        .copy(lamp.offset)
        .applyAxisAngle(UP, fixture.group.rotation.y)
        .add(fixture.group.position);
      lamp.light.intensity = lamp.power * level;
      fixture.materials.forEach((m) => {
        if (m.userData.emissive) m.emissiveIntensity = level * 1.15;
      });
    }
  }

  private applyAnnotations() {
    const v = this.view;
    const scene = this.current;

    // Relationships between entities, as dashed hairlines.
    if (this.relations) {
      this.relationMaterial.opacity = v.relations * 0.7;
      this.relations.lines.visible = v.relations > 0.005;
      if (this.relations.lines.visible) {
        scene.relationships.forEach((rel, i) => {
          const a = this.entityPoint(rel.subjectId, this.tmp3);
          const b = this.entityPoint(rel.objectId, this.tmp4, a);
          this.relations!.set(i, a, b);
        });
        this.relations.commit();
      }
    }

    // Sun rays through each window, down to the floor.
    if (this.rays && this.rig) {
      const s = this.rig.sample;
      const sunUp = s.sunDirection.y > 0.02 && s.sunIntensity > 0.05;
      this.rayMaterial.opacity = v.rays * 0.6 * (sunUp ? 1 : 0);
      this.rays.lines.visible = this.rayMaterial.opacity > 0.005;
      if (this.rays.lines.visible) {
        const windows = (this.before?.openings ?? []).filter((o) => o.kind === "window");
        const down = this.tmp.copy(s.sunDirection).negate();
        windows.forEach((w, i) => {
          for (let j = 0; j < 2; j += 1) {
            const start = this.tmp3.copy(w.center);
            start.y += (j === 0 ? -0.35 : 0.35) * w.height;
            const t = start.y / Math.max(0.05, -down.y);
            const end = this.tmp4.copy(start).addScaledVector(down, Math.min(t, 8));
            this.rays!.set(i * 2 + j, start, end);
          }
        });
        this.rays.commit();
      }
    }

    this.dimensionMaterial.opacity = v.dimensions * 0.8;
    this.dimensionLines.forEach((l) => (l.visible = v.dimensions > 0.005));
  }

  /** A representative world point for any entity id in the scene. */
  private entityPoint(id: Id, out: Vector3, towards?: Vector3): Vector3 {
    const object = this.objects.get(id);
    if (object) {
      const c = objectCenter(object.source);
      return out.set(object.group.position.x, object.group.position.y + (c[1] - object.source.transform.position[1]), object.group.position.z);
    }
    const opening = this.before?.openings.find((o) => o.id === id);
    if (opening) return out.copy(opening.center);
    const wall = this.before?.walls.find((w) => w.id === id);
    if (wall && towards) {
      // Closest point on the wall's plane to the other end.
      const base = wall.group.userData.base as Vector3 | undefined;
      const origin = base ?? wall.group.position;
      const offset = this.tmp2.copy(towards).sub(origin).dot(wall.inward);
      return out.copy(towards).addScaledVector(wall.inward, -offset);
    }
    const light = this.current.lights.find((l) => l.id === id);
    if (light?.kind === "daylight") {
      const first = this.before?.openings.find((o) => o.id === light.openingIds[0]);
      if (first) return out.copy(first.center);
    }
    return out.copy(this.roomCenter);
  }

  // -------------------------------------------------------------------------
  // DOM anchors

  private resolveAnchor(key: string, out: Vector3): boolean {
    const [kind, id] = key.split(":");
    switch (kind) {
      case "object": {
        const r = this.objects.get(id);
        if (!r) return false;
        out.copy(r.group.position);
        out.y += r.source.support.kind === "ceiling" ? -0.06 : r.height + 0.08;
        if (r.source.support.kind === "wall") out.y = r.group.position.y + r.height + 0.06;
        return true;
      }
      case "opening": {
        const o = this.before?.openings.find((x) => x.id === id);
        if (!o) return false;
        const base = o.group.userData.base as Vector3 | undefined;
        out.copy(o.center);
        if (base) out.add(this.tmp2.copy(o.group.position).sub(base));
        out.y += o.height / 2 + 0.1;
        return true;
      }
      case "surface": {
        if (id === "floor") {
          out.set(this.roomCenter.x + 1.2, 0, this.roomMax.z - 0.9);
          return true;
        }
        if (id === "ceiling") {
          out.set(this.roomCenter.x + 1.4, this.roomMax.y + (this.before?.ceiling.position.y ?? 0), this.roomCenter.z);
          return true;
        }
        const wall = this.before?.walls.find((w) => w.id === id);
        if (!wall) return false;
        const surface = this.current.surfaces.find((s) => s.id === id);
        if (surface?.kind !== "wall") return false;
        // Mid-height, below the openings' labels, and off-centre so a wall's
        // label does not sit on the same vertical as a centred opening.
        const along = 0.3;
        out.set(
          surface.start[0] + (surface.end[0] - surface.start[0]) * along,
          this.roomMax.y * 0.42,
          surface.start[1] + (surface.end[1] - surface.start[1]) * along,
        );
        const base = wall.group.userData.base as Vector3 | undefined;
        if (base) out.add(this.tmp2.copy(wall.group.position).sub(base));
        return true;
      }
      case "light": {
        const light = this.current.lights.find((l) => l.id === id);
        if (!light) return false;
        if (light.kind === "artificial") {
          const lamp = this.lamps.find((l) => l.fixture.source.id === light.fixtureId && l.fixture.variant !== Variant.after);
          if (!lamp) return false;
          out.copy(lamp.light.position);
          return true;
        }
        if (light.kind === "daylight") {
          const o = this.before?.openings.find((x) => x.id === light.openingIds[0]);
          if (!o) return false;
          out.copy(o.center);
          return true;
        }
        return false;
      }
      case "material": {
        const group = this.reveal[id as RevealGroup];
        if (!group) return false;
        out.copy(group.uRevealSeed.value);
        return true;
      }
      case "relation": {
        const rel = this.current.relationships.find((r) => r.id === id);
        if (!rel) return false;
        const a = this.entityPoint(rel.subjectId, this.tmp3);
        const b = this.entityPoint(rel.objectId, this.tmp4, a);
        out.addVectors(a, b).multiplyScalar(0.5);
        return true;
      }
      case "dimension": {
        const index = ["width", "depth", "height"].indexOf(id);
        const line = this.dimensionLines[index];
        if (!line) return false;
        const pos = line.geometry.getAttribute("position");
        // Segment 3 is the dimension line itself.
        out.set((pos.getX(4) + pos.getX(5)) / 2, (pos.getY(4) + pos.getY(5)) / 2, (pos.getZ(4) + pos.getZ(5)) / 2);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Pin each label to its point in the scene, then lengthen leaders so that
   * tags which would sit on top of one another stack instead.
   *
   * Tags are placed in a fixed order — substantial pieces before small ones,
   * and otherwise as written in the markup — rather than in screen order, so
   * that the arrangement is a pure function of the camera. Sorting by position
   * would let two labels swap places mid-scroll and visibly jump.
   */
  private projectAnchors() {
    const { w, h } = this.size;
    const p = this.tmp;
    if (!this.tagsMeasured) this.measureTags();

    this.placed.length = 0;
    for (const anchor of this.anchors) {
      const layer = anchor.layer;
      if (layer && (layer.style.visibility === "hidden" || layer.style.opacity === "0")) continue;
      if (!this.resolveAnchor(anchor.key, p)) continue;
      p.project(this.camera);
      const visible = p.z < 1 && p.z > -1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2;
      const x = Math.round(((p.x + 1) / 2) * w * 10) / 10;
      const y = Math.round(((1 - p.y) / 2) * h * 10) / 10;
      const written = anchor.written;
      if (written.x !== x || written.y !== y) {
        written.x = x;
        written.y = y;
        anchor.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }

      // The frustum test above keeps a little slack past each edge so that a
      // pin crossing the boundary does not pop. A tag, though, hangs off its
      // pin: one of its vertical borders sits on the pin's own x, so a pin
      // outside the frame can only put its label across the edge, however it
      // is placed. Narrow viewports see less of the room sideways, which puts
      // more pins out of shot. Label nothing the viewer cannot see.
      const pinInFrame = x >= EDGE_MARGIN && x <= w - EDGE_MARGIN && y >= 0 && y <= h;
      let hidden = !visible;
      if (visible && anchor.tag && anchor.tagHeight > 0) {
        hidden = !pinInFrame || !this.placeTag(anchor, x, y);
      }
      const state = hidden ? "hidden" : "";
      if (anchor.element.style.visibility !== state) anchor.element.style.visibility = state;
    }
  }

  /**
   * How long a leader must be for a tag at `edge` to clear everything already
   * placed this frame. Each raise can uncover a further neighbour, so the
   * sweep repeats until a pass moves nothing, and gives up past the maximum.
   */
  private leadToClear(edge: number, tw: number, th: number, y: number): number {
    let lead = LEAD_REST;
    for (let guard = 0; guard < 8; guard += 1) {
      const bottom = y - lead - 4;
      let pushed = false;
      for (const other of this.placed) {
        const o = other.box;
        if (edge >= o.x1 || edge + tw <= o.x0) continue;
        if (bottom <= o.y0 || bottom - th >= o.y1) continue;
        // Overlapping: clear this neighbour's top edge.
        lead += o.y1 - (bottom - th) + LEAD_GAP;
        pushed = true;
        break;
      }
      if (!pushed) break;
      if (lead > LEAD_MAX) break;
    }
    return lead;
  }

  /**
   * Place one tag: pick the side of the pin it hangs from and how far up its
   * leader it sits. Tags only ever move along their leader or across their
   * own pin, so a label never drifts from the thing it names. Returns false
   * when a minor label cannot be fitted and should step aside.
   */
  private placeTag(anchor: Anchor, x: number, y: number): boolean {
    const { tagWidth: tw, tagHeight: th, box } = anchor;

    // A tag can hang from either side of its pin. Both sides are costed and
    // the cheaper one wins, so a label only moves as far as it has to — and
    // a tag crowded on one side can step over the pin instead of climbing.
    const right = x - 0.5;
    const left = x + 0.5 - tw;
    const fits = (edge: number) => edge >= EDGE_MARGIN && edge + tw <= this.size.w - EDGE_MARGIN;
    const candidates: { edge: number; flip: boolean }[] = [];
    if (fits(right)) candidates.push({ edge: right, flip: false });
    if (fits(left)) candidates.push({ edge: left, flip: true });
    // Neither side fits: the tag is wider than the space beside its pin. Take
    // whichever side crosses the edge by less — clipping a little beats
    // dropping a label whose subject is plainly in shot.
    if (candidates.length === 0) {
      const spill = (edge: number) =>
        Math.max(0, EDGE_MARGIN - edge) + Math.max(0, edge + tw - (this.size.w - EDGE_MARGIN));
      const useLeft = spill(left) < spill(right);
      candidates.push({ edge: useLeft ? left : right, flip: useLeft });
    }

    let best = { edge: right, flip: false, lead: Infinity };
    for (const candidate of candidates) {
      const lead = this.leadToClear(candidate.edge, tw, th, y);
      if (lead < best.lead) best = { ...candidate, lead };
      if (best.lead <= LEAD_REST) break;
    }

    // A minor label that cannot find room steps aside; a substantial one is
    // kept at full stretch, since dropping it would understate the scene.
    let lead = best.lead;
    if (lead > LEAD_MAX) {
      if (anchor.minor) return false;
      lead = LEAD_MAX;
    }
    // A tag that would hang above the top of the stage, or under the page's
    // navigation there, cannot be read, and its pin alone says nothing.
    if (y - lead - 4 - th < TOP_CLEARANCE) return false;

    const written = anchor.written;
    if (written.flip !== best.flip) {
      written.flip = best.flip;
      if (best.flip) anchor.element.setAttribute("data-flip", "");
      else anchor.element.removeAttribute("data-flip");
    }

    box.x0 = best.edge;
    box.x1 = best.edge + tw;
    box.y1 = y - lead - 4;
    box.y0 = box.y1 - th;
    const rounded = Math.round(lead);
    if (written.lead !== rounded) {
      written.lead = rounded;
      anchor.element.style.setProperty("--lead", `${rounded}px`);
      // A tag raised past a neighbour draws its leader across that neighbour.
      // Ordering by leader length puts the longer leaders behind, where the
      // tags' own backgrounds cover them, so the crossing never shows. Tags
      // themselves no longer overlap, so nothing is hidden by this.
      anchor.element.style.zIndex = String(LEAD_MAX - rounded);
    }
    this.placed.push(anchor);
    return true;
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.ready = false;
    this.options.onError?.(new Error("The 3D context was lost."));
  };
}

/** The object group an intersected mesh belongs to, if any. */
function objectIdOf(hit: Object3D): Id | null {
  for (let node: Object3D | null = hit; node; node = node.parent) {
    if (node.name.startsWith("object:")) return node.name.slice(7);
  }
  return null;
}

/**
 * Whether a changed object needs new geometry rather than a new transform.
 * Position, rotation, scale and materials are all applied to the existing
 * build; what the object *is* is baked into it.
 */
function rebuildNeeded(a: SceneObject, b: SceneObject) {
  return (
    a.category !== b.category ||
    a.form !== b.form ||
    a.dimensions[0] !== b.dimensions[0] ||
    a.dimensions[1] !== b.dimensions[1] ||
    a.dimensions[2] !== b.dimensions[2] ||
    Object.keys(a.materials).length !== Object.keys(b.materials).length
  );
}

const INK = new Color("#191816");

/** A typical frame slower than this means the device needs fewer pixels. */
const SLOW_FRAME_MS = 22;
/** Most depth texels recorded for the photograph, and the largest edge. */
const PHOTO_DEPTH_BUDGET = 6.5e6;
const MAX_TEXTURE_EDGE = 4096;
/** Scratch for `shadowsChanged`, so the check allocates nothing. */
const SHADOW_VALUES = new Float64Array(9);
const DEPTH_FAR = new Color("#5e5953");

function materialsOf(op: SceneOperation): SceneMaterial[] {
  return op.kind === "restyle" || op.kind === "resurface" ? [op.to] : [];
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Keep horizontal coverage sensible on portrait screens without letting
 * the vertical field of view distort.
 */
export function effectiveFov(fov: number, aspect: number) {
  if (aspect >= 1) return fov;
  const widened = 2 * Math.atan(Math.tan(degToRad(fov) / 2) * Math.pow(1 / aspect, 0.6));
  return Math.min((widened * 180) / Math.PI, 80);
}
