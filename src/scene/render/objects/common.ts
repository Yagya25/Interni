import { Group, Mesh, type BufferGeometry, type Material, type MeshStandardMaterial } from "three";
import type { SceneObject } from "@/scene/model/types";
import type { MaterialOptions } from "../materials";
import type { TextureLibrary } from "../textures";

export interface BuildContext {
  object: SceneObject;
  /** Resolve one of the object's material slots to a renderable material. */
  material: (slot: string, options?: MaterialOptions) => MeshStandardMaterial;
  textures: TextureLibrary;
}

/** Builds an object in its local frame: origin at the base centre, front = +Z. */
export type ObjectBuilder = (ctx: BuildContext) => Group;

export function part(
  geometry: BufferGeometry,
  material: Material,
  x = 0,
  y = 0,
  z = 0,
  options: { castShadow?: boolean; rotationY?: number; rotationX?: number; rotationZ?: number } = {},
) {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (options.rotationX) mesh.rotation.x = options.rotationX;
  if (options.rotationY) mesh.rotation.y = options.rotationY;
  if (options.rotationZ) mesh.rotation.z = options.rotationZ;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = true;
  return mesh;
}

export function group(...children: Mesh[]) {
  const g = new Group();
  children.forEach((c) => g.add(c));
  return g;
}
