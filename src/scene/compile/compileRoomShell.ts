import type {
  CaptureCamera,
  Id,
  PlaneSurface,
  Scene,
  Surface,
  Vec2,
  Vec3,
  WallSurface,
} from "@/scene/model/types";
import { solveScale, type CalibrationReference } from "./calibration";
import type { CompileReport, CompileResult, EntityEvidence, SceneEvidence, Side } from "./evidence";
import { DEG, directionToCapture, cameraPose, length, round, scale, yawRotate } from "./frame";
import type { Basis, PlaneObservation, Problem, Quantity, ReconstructionIntermediate } from "./intermediate";
import { compileLights } from "./lighting";
import { MaterialBook } from "./materials";
import { compileObjects, type ShellFrame } from "./objects";
import { PRIORS, UNESTIMATED_MATERIALS } from "./priors";
import { deriveRelationships, RELATION_RULES } from "./relationships";

export const COMPILER_VERSION = "room-shell-0.2.0";

export interface CompileOptions {
  calibration?: readonly CalibrationReference[];
  /** Compile the objects and openings the worker observed. Defaults to true. */
  objects?: boolean;
}

/**
 * SceneCompiler, room shell
 * =========================
 * Turns what the worker observed into the existing Scene, deterministically:
 * the same intermediate and calibration always give the same Scene, byte for
 * byte. Nothing here reads a clock or a random number, and every output
 * length is rounded to the millimetre so float noise cannot show.
 *
 * What it decides, and how:
 * - Frame. Yaw about +Y so the walls run along X and Z, choosing the turn of
 *   at most 45° so the camera still looks towards −Z (the side the renderer
 *   leaves open). Then the scale factor from calibration, then centre the
 *   room's footprint on the origin, as the demo room is.
 * - Floor. The fitted floor is y = 0. Without one there is no room to
 *   compile, and the compile fails with `no-floor`.
 * - Walls. Each observed wall bounds the side its normal faces from; where
 *   several were seen on one side, the largest does, since the farthest may
 *   be a view through a window or a doorway. A side
 *   no wall was seen on is closed at the smallest extent the evidence
 *   allows: every seen floor point and wall end inside, and the camera a
 *   stated clearance inside. Such walls are `inferred`, and the one behind
 *   the camera is left out of the surfaces while the footprint stays closed.
 * - Height. From the ceiling where it was seen; otherwise the highest wall
 *   top seen, or the stated default when that is lower.
 * - Camera. Position, look direction and field of view from the capture
 *   camera. Roll cannot be represented and is reported instead.
 *
 * What it never does: add anything that was not observed, turn a default
 * into an estimate, or reach for the demonstration room.
 */
export function compileRoomShell(input: ReconstructionIntermediate, options: CompileOptions = {}): CompileResult {
  const view = input.views[0];
  const planes = input.world.planes;
  const floor = planes.find((p) => p.role === "floor");
  if (!floor) {
    return {
      ok: false,
      problem: problem("no-floor", "The floor isn't visible enough to rebuild the room.", "error"),
    };
  }

  const problems: Problem[] = [...input.diagnostics.warnings];
  const solution = solveScale(input, options.calibration ?? []);
  const s = solution.factor;
  const sizeBasis: Basis = solution.basis;
  for (const r of solution.rejected) {
    problems.push(problem("calibration-reference-rejected", r.reason, "warning", { label: r.reference.label ?? r.reference.kind }));
  }
  if (solution.accepted.some((a) => Math.abs(a.residual) > 0.05)) {
    problems.push(
      problem("calibration-references-disagree", "The measurements disagree with each other by more than 5%.", "warning", {
        residuals: solution.accepted.map((a) => round(a.residual, 0.0001)),
      }),
    );
  }

  // Frame --------------------------------------------------------------------
  const walls = planes.filter((p) => p.role === "wall");
  const yawDeg = manhattanYaw(walls) ?? input.world.manhattan?.yawDeg ?? 0;
  const place = (p: Vec3): Vec3 => scale(yawRotate(p, yawDeg), s);
  const cameraHeight = input.world.cameraHeight.value;
  const camera = place([0, cameraHeight, 0]);

  const used: { id: string; role: string; as: string }[] = [{ id: floor.id, role: floor.role, as: "floor" }];
  const ignored: { id: string; role: string; reason: string }[] = [];

  // Observed walls, by the side of the room they bound ----------------------
  const bySide: Record<Side, { plane: PlaneObservation; position: number }[]> = { left: [], far: [], right: [], behind: [] };
  for (const wall of walls) {
    const n = yawRotate(wall.normal, yawDeg);
    const alongX = Math.abs(n[0]) >= Math.abs(n[2]);
    const deviation = Math.acos(Math.min(1, Math.abs(alongX ? n[0] : n[2]))) * DEG;
    if (deviation > PRIORS.axisSnapDeg) {
      ignored.push({ id: wall.id, role: wall.role, reason: `not within ${PRIORS.axisSnapDeg}° of the room's axes (${round(deviation, 0.1)}°)` });
      problems.push(problem("wall-not-axis-aligned", `${wall.id} does not fit a rectangular room and was not used.`, "warning", { deviationDeg: round(deviation, 0.01) }));
      continue;
    }
    const side: Side = alongX ? (n[0] > 0 ? "left" : "right") : n[2] > 0 ? "far" : "behind";
    const c = place(wall.centroid);
    bySide[side].push({ plane: wall, position: alongX ? c[0] : c[2] });
  }
  // One wall bounds each side: the largest seen there. Not the farthest, which
  // through a window or a doorway is outside the room.
  const dominant = (side: Side) => {
    const list = bySide[side];
    if (!list.length) return null;
    const chosen = list.reduce((a, b) => (b.plane.visibleArea > a.plane.visibleArea ? b : a));
    for (const w of list) {
      if (w === chosen) continue;
      ignored.push({ id: w.plane.id, role: w.plane.role, reason: `smaller than the ${side} wall (${chosen.plane.id}) on the same side: a recess, a furniture face or a view through an opening` });
    }
    used.push({ id: chosen.plane.id, role: chosen.plane.role, as: `wall-${side}` });
    return chosen;
  };
  const observed: Record<Side, { plane: PlaneObservation; position: number } | null> = {
    left: dominant("left"),
    far: dominant("far"),
    right: dominant("right"),
    behind: dominant("behind"),
  };

  // Evidence that lies inside the room ---------------------------------------
  const inside: Vec3[] = (input.world.floorOutline?.points ?? []).map(([x, z]) => place([x, 0, z]));
  for (const wall of walls) {
    const u = wall.visibleExtent.axes.u;
    const foot = scale(wall.normal, -wall.offset);
    for (const along of [wall.visibleExtent.min[0], wall.visibleExtent.max[0]]) {
      inside.push(place([foot[0] + u[0] * along, 0, foot[2] + u[2] * along]));
    }
  }
  const xs = inside.map((p) => p[0]);
  const zs = inside.map((p) => p[2]);

  type Bound = { position: number; status: "observed" | "inferred" | "omitted"; basis: Basis; planeId: string | null; note: string };
  const bound = (side: Side): Bound => {
    const o = observed[side];
    const low = side === "left" || side === "far";
    const evidence = side === "left" || side === "right" ? xs : zs;
    const cam = side === "left" || side === "right" ? camera[0] : camera[2];
    const clearance = side === "behind" ? PRIORS.clearanceBehindCamera : PRIORS.clearanceBesideCamera;
    if (o) {
      const beyond = low ? o.position - Math.min(...evidence) : Math.max(...evidence) - o.position;
      if (beyond > PRIORS.evidenceBeyondWallTolerance) {
        problems.push(problem("evidence-beyond-wall", `Surfaces were seen up to ${round(beyond, 0.01)} m beyond the ${side} wall, as through a doorway or a mirror.`, "warning", { side, metres: round(beyond, 0.001) }));
      }
      return { position: o.position, status: "observed", basis: sizeBasis, planeId: o.plane.id, note: `Seen: ${o.plane.id}, ${round(o.plane.visibleArea * s * s, 0.01)} m² visible.` };
    }
    const fromEvidence = evidence.length ? (low ? Math.min(...evidence) : Math.max(...evidence)) : cam;
    const fromCamera = low ? cam - clearance : cam + clearance;
    const evidenceWins = low ? fromEvidence <= fromCamera : fromEvidence >= fromCamera;
    return {
      position: evidenceWins ? fromEvidence : fromCamera,
      status: side === "behind" ? "omitted" : "inferred",
      basis: evidenceWins ? "inferred" : "default",
      planeId: null,
      note: evidenceWins
        ? `Not seen. Placed at the farthest floor or wall point seen on that side, so the room is at least this large.`
        : `Not seen. Placed ${clearance} m beyond the camera, a stated default.`,
    };
  };
  const bounds: Record<Side, Bound> = { left: bound("left"), far: bound("far"), right: bound("right"), behind: bound("behind") };
  const [xMin, xMax, zMin, zMax] = [bounds.left.position, bounds.right.position, bounds.far.position, bounds.behind.position];
  if (!(xMax - xMin > 0.5 && zMax - zMin > 0.5)) {
    return { ok: false, problem: problem("degenerate-room", "The fitted room is too small to be a room.", "error") };
  }

  // Height ---------------------------------------------------------------------
  const ceiling = planes.find((p) => p.role === "ceiling");
  let height: number;
  let heightBasis: Basis;
  let heightNote: string;
  if (ceiling) {
    used.push({ id: ceiling.id, role: ceiling.role, as: "ceiling" });
    height = ceiling.centroid[1] * s;
    heightBasis = sizeBasis;
    heightNote = `From the ceiling seen (${ceiling.id}), at the centre of its visible part.`;
  } else {
    const wallTop = Math.max(cameraHeight + 0.1, ...walls.map((w) => w.heightRange[1])) * s;
    if (wallTop >= PRIORS.defaultCeilingHeight) {
      height = wallTop;
      heightBasis = "inferred";
      heightNote = "The ceiling was not seen. The room is at least as tall as the highest wall seen.";
    } else {
      height = PRIORS.defaultCeilingHeight;
      heightBasis = "default";
      heightNote = `The ceiling was not seen. ${PRIORS.defaultCeilingHeight} m is a stated default, above every wall top seen.`;
    }
    problems.push(problem("ceiling-not-seen", heightNote, "warning"));
  }
  if (!(height > camera[1])) {
    return { ok: false, problem: problem("ceiling-below-camera", "The fitted ceiling is below the camera.", "error") };
  }

  // Centre the footprint on the origin -----------------------------------------
  const cx = (xMin + xMax) / 2;
  const cz = (zMin + zMax) / 2;
  const X = (x: number) => round(x - cx);
  const Z = (z: number) => round(z - cz);
  const corner = (x: number, z: number): Vec2 => [X(x), Z(z)];
  const footprint: Vec2[] = [corner(xMin, zMin), corner(xMax, zMin), corner(xMax, zMax), corner(xMin, zMax)];

  // Surfaces ---------------------------------------------------------------------
  const wallSurface = (side: Side, id: Id, label: string, start: Vec2, end: Vec2): WallSurface => ({
    id,
    kind: "wall",
    label,
    materialId: "unestimated-wall",
    evidence: bounds[side].status === "observed" ? "observed" : "inferred",
    start,
    end,
    thickness: PRIORS.wallThickness,
  });
  const floorSurface: PlaneSurface = { id: "floor", kind: "floor", label: "Floor", materialId: "unestimated-floor", evidence: "observed" };
  const ceilingSurface: PlaneSurface = {
    id: "ceiling",
    kind: "ceiling",
    label: "Ceiling",
    materialId: "unestimated-ceiling",
    evidence: ceiling ? "observed" : "inferred",
  };
  const surfaces: Surface[] = [
    floorSurface,
    ceilingSurface,
    wallSurface("far", "wall-far", "Far wall", corner(xMin, zMin), corner(xMax, zMin)),
    wallSurface("left", "wall-left", "Left wall", corner(xMin, zMax), corner(xMin, zMin)),
    wallSurface("right", "wall-right", "Right wall", corner(xMax, zMin), corner(xMax, zMax)),
  ];
  if (bounds.behind.status === "observed") {
    surfaces.push(wallSurface("behind", "wall-behind", "Wall behind the camera", corner(xMax, zMax), corner(xMin, zMax)));
  }

  // Camera -----------------------------------------------------------------------
  const pose = cameraPose(view);
  const f = yawRotate(directionToCapture(pose, [0, 0, 1]), yawDeg);
  const forward = scale(f, 1 / length(f));
  const target = orbitTarget(camera, forward, [xMin, xMax, zMin, zMax, height]);
  const { fy } = view.camera.intrinsics;
  const captureCamera: CaptureCamera = {
    position: [X(camera[0]), round(camera[1]), Z(camera[2])],
    target: [X(target[0]), round(target[1]), Z(target[2])],
    verticalFov: round(2 * Math.atan(input.source.height / 2 / fy.value) * DEG, 0.01),
    aspect: round(input.source.width / input.source.height, 0.0001),
  };
  const roll = view.camera.roll.value;
  if (Math.abs(roll) > PRIORS.rollReportDeg) {
    problems.push(problem("camera-roll-dropped", `The camera was rolled ${round(roll, 0.1)}°, which the Scene camera cannot represent.`, "warning", { rollDeg: round(roll, 0.01) }));
  }

  for (const p of planes) {
    if (!used.some((u) => u.id === p.id) && !ignored.some((i) => i.id === p.id)) {
      ignored.push({ id: p.id, role: p.role, reason: p.role.startsWith("other") ? "a surface of something inside the room, not part of the shell" : "not used" });
    }
  }

  // Objects and openings -----------------------------------------------------------
  const models = sources(input);
  const book = new MaterialBook(input, { material: models.material, segmentation: models.segmentation });
  const wallOfPlane: Record<string, Id> = {};
  for (const side of ["left", "far", "right", "behind"] as const) {
    const planeId = bounds[side].planeId;
    if (planeId && surfaces.some((s) => s.id === `wall-${side}`)) wallOfPlane[planeId] = `wall-${side}`;
  }
  const shell: ShellFrame = {
    s,
    sizeBasis,
    yawDeg,
    toScene: (p) => {
      const q = place(p);
      return [q[0] - cx, q[1], q[2] - cz];
    },
    dirToScene: (v) => yawRotate(v, yawDeg),
    bounds: { xMin: xMin - cx, xMax: xMax - cx, zMin: zMin - cz, zMax: zMax - cz, height },
    camera: [camera[0] - cx, camera[1], camera[2] - cz],
    walls: surfaces.filter((x): x is WallSurface => x.kind === "wall"),
    wallOfPlane,
    sources: models,
    book,
  };
  const things = options.objects === false ? null : compileObjects(input, shell);
  problems.push(...(things?.problems ?? []));
  const relationships = things ? deriveRelationships(things.placed) : [];
  const light = compileLights(input, shell, things?.openingInstances ?? [], things?.placed ?? []);
  problems.push(...light.problems);

  // Materials of the room's own surfaces, now that the openings (which the floor may mirror) are known.
  const floorMaterial = book.plane("floor", floor.id, (things?.openingInstances ?? []).map((o) => o.instance)) ?? "unestimated-floor";
  const ceilingMaterial = book.plane("ceiling", ceiling?.id ?? null, []) ?? "unestimated-ceiling";
  const planeOfWall = Object.fromEntries(surfaces.filter((x) => x.kind === "wall").map((x) => [x.id, bounds[x.id.slice(5) as Side]?.planeId ?? null]));
  const wallMaterials = book.walls(surfaces.filter((x): x is WallSurface => x.kind === "wall"), planeOfWall);
  const finished: Surface[] = surfaces.map((x) => ({
    ...x,
    materialId: x.kind === "floor" ? floorMaterial : x.kind === "ceiling" ? ceilingMaterial : (wallMaterials[x.id] ?? "unestimated-wall"),
  }));
  const standIns = UNESTIMATED_MATERIALS.filter((m) => finished.some((x) => x.materialId === m.id));

  // Scene --------------------------------------------------------------------------
  const sceneId = `reconstruction-${input.jobId}`;
  const width = round(xMax - xMin);
  const depth = round(zMax - zMin);
  const scene: Scene = {
    schemaVersion: 1,
    id: sceneId,
    provenance: {
      kind: "reconstruction",
      sourceImageId: input.source.photographId,
      pipelineVersion: input.pipeline.version,
      createdAt: input.createdAt,
    },
    room: { type: "other", label: "Reconstructed room", footprint, height: round(height) },
    camera: captureCamera,
    surfaces: finished,
    openings: things?.openings ?? [],
    objects: things?.objects ?? [],
    materials: [...standIns, ...book.materials()],
    lights: light.lights,
    relationships,
  };

  // Evidence -----------------------------------------------------------------------
  const widthBasis = weakest(bounds.left.basis, bounds.right.basis);
  const depthBasis = weakest(bounds.far.basis, bounds.behind.basis);
  const dimensions = {
    width: q(width, widthBasis, [models.geometry, "rule:room-shell"]),
    depth: q(depth, depthBasis, [models.geometry, "rule:room-shell"]),
    height: q(round(height), heightBasis, ceiling ? [models.geometry, `plane:${ceiling.id}`] : ["priors:" + PRIORS.version]),
  };
  const entities: Record<Id, EntityEvidence> = {
    room: {
      kind: "room",
      presence: { basis: "estimated" },
      fields: { width: dimensions.width, depth: dimensions.depth, height: dimensions.height, type: q("other", "default", ["priors:" + PRIORS.version]) },
      observations: [floor.id],
      notes: [
        sizeBasis === "calibrated"
          ? "Sizes are calibrated to your measurement."
          : "Sizes are estimated from one photograph and are not calibrated. Every length shares one unknown scale error.",
        heightNote,
        "Room type is not estimated in this version.",
      ],
    },
    camera: {
      kind: "camera",
      presence: { basis: "estimated" },
      fields: {
        "position.1": q(round(camera[1]), sizeBasis, [models.geometry, "rule:floor-plane"]),
        verticalFov: { ...view.camera.verticalFov, value: captureCamera.verticalFov },
        roll: { ...view.camera.roll, note: "not representable in the Scene camera; dropped" },
      },
      observations: [view.viewId],
      notes: [`Field of view from ${view.camera.fovSource === "geocalib" ? "GeoCalib" : "MoGe-2"}; the other model's estimate is kept in the intermediate.`],
    },
    floor: surfaceEvidence(floor, s, sizeBasis, "Fitted to the floor seen in the photograph."),
    ceiling: ceiling
      ? surfaceEvidence(ceiling, s, sizeBasis, heightNote)
      : { kind: "surface", presence: { basis: "inferred" }, fields: { height: dimensions.height }, observations: [], notes: [heightNote] },
  };
  for (const side of ["far", "left", "right", "behind"] as const) {
    const b = bounds[side];
    const id = `wall-${side}`;
    if (side === "behind" && b.status === "omitted") continue;
    const plane = b.planeId ? planes.find((p) => p.id === b.planeId) : undefined;
    entities[id] = {
      kind: "surface",
      presence: { basis: b.status === "observed" ? "estimated" : "inferred" },
      fields: { position: q(round(b.position - (side === "left" || side === "right" ? cx : cz)), b.basis, plane ? [models.geometry, `plane:${plane.id}`] : ["rule:closure"]), thickness: q(PRIORS.wallThickness, "default", ["priors:" + PRIORS.version]) },
      observations: plane ? [plane.id] : [],
      notes: [b.note],
    };
  }
  for (const m of standIns) {
    entities[m.id] = { kind: "material", presence: { basis: "default" }, fields: {}, observations: [], notes: ["Material is not estimated in this version; this is a neutral stand-in."] };
  }
  Object.assign(entities, light.entities, book.entities(), things?.entities ?? {});
  for (const r of relationships) {
    entities[r.id] = { kind: "relationship", presence: { basis: "inferred" }, fields: {}, observations: [r.subjectId, r.objectId], notes: [`Derived by rule (${RELATION_RULES.version}) from where the two were placed.`] };
  }

  const evidence: SceneEvidence = {
    schemaVersion: 1,
    sceneId,
    scale: {
      factor: round(s, 0.000001),
      basis: solution.basis,
      logSigma: solution.basis === "estimated" ? view.geometry.scale.logSigma : null,
      references: solution.accepted.map((a) => a.reference),
      residuals: solution.accepted.map((a) => round(a.residual, 0.000001)),
    },
    entities,
  };

  const report: CompileReport = {
    compilerVersion: COMPILER_VERSION,
    priorsVersion: PRIORS.version,
    jobId: input.jobId,
    pipelineVersion: input.pipeline.version,
    frame: { yawDeg: round(yawDeg, 0.01), scale: round(s, 0.000001), translation: [round(-cx), round(-cz)] },
    sides: {
      left: sideReport(bounds.left, cx),
      far: sideReport(bounds.far, cz),
      right: sideReport(bounds.right, cx),
      behind: sideReport(bounds.behind, cz),
    },
    dimensions,
    planes: { used, ignored },
    objects: things?.report ?? null,
    materials: book.report(),
    lighting: light.report,
    relationships: { rulesVersion: RELATION_RULES.version, count: relationships.length },
    problems,
  };

  checkInvariants(scene);
  return { ok: true, scene, evidence, report };
}

// ---------------------------------------------------------------------------

/**
 * The walls' Manhattan direction, in (−45°, 45°], or null when there are no
 * walls. Seeded by the largest wall, then averaged (area-weighted, modulo
 * 90°) over the walls within snapping distance of it, so a wall that does not
 * fit a rectangular room cannot turn the rest.
 */
function manhattanYaw(walls: readonly PlaneObservation[]): number | null {
  if (!walls.length) return null;
  const quarter = (w: PlaneObservation) => 4 * Math.atan2(w.normal[2], w.normal[0]);
  const seed = walls.reduce((a, b) => (b.visibleArea > a.visibleArea ? b : a));
  let sin = 0;
  let cos = 0;
  for (const w of walls) {
    const gap = Math.abs(Math.atan2(Math.sin(quarter(w) - quarter(seed)), Math.cos(quarter(w) - quarter(seed)))) / 4;
    if (gap * DEG > PRIORS.axisSnapDeg) continue;
    sin += w.visibleArea * Math.sin(quarter(w));
    cos += w.visibleArea * Math.cos(quarter(w));
  }
  return (Math.atan2(sin, cos) * DEG) / 4;
}

/**
 * The point the workspace orbits: where the principal ray leaves the room,
 * kept inside it by the inset, so orbiting pivots on the room rather than
 * on empty space and the workspace camera never has to move it.
 */
function orbitTarget(camera: Vec3, forward: Vec3, [x0, x1, z0, z1, h]: readonly number[]): Vec3 {
  const inset = Math.min(PRIORS.targetInset, (x1 - x0) / 4, (z1 - z0) / 4, h / 4);
  const lo: Vec3 = [x0 + inset, inset, z0 + inset];
  const hi: Vec3 = [x1 - inset, h - inset, z1 - inset];
  let tExit = Infinity;
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(forward[i]) < 1e-9) continue;
    const t = ((forward[i] > 0 ? hi[i] : lo[i]) - camera[i]) / forward[i];
    if (t > 0) tExit = Math.min(tExit, t);
  }
  const t = Number.isFinite(tExit) ? Math.max(tExit, 0.5) : 1;
  const at = (i: number) => Math.min(hi[i], Math.max(lo[i], camera[i] + forward[i] * t));
  return [at(0), at(1), at(2)];
}

const ORDER: readonly Basis[] = ["measured", "calibrated", "estimated", "inferred", "default"];
const weakest = (a: Basis, b: Basis): Basis => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

function q<T>(value: T, basis: Basis, sources: readonly string[], note?: string): Quantity<T> {
  return { value, basis, sigma: null, interval: null, confidence: null, sources, ...(note ? { note } : {}) };
}

function problem(code: string, message: string, severity: Problem["severity"], detail?: Record<string, unknown>): Problem {
  return { code, stage: "compile", severity, message, ...(detail ? { detail } : {}) };
}

function sources(input: ReconstructionIntermediate) {
  const named = (role: string) => {
    const m = input.pipeline.models.find((x) => x.role === role);
    return m ? `${m.id}@${m.weights.revision.slice(0, 7)}` : role;
  };
  return { geometry: named("geometry"), camera: named("camera"), detection: named("detection"), segmentation: named("segmentation"), material: named("material") };
}

/** A surface that was seen: its presence is estimated from pixels, its lengths carry the scale's basis. */
function surfaceEvidence(plane: PlaneObservation, s: number, basis: Basis, note: string): EntityEvidence {
  return {
    kind: "surface",
    presence: { basis: "estimated" },
    fields: {
      visibleArea: q(round(plane.visibleArea * s * s, 0.01), basis, [`plane:${plane.id}`]),
      rmsResidual: q(round(plane.rmsResidual * s, 0.0001), basis, [`plane:${plane.id}`], "metres, RMS distance of the fitted pixels from the plane"),
    },
    observations: [plane.id],
    notes: [note, `${plane.inliers.toLocaleString("en-GB")} pixels fitted.`],
  };
}

function sideReport(b: { position: number; status: "observed" | "inferred" | "omitted"; basis: Basis; planeId: string | null }, centre: number) {
  return { status: b.status, planeId: b.planeId, position: round(b.position - centre), basis: b.basis };
}

/** Violations are compiler bugs, not bad photographs: they fail loudly. */
function checkInvariants(scene: Scene) {
  const ids = [...scene.surfaces, ...scene.materials, ...scene.lights].map((e) => e.id);
  if (new Set(ids).size !== ids.length) throw new Error("SceneCompiler: duplicate ids");
  const materials = new Set(scene.materials.map((m) => m.id));
  for (const surface of scene.surfaces) {
    if (!materials.has(surface.materialId)) throw new Error(`SceneCompiler: ${surface.id} has no material`);
  }
  if (!scene.surfaces.some((s) => s.kind === "floor")) throw new Error("SceneCompiler: no floor");
  const xs = scene.room.footprint.map((p) => p[0]);
  const zs = scene.room.footprint.map((p) => p[1]);
  const [x, y, z] = scene.camera.position;
  if (!(x > Math.min(...xs) && x < Math.max(...xs) && z > Math.min(...zs) && z < Math.max(...zs) && y > 0 && y < scene.room.height)) {
    throw new Error("SceneCompiler: the camera is outside the room");
  }
  const objectIds = new Set(scene.objects.map((o) => o.id));
  if (objectIds.size !== scene.objects.length) throw new Error("SceneCompiler: duplicate object ids");
  const wallIds = new Set(scene.surfaces.filter((s) => s.kind === "wall").map((s) => s.id));
  const tol = 0.02;
  for (const o of scene.objects) {
    const [ox, , oz] = o.transform.position;
    if (!(ox >= Math.min(...xs) - tol && ox <= Math.max(...xs) + tol && oz >= Math.min(...zs) - tol && oz <= Math.max(...zs) + tol)) {
      throw new Error(`SceneCompiler: ${o.id} is outside the room`);
    }
    for (const id of Object.values(o.materials)) if (!materials.has(id)) throw new Error(`SceneCompiler: ${o.id} uses missing material ${id}`);
    if (o.support.kind === "object" && !objectIds.has(o.support.objectId)) throw new Error(`SceneCompiler: ${o.id} rests on a missing object`);
    if (o.support.kind === "wall" && !wallIds.has(o.support.wallId)) throw new Error(`SceneCompiler: ${o.id} hangs on a missing wall`);
  }
  for (const opening of scene.openings) {
    if (!wallIds.has(opening.wallId)) throw new Error(`SceneCompiler: ${opening.id} is in a missing wall`);
    if (!materials.has(opening.frameMaterialId) || !materials.has(opening.panelMaterialId)) throw new Error(`SceneCompiler: ${opening.id} has no material`);
  }
  for (const light of scene.lights) {
    if (light.kind === "artificial" && !objectIds.has(light.fixtureId)) throw new Error(`SceneCompiler: ${light.id} has no fixture`);
  }
  const entityIds = new Set([...objectIds, ...wallIds, ...scene.openings.map((o) => o.id)]);
  for (const r of scene.relationships) {
    if (!entityIds.has(r.subjectId) || !entityIds.has(r.objectId)) throw new Error(`SceneCompiler: ${r.id} refers to a missing entity`);
  }
}
