import {
  BoxGeometry,
  CanvasTexture,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  SRGBColorSpace,
  Shape,
  Vector3,
  type Material,
} from "three";
import { findById, roomBounds, walls as wallsOf, wallFrame } from "@/scene/model/queries";
import type { Id, Opening, Scene, WallSurface } from "@/scene/model/types";
import { block, cylinder, merge, metricUVs } from "./geometry";
import type { MaterialFactory } from "./materials";
import type { InstanceUniforms } from "./shading";

export interface WallPart {
  id: Id;
  group: Group;
  inward: Vector3;
}

export interface OpeningPart {
  id: Id;
  kind: Opening["kind"];
  group: Group;
  inward: Vector3;
  /** World-space centre of the opening on the interior wall face. */
  center: Vector3;
  width: number;
  height: number;
}

export interface CeilingGhost {
  group: Group;
  fill: MeshBasicMaterial;
  line: LineBasicMaterial;
}

export interface ArchitectureBuild {
  root: Group;
  ceiling: Group;
  /** Ghosted ceiling for the exploded view. Only built for the base variant. */
  ceilingGhost: CeilingGhost | null;
  walls: WallPart[];
  openings: OpeningPart[];
  /** Linework for the structure views. Only built for the base variant. */
  edges: LineSegments[];
  /** Sky seen through each window. Only built for the base variant. */
  backdrops: Mesh[];
  /** Section caps on top of the walls, seen in the cutaway. */
  caps: Mesh[];
  /**
   * The material instance each surface is painted with, one per surface, so
   * an editor can repaint a single wall without touching the others that
   * share its material.
   */
  surfaceMaterials: Map<Id, MeshStandardMaterial>;
}

interface BuildOptions {
  materials: MaterialFactory;
  instance: InstanceUniforms;
  /** Build the variant-independent parts (edges, caps, sky, slab). */
  includeShared: boolean;
  edgeMaterial: LineBasicMaterial;
  capMaterial: MeshBasicMaterial;
}

const EPS = 0.01;

export function buildArchitecture(scene: Scene, options: BuildOptions): ArchitectureBuild {
  const { materials, instance, includeShared } = options;
  const root = new Group();
  root.name = "architecture";
  const bounds = roomBounds(scene);
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[2] - bounds.min[2];
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const height = scene.room.height;

  const surfaceMaterials = new Map<Id, MeshStandardMaterial>();
  const materialFor = (id: Id, sectionCaps = false, underLines = false, surfaceId?: Id) => {
    const source = findById(scene.materials, id);
    if (!source) throw new Error(`Missing material ${id}`);
    const m = materials.create(source, instance, { sectionCaps });
    if (surfaceId) surfaceMaterials.set(surfaceId, m);
    // Walls sit a hair behind their own edge linework.
    if (underLines) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = 1;
      m.polygonOffsetUnits = 1;
    }
    return m;
  };

  // Door hardware is not part of the scene contract; a neutral dark metal.
  const hardware = new MeshStandardMaterial({ color: "#2a2826", metalness: 0.7, roughness: 0.35 });
  const edges: LineSegments[] = [];
  const caps: Mesh[] = [];
  const backdrops: Mesh[] = [];
  const addEdges = (mesh: Mesh, parent: Group, threshold = 25) => {
    if (!includeShared) return;
    const lines = new LineSegments(new EdgesGeometry(mesh.geometry, threshold), options.edgeMaterial);
    lines.position.copy(mesh.position);
    lines.quaternion.copy(mesh.quaternion);
    lines.renderOrder = 2;
    parent.add(lines);
    edges.push(lines);
  };

  // Floor --------------------------------------------------------------------
  const floorSurface = scene.surfaces.find((s) => s.kind === "floor");
  if (floorSurface) {
    const floorGeo = new PlaneGeometry(width, depth).rotateX(-Math.PI / 2).translate(cx, 0, cz);
    const floor = new Mesh(metricUVs(floorGeo), materialFor(floorSurface.materialId, false, false, floorSurface.id));
    floor.receiveShadow = true;
    floor.name = "floor";
    root.add(floor);
    addEdges(floor, root);
  }

  // Ceiling (faces down, so it disappears on its own when seen from above) ---
  const ceiling = new Group();
  ceiling.name = "ceiling";
  const ceilingSurface = scene.surfaces.find((s) => s.kind === "ceiling");
  if (ceilingSurface) {
    const ceilingGeo = new PlaneGeometry(width + 0.3, depth + 0.3)
      .rotateX(Math.PI / 2)
      .translate(cx, height, cz);
    const ceilingMesh = new Mesh(metricUVs(ceilingGeo), materialFor(ceilingSurface.materialId, false, false, ceilingSurface.id));
    ceilingMesh.receiveShadow = true;
    ceilingMesh.castShadow = true;
    ceiling.add(ceilingMesh);
  }
  root.add(ceiling);

  // In the exploded view the lifted ceiling is seen from above, where the
  // real ceiling (facing down) is invisible. Draw it as a ghosted plane.
  let ceilingGhost: CeilingGhost | null = null;
  if (includeShared) {
    const fill = new MeshBasicMaterial({ color: "#f7f5f1", transparent: true, opacity: 0, depthWrite: false });
    const line = new LineBasicMaterial({ color: "#191816", transparent: true, opacity: 0, depthWrite: false });
    const slab = new BoxGeometry(width, 0.1, depth).translate(cx, height + 0.05, cz);
    const group = new Group();
    group.add(new Mesh(slab, fill), new LineSegments(new EdgesGeometry(slab), line));
    group.visible = false;
    ceiling.add(group);
    ceilingGhost = { group, fill, line };
  }

  // Walls ----------------------------------------------------------------------
  const allWalls = wallsOf(scene);
  const wallParts: WallPart[] = [];
  const openingParts: OpeningPart[] = [];

  const up = new Vector3(0, 1, 0);
  for (const wall of allWalls) {
    const frame = wallFrame(scene, wall);
    const inward = new Vector3(frame.inward[0], 0, frame.inward[1]);
    // Local frame: +X along the wall, +Y up, +Z into the room. If the wall is
    // wound the other way, walk it from its end so the frame stays right-handed.
    let dir = new Vector3(frame.direction[0], 0, frame.direction[1]);
    let origin = wall.start;
    let far = wall.end;
    const flipped = dir.clone().cross(up).dot(inward) < 0;
    if (flipped) {
      dir = dir.negate();
      origin = wall.end;
      far = wall.start;
    }
    const basis = new Matrix4().makeBasis(dir, up, inward);

    const group = new Group();
    group.name = `wall:${wall.id}`;
    group.position.set(origin[0], 0, origin[1]);
    group.quaternion.setFromRotationMatrix(basis);
    root.add(group);

    const extendStart = meetsAnotherWall(allWalls, wall, origin) ? wall.thickness : 0;
    const extendEnd = meetsAnotherWall(allWalls, wall, far) ? wall.thickness : 0;
    const wallOpenings = scene.openings
      .filter((o) => o.wallId === wall.id)
      .map((o) => (flipped ? { ...o, offset: frame.length - o.offset } : o));

    const wallMesh = new Mesh(
      wallGeometry(frame.length, height, wall.thickness, extendStart, extendEnd, wallOpenings),
      materialFor(wall.materialId, true, true, wall.id),
    );
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    group.add(wallMesh);
    addEdges(wallMesh, group);

    if (includeShared) {
      const cap = new Mesh(
        new BoxGeometry(frame.length + extendStart + extendEnd, 0.004, wall.thickness),
        options.capMaterial,
      );
      cap.position.set((frame.length + extendEnd - extendStart) / 2, height + 0.002, -wall.thickness / 2);
      group.add(cap);
      caps.push(cap);
    }
    wallParts.push({ id: wall.id, group, inward });

    for (const opening of wallOpenings) {
      const openingGroup = new Group();
      openingGroup.name = `opening:${opening.id}`;
      openingGroup.position.copy(group.position);
      openingGroup.quaternion.copy(group.quaternion);
      root.add(openingGroup);

      const frameMat = materialFor(opening.frameMaterialId, true);
      const panelMat = materialFor(opening.panelMaterialId, opening.kind === "door");
      if (opening.kind === "window") {
        buildWindow(openingGroup, opening, wall.thickness, frameMat, panelMat);
        if (includeShared) backdrops.push(buildBackdrop(openingGroup, opening, wall.thickness));
      } else {
        buildDoor(openingGroup, opening, wall.thickness, frameMat, panelMat, hardware);
      }

      const center = new Vector3(opening.offset, opening.sill + opening.height / 2, 0).applyMatrix4(
        new Matrix4().compose(group.position, group.quaternion, new Vector3(1, 1, 1)),
      );
      openingParts.push({
        id: opening.id,
        kind: opening.kind,
        group: openingGroup,
        inward,
        center,
        width: opening.width,
        height: opening.height,
      });
    }
  }

  // Slab under the floor, drawn as a solid in the cutaway ---------------------
  if (includeShared) {
    const t = Math.max(...allWalls.map((w) => w.thickness), 0);
    const slab = new Mesh(
      new BoxGeometry(width + t * 2, 0.22, depth + t),
      new MeshStandardMaterial({ color: "#cfc8bc", roughness: 1 }),
    );
    // Top face well clear of the floor so they can never fight for depth.
    slab.position.set(cx, -0.11 - 0.02, cz - t / 2);
    slab.receiveShadow = true;
    root.add(slab);
  }

  return { root, ceiling, ceilingGhost, walls: wallParts, openings: openingParts, edges, backdrops, caps, surfaceMaterials };
}

function meetsAnotherWall(all: WallSurface[], wall: WallSurface, point: readonly [number, number]) {
  return all.some(
    (other) =>
      other.id !== wall.id &&
      [other.start, other.end].some((p) => Math.hypot(p[0] - point[0], p[1] - point[1]) < EPS),
  );
}

/** Wall elevation with openings cut out, extruded outwards from the room face. */
function wallGeometry(
  length: number,
  height: number,
  thickness: number,
  extendStart: number,
  extendEnd: number,
  openings: Opening[],
) {
  const doors = openings.filter((o) => o.sill <= EPS).sort((a, b) => a.offset - b.offset);
  const windows = openings.filter((o) => o.sill > EPS);

  const shape = new Shape();
  shape.moveTo(-extendStart, 0);
  // Doors notch the outline; windows become holes.
  for (const door of doors) {
    const l = door.offset - door.width / 2;
    const r = door.offset + door.width / 2;
    shape.lineTo(l, 0);
    shape.lineTo(l, door.height);
    shape.lineTo(r, door.height);
    shape.lineTo(r, 0);
  }
  shape.lineTo(length + extendEnd, 0);
  shape.lineTo(length + extendEnd, height);
  shape.lineTo(-extendStart, height);
  shape.closePath();

  for (const w of windows) {
    const hole = new Path();
    const l = w.offset - w.width / 2;
    const r = w.offset + w.width / 2;
    hole.moveTo(l, w.sill);
    hole.lineTo(l, w.sill + w.height);
    hole.lineTo(r, w.sill + w.height);
    hole.lineTo(r, w.sill);
    hole.closePath();
    shape.holes.push(hole);
  }

  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geometry.translate(0, 0, -thickness);
  return metricUVs(geometry);
}

function buildWindow(
  group: Group,
  opening: Opening,
  thickness: number,
  frameMat: Material,
  glassMat: Material,
) {
  const { offset, width: w, height: h, sill } = opening;
  const member = 0.055;
  const mullion = 0.04;
  const z = -thickness * 0.45;
  const bars = [
    // jambs, head, sill
    block(member, h, member, 0.004, 1).translate(offset - w / 2 + member / 2, sill, z),
    block(member, h, member, 0.004, 1).translate(offset + w / 2 - member / 2, sill, z),
    block(w, member, member, 0.004, 1).translate(offset, sill + h - member, z),
    block(w, member, member, 0.004, 1).translate(offset, sill, z),
    // central mullion and two transoms: two casements of three lights
    block(mullion, h, mullion, 0.004, 1).translate(offset, sill, z),
    block(w, mullion * 0.7, mullion * 0.8, 0.004, 1).translate(offset, sill + h * 0.34, z),
    block(w, mullion * 0.7, mullion * 0.8, 0.004, 1).translate(offset, sill + h * 0.67, z),
    // interior sill board
    block(w + 0.12, 0.03, thickness * 0.55 + 0.05, 0.004, 1).translate(offset, sill - 0.03, -thickness * 0.2 + 0.03),
  ];
  const frame = new Mesh(merge(bars), frameMat);
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);

  const glass = new Mesh(new PlaneGeometry(w - member, h - member).translate(offset, sill + h / 2, z), glassMat);
  glass.castShadow = false;
  glass.receiveShadow = false;
  glass.renderOrder = 1;
  group.add(glass);
}

function buildDoor(
  group: Group,
  opening: Opening,
  thickness: number,
  frameMat: Material,
  leafMat: Material,
  hardwareMat: Material,
) {
  const { offset, width: w, height: h } = opening;
  const casing = 0.07;
  const trim = merge([
    block(casing, h + casing, 0.018, 0.003, 1).translate(offset - w / 2 - casing / 2, 0, 0.009),
    block(casing, h + casing, 0.018, 0.003, 1).translate(offset + w / 2 + casing / 2, 0, 0.009),
    block(w + casing * 2, casing, 0.018, 0.003, 1).translate(offset, h, 0.009),
  ]);
  const trimMesh = new Mesh(trim, frameMat);
  trimMesh.castShadow = true;
  trimMesh.receiveShadow = true;
  group.add(trimMesh);

  const leafGeo = merge([
    block(w - 0.01, h - 0.008, 0.04, 0.004, 1),
    // two shallow raised panels
    block(w - 0.24, h * 0.36, 0.012, 0.006, 1).translate(0, h * 0.08, 0.022),
    block(w - 0.24, h * 0.36, 0.012, 0.006, 1).translate(0, h * 0.52, 0.022),
  ]).translate(offset, 0, -thickness * 0.3);
  const leaf = new Mesh(leafGeo, leafMat);
  leaf.castShadow = true;
  leaf.receiveShadow = true;
  group.add(leaf);

  const handle = new Mesh(
    merge([
      cylinder(0.025, 0.025, 0.012, 20).rotateX(Math.PI / 2),
      block(0.12, 0.018, 0.018, 0.008, 2).translate(-0.05, -0.009, 0.03),
    ]).translate(offset + w / 2 - 0.09, 1.02, -thickness * 0.3 + 0.03),
    hardwareMat,
  );
  group.add(handle);
}

let skyTexture: CanvasTexture | null = null;

/** A soft, overexposed exterior: sky, haze, a band of distant trees. */
function sky() {
  if (skyTexture) return skyTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#e9eef1");
  g.addColorStop(0.55, "#f7f5f0");
  g.addColorStop(0.62, "#c9cdbf");
  g.addColorStop(0.72, "#a9ae9c");
  g.addColorStop(1, "#d9d6cc");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 256);
  skyTexture = new CanvasTexture(canvas);
  skyTexture.colorSpace = SRGBColorSpace;
  return skyTexture;
}

function buildBackdrop(group: Group, opening: Opening, thickness: number) {
  const { offset, width: w, height: h, sill } = opening;
  const material = new MeshBasicMaterial({
    map: sky(),
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
  });
  const backdrop = new Mesh(new PlaneGeometry(w + 2.4, h + 1.8), material);
  backdrop.position.set(offset, sill + h / 2 + 0.2, -thickness - 1.1);
  backdrop.castShadow = false;
  backdrop.receiveShadow = false;
  backdrop.renderOrder = -1;
  group.add(backdrop);
  return backdrop;
}
